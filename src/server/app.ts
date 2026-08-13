import express from 'express'
import { randomUUID } from 'node:crypto'
import { getUiCapability, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type Database from 'better-sqlite3'
import type { Config } from '../config.js'
import { IdentityStore } from '../store/identityStore.js'
import { CredentialStore } from '../store/credentialStore.js'
import { ReadOidStore } from '../store/readOidStore.js'
import { TokenManager } from '../auth/tokenManager.js'
import { AuthServiceClient } from '../auth/authServiceClient.js'
import { GatewayClient } from '../gateway/client.js'
import { AuditLog } from '../audit/auditLog.js'
import { RateBudget } from '../limits/rateBudget.js'
import { AppRateBudget } from '../limits/appRateBudget.js'
import { ChangeSetStore } from '../changeset/store.js'
import { ApprovalNonceStore } from '../changeset/approvalNonce.js'
import { WebSessionStore } from './webSessionStore.js'
import { requestContext } from './requestContext.js'
import { wrapTool, wrapL2Tool, type PipelineDeps, type L2PipelineDeps } from './toolPipeline.js'
import { wrapAppTool, type AppPipelineDeps } from './appPipeline.js'
import { buildConfirmRouter } from './confirmRoutes.js'
import { buildSsoRouter } from './ssoRoutes.js'
import { registerAppResources } from './appResources.js'
import { findProductsTool } from '../tools/findProducts.js'
import { productPlansTool } from '../tools/productPlans.js'
import { inventorySettingsTool } from '../tools/inventorySettings.js'
import { createChangesetTool, getChangesetStatusTool } from '../changeset/tools.js'
import { APP_TOOLS } from '../tools/appTools.js'
import type { ToolDef } from '../tools/types.js'
import type { L2ToolDef } from './l2Context.js'
import { AppError } from '../errors.js'

export interface ServerDeps { config: Config; db: Database.Database }

// host 在 initialize 的 capabilities.extensions 宣告 MCP Apps 支援才回 true。
// 用途：capability-gate —— 只對支援 Apps 的 host 註冊 app-only tools（否則非 Apps host
// 的 agent 連工具存在都看不到）。getUiCapability 回 undefined 代表不支援。
export function hostSupportsApps(caps: unknown): boolean {
  const ui = getUiCapability(caps as never)
  return !!ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE)
}

const TOOLS: ToolDef[] = [findProductsTool as ToolDef, productPlansTool as ToolDef, inventorySettingsTool as ToolDef]
const L2_TOOLS: L2ToolDef[] = [createChangesetTool, getChangesetStatusTool]

// PLACEHOLDER — Task 1's SIT write-contract probe (docs/be2-mcp/sit-write-contracts.md #1)
// found the real `modify_user` be2 expects on writes is a distinct be2 userUuid (e.g.
// `24c66807-352e-41da-8a28-53b482ba7f4e`) that is NOT any claim in the access-token JWT —
// resolving it requires an auth-service call (candidate: verify response, or
// `auth/be2/token/sub-user`) that is still unconfirmed, and the only SIT account available is
// 403-blocked on shelf-toggle writes so the resolution can't be validated end-to-end yet
// (Task 1 finding #4, BLOCKER). Until that's resolved with a write-capable SIT account, this
// decodes the JWT and returns `platformId` (right UUID *format*, wrong *value* — it is NOT the
// user's be2 userUuid) purely so the executor has a syntactically valid string to send. DO NOT
// treat this as correct; wire the real resolver before any live write path is used.
// Fix 4: THROW by default instead of silently returning a wrong value. Writes are 403-blocked on
// SIT right now anyway (no write-capable account, see Task 1), so this can only ever fire in a
// dev/test context — but if a write-capable account is enrolled later without the real userUuid
// resolver wired in, this turns "silently attribute the write to the wrong be2 user" into a loud,
// documented failure instead. executeChangeSet (src/changeset/executor.ts) already has a
// stuck-state guard around the call site (modifyUserFrom is invoked inside the same try block as
// getFreshByHash, right after it) that catches this throw, marks the change-set 'failed' (not
// stuck in 'executing'), audits it, and rethrows — see tests/changesetExecutor.test.ts.
export function modifyUserFromPlaceholder(accessToken: string): string {
  if (process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER !== '1') {
    throw new AppError(
      'MODIFY_USER_UNRESOLVED',
      'modify_user resolver not wired (see docs/be2-mcp/sit-write-contracts.md); set BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER=1 to allow the dev placeholder',
      500,
    )
  }
  const parts = accessToken.split('.')
  if (parts.length !== 3) return 'unknown'
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { platformId?: string }
    return payload.platformId ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function buildApp({ config, db }: ServerDeps): express.Express {
  // Task 5：identities/credentials 直接對映 db 兩張表（無內部狀態的薄包裝），不再經
  // TokenStore 扁平相容 adapter——該 adapter 已隨 Task 1-4 的呼叫端遷移完畢，此任務刪除。
  const identities = new IdentityStore(db)
  const credentials = new CredentialStore(db)
  // 一個 credential 被砍時：若同 identity 已無任何其他 credential 引用，一併砍掉 identity；
  // 否則保留（同一 identity 常見同時掛 static_bearer + web_session 兩個 credential 並存）。
  // 供下方 WebSessionStore 的 onDelete 使用（session 登出/idle-expiry/dead-session 皆需回收
  // 它所擁有的 be2 token，見 Fix 2）。
  function purgeCredential(hash: string): void {
    const cred = credentials.get(hash)
    if (!cred) return
    credentials.delete(hash)
    if (credentials.countByIdentity(cred.identityId) === 0) identities.delete(cred.identityId)
  }
  // Shared across the tool pipeline (TokenManager) and the SSO router (Task 6): both need to
  // exchange/refresh be2 tokens against the same auth-service client, and reusing one instance
  // avoids duplicate config parsing / connection setup.
  const authServiceClient = new AuthServiceClient({ baseUrl: config.authsvcUrl, serviceKey: config.serviceKey })
  // Task 2: TokenManager 直接操作 identity 層（be2 refresh 只在 identity 這格 rotate 一次，
  // 多個 credential 共用同一 identity 時不會互撞）。
  const tokenManager = new TokenManager({ identities, credentials }, authServiceClient)
  const rateBudget = new RateBudget(db)
  const audit = new AuditLog(db)
  const gateway = new GatewayClient({ baseUrl: config.gatewayUrl })
  const readOids = new ReadOidStore(db)
  const changeSets = new ChangeSetStore(db)
  // Phase 2b: session-cookie auth (SSO) for the confirm page replaces the Phase 2a capability
  // token. webSessions is shared between the SSO router (creates sessions on login) and the
  // confirm router (reads sessions to authorize approve/reject).
  // Fix 2 (whole-branch review): every web-session removal (logout, dead-session, idle-expiry —
  // all three funnel through WebSessionStore#delete) must also purge the be2 access+refresh
  // token that session owns (the credential keyed by hash(sessionId), minted 'web_session' by
  // ssoRoutes.ts) — otherwise the token is orphaned at rest forever with no session left able to
  // reach it. purgeCredential (above) is kind-agnostic and only drops the identity once no
  // credential of ANY kind still references it, so a static_bearer sharing the same identity
  // survives a confirm-page logout.
  const webSessions = new WebSessionStore(db, { onDelete: sid => purgeCredential(CredentialStore.hash(sid)) })
  const authOrigin = new URL(config.authsvcUrl).origin

  const deps: PipelineDeps = { tokenManager, rateBudget, audit, gateway, readOids }
  const l2Deps: L2PipelineDeps = {
    ...deps,
    changeSets,
    baseUrl: `http://127.0.0.1:${config.port}`,
    genId: randomUUID,
    now: Date.now,
    // Fix 1: the confirm_url never reaches the tool response / the model's context — it is
    // printed to the be2-mcp SERVER's own stdout, which only the human running `npm run dev`
    // sees. The agent has no way to read this terminal. Phase 2b moved confirm-page auth to the
    // be2-auth SSO session cookie, so the URL carries no capability token to begin with (the
    // dead `?token=` capability-token surface from Phase 2a — mint, store, and embed — has been
    // removed entirely; confirmRoutes.ts never reads req.query at all).
    emitConfirmUrl: (id, url) => { console.log(`[be2-mcp] change-set ${id} awaiting approval: ${url}`) },
  }

  // 面板輪詢（app-only tools）獨立限流，見 src/limits/appRateBudget.ts 的說明——與 rateBudget
  // (LLM 工具用) 完全分離的 in-memory sliding window。session 關閉時必須 release，見下方
  // onsessionclosed，否則長跑 server 的 hits Map 會無限累積已關閉的 session。
  const appRateBudget = new AppRateBudget()
  const appDeps: AppPipelineDeps = {
    tokenManager, appRateBudget, audit, gateway, changeSets,
    nonces: new ApprovalNonceStore(),
    now: Date.now, genId: randomUUID,
    baseUrl: `http://127.0.0.1:${config.port}`,
    modifyUserFrom: modifyUserFromPlaceholder,
  }

  const transports = new Map<string, StreamableHTTPServerTransport>()
  // Binds a session-id to the IDENTITY the creating bearer resolved to (spec §6.2) — not to the
  // bearer's own credential hash. Task 5: this is what lets an OAuth reference token rotate
  // (Phase B) without severing an in-flight MCP session — a rotated token mints a NEW credential
  // row but keeps pointing at the SAME identity_id, so the owner check below still matches. It
  // still prevents an unrelated bearer B from reusing bearer A's mcp-session-id to piggyback on
  // A's session state (read_oids, rate budget) while acting — and being audited — as A, since a
  // different identity always yields a different value here.
  const sessionOwner = new Map<string, string>()

  // caps = client 在 initialize 宣告的 capabilities（見 /mcp handler 的 initCaps）。只對支援 MCP
  // Apps 的 host（hostSupportsApps）且該 tool 掛了 uiResourceUri（Task 3）才走 registerAppTool
  // 帶面板；否則維持既有 registerTool 純文字路徑。Task 6 起 findProducts/productPlans/
  // inventorySettings/createChangeset/getChangesetStatus 皆掛了 uiResourceUri，故此分支對支援
  // Apps 的 host 已會實際觸發（見 tests/serverIntegration.test.ts 的 real-path 整合測試）。
  function newServer(caps: unknown): McpServer {
    const server = new McpServer({ name: 'be2-mcp', version: '0.1.0' })
    const appsOk = hostSupportsApps(caps)
    for (const tool of TOOLS) {
      if (tool.uiResourceUri && appsOk) {
        registerAppTool(server, tool.name, {
          description: tool.description, inputSchema: tool.inputShape,
          ...(tool.outputShape ? { outputSchema: tool.outputShape } : {}),
          _meta: { ui: { resourceUri: tool.uiResourceUri } },
        }, wrapTool(tool, deps) as never)
      } else {
        server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputShape },
          wrapTool(tool, deps) as never)
      }
    }
    for (const tool of L2_TOOLS) {
      if (tool.uiResourceUri && appsOk) {
        registerAppTool(server, tool.name, {
          description: tool.description, inputSchema: tool.inputShape,
          ...(tool.outputShape ? { outputSchema: tool.outputShape } : {}),
          _meta: { ui: { resourceUri: tool.uiResourceUri } },
        }, wrapL2Tool(tool, l2Deps) as never)
      } else {
        server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputShape },
          wrapL2Tool(tool, l2Deps) as never)
      }
    }
    // app-only（面板專用）工具：僅在 host 支援 MCP Apps 時註冊，且 visibility:['app'] 表明不
    // 給 model 用——非 Apps host 的 agent 連工具存在都看不到（capability-gate 已把關，這裡的
    // visibility 只是對支援 Apps 的 host 表明「這是面板用的、別餵給 LLM」的雙重保險）。
    if (appsOk) {
      for (const t of APP_TOOLS) {
        registerAppTool(server, t.name, {
          description: t.description, inputSchema: t.inputShape as never,
          _meta: { ui: { visibility: ['app'] } },
        }, wrapAppTool(t, appDeps) as never)
      }
    }
    // 面板永遠是增強層：dist/ui 缺檔時 registerAppResources 內部 warn+略過，不影響上面的工具註冊。
    if (appsOk) registerAppResources(server)
    return server
  }

  const app = express()
  app.use(express.json())
  app.get('/healthz', (_req, res) => { res.status(200).send('ok') })
  // CRITICAL route order (agy T4 finding): buildSsoRouter registers GET /confirm/login (+ POST
  // /confirm/session, /confirm/logout); buildConfirmRouter registers GET /confirm/:id. Express
  // matches routes in registration order, not by specificity — if the confirm router mounted
  // first, /confirm/:id would swallow /confirm/login (treating "login" as a change-set id) and
  // the login page would be unreachable. The SSO router MUST be mounted first.
  app.use(buildSsoRouter({ authServiceClient, identities, credentials, webSessions, authOrigin, now: Date.now }))
  app.use(buildConfirmRouter({
    // Task 5: requireSession's credential-kind gate needs the same CredentialStore instance the
    // SSO router mints web_session credentials into — the shared `credentials` above (no
    // TokenStore adapter layer to route through anymore).
    changeSets, gateway, tokenManager, audit, webSessions, credentials,
    modifyUserFrom: modifyUserFromPlaceholder,
    now: Date.now,
  }))

  app.all('/mcp', (req, res) => {
    void (async () => {
      // Fast bearer gate: known-credential check only (NO refresh here — pipeline refreshes per
      // tool call). Task 5: looks up the credential directly (OAuth reference token and Phase 1a
      // static bearer both resolve here — CredentialStore doesn't distinguish them by shape).
      const auth = req.header('authorization') ?? ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      const cred = bearer ? credentials.getBySecret(bearer) : undefined
      if (!cred) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'unknown or missing bearer — run bootstrap-user' } })
        return
      }

      const sessionId = req.header('mcp-session-id')
      let transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        if (req.method !== 'POST') { res.status(400).json({ error: { code: 'NO_SESSION', message: 'unknown mcp session' } }); return }
        // 新 session 一律由 initialize POST 建立，client capabilities 在此請求 body 的
        // params.capabilities（非 batch 陣列時）；防禦性處理 batch 陣列型式（本 SDK 目前
        // initialize 不走 batch，但這樣寫零成本且嚴格合規）。
        const initCaps: unknown = Array.isArray(req.body)
          ? (req.body as Array<{ method?: string; params?: { capabilities?: unknown } }>)
              .find(m => m?.method === 'initialize')?.params?.capabilities
          : req.body?.method === 'initialize' ? req.body?.params?.capabilities : undefined
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: id => { transports.set(id, transport!); sessionOwner.set(id, cred.identityId) },
          onsessionclosed: id => { transports.delete(id); sessionOwner.delete(id); appRateBudget.release(id) },
        })
        await newServer(initCaps).connect(transport)
      } else if (sessionOwner.get(sessionId!) !== cred.identityId) {
        res.status(403).json({ error: { code: 'SESSION_OWNER_MISMATCH', message: 'session does not belong to this bearer' } })
        return
      }

      const ctx = {
        bearer,
        sessionId: transport.sessionId ?? 'pre-init',
        clientInfo: (req.header('user-agent') ?? 'unknown').slice(0, 120),
      }
      await requestContext.run(ctx, () => transport!.handleRequest(req, res, req.body))
    })().catch(err => {
      if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } })
      console.error('mcp request failed:', (err as Error).message)
    })
  })

  return app
}
