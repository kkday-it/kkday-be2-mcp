import express from 'express'
import { randomUUID, randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type Database from 'better-sqlite3'
import type { Config } from '../config.js'
import { TokenStore } from '../store/tokenStore.js'
import { ReadOidStore } from '../store/readOidStore.js'
import { TokenManager } from '../auth/tokenManager.js'
import { AuthServiceClient } from '../auth/authServiceClient.js'
import { GatewayClient } from '../gateway/client.js'
import { AuditLog } from '../audit/auditLog.js'
import { RateBudget } from '../limits/rateBudget.js'
import { ChangeSetStore } from '../changeset/store.js'
import { WebSessionStore } from './webSessionStore.js'
import { requestContext } from './requestContext.js'
import { wrapTool, wrapL2Tool, type PipelineDeps, type L2PipelineDeps } from './toolPipeline.js'
import { buildConfirmRouter } from './confirmRoutes.js'
import { buildSsoRouter } from './ssoRoutes.js'
import { findProductsTool } from '../tools/findProducts.js'
import { productPlansTool } from '../tools/productPlans.js'
import { inventorySettingsTool } from '../tools/inventorySettings.js'
import { createChangesetTool, getChangesetStatusTool } from '../changeset/tools.js'
import type { ToolDef } from '../tools/types.js'
import type { L2ToolDef } from './l2Context.js'
import { AppError } from '../errors.js'

export interface ServerDeps { config: Config; db: Database.Database }

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
  const store = new TokenStore(db)
  // Shared across the tool pipeline (TokenManager) and the SSO router (Task 6): both need to
  // exchange/refresh be2 tokens against the same auth-service client, and reusing one instance
  // avoids duplicate config parsing / connection setup.
  const authServiceClient = new AuthServiceClient({ baseUrl: config.authsvcUrl, serviceKey: config.serviceKey })
  const tokenManager = new TokenManager(store, authServiceClient)
  const rateBudget = new RateBudget(db)
  const audit = new AuditLog(db)
  const gateway = new GatewayClient({ baseUrl: config.gatewayUrl })
  const readOids = new ReadOidStore(db)
  const changeSets = new ChangeSetStore(db)
  // Phase 2b: session-cookie auth (SSO) for the confirm page replaces the Phase 2a capability
  // token. webSessions is shared between the SSO router (creates sessions on login) and the
  // confirm router (reads sessions to authorize approve/reject).
  const webSessions = new WebSessionStore(db)
  const authOrigin = new URL(config.authsvcUrl).origin

  const deps: PipelineDeps = { tokenManager, rateBudget, audit, gateway, readOids }
  const l2Deps: L2PipelineDeps = {
    ...deps,
    changeSets,
    baseUrl: `http://127.0.0.1:${config.port}`,
    genId: randomUUID,
    genToken: () => randomBytes(24).toString('hex'),
    now: Date.now,
    // Fix 1: the confirm_url (embedding the raw one-time approval token) never reaches the tool
    // response / the model's context — it is printed to the be2-mcp SERVER's own stdout, which
    // only the human running `npm run dev` sees. The agent has no way to read this terminal.
    emitConfirmUrl: (id, url) => { console.log(`[be2-mcp] change-set ${id} awaiting approval: ${url}`) },
  }

  const transports = new Map<string, StreamableHTTPServerTransport>()
  // Binds a session-id to the bearer that created it (spec §6.2): prevents an enrolled
  // bearer B from reusing bearer A's mcp-session-id to piggyback on A's session state
  // (read_oids, rate budget) while acting — and being audited — as A.
  const sessionOwner = new Map<string, string>()

  function newServer(): McpServer {
    const server = new McpServer({ name: 'be2-mcp', version: '0.1.0' })
    for (const tool of TOOLS) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputShape },
        wrapTool(tool, deps) as never)
    }
    for (const tool of L2_TOOLS) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputShape },
        wrapL2Tool(tool, l2Deps) as never)
    }
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
  app.use(buildSsoRouter({ authServiceClient, tokenStore: store, webSessions, authOrigin, now: Date.now }))
  app.use(buildConfirmRouter({
    changeSets, gateway, tokenManager, audit, webSessions,
    modifyUserFrom: modifyUserFromPlaceholder,
    now: Date.now,
  }))

  app.all('/mcp', (req, res) => {
    void (async () => {
      // Fast bearer gate: known-bearer check only (NO refresh here — pipeline refreshes per tool call).
      const auth = req.header('authorization') ?? ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (!bearer || !store.getByBearer(bearer)) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'unknown or missing bearer — run bootstrap-user' } })
        return
      }

      const sessionId = req.header('mcp-session-id')
      let transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        if (req.method !== 'POST') { res.status(400).json({ error: { code: 'NO_SESSION', message: 'unknown mcp session' } }); return }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: id => { transports.set(id, transport!); sessionOwner.set(id, TokenStore.hashBearer(bearer)) },
          onsessionclosed: id => { transports.delete(id); sessionOwner.delete(id) },
        })
        await newServer().connect(transport)
      } else if (sessionOwner.get(sessionId!) !== TokenStore.hashBearer(bearer)) {
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
