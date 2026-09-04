import { trace, SpanStatusCode } from '@opentelemetry/api'
import { ensureTraceId } from '../otel.js'
import { requestContext } from './requestContext.js'
import type { TokenManager } from '../auth/tokenManager.js'
import type { AuditLog } from '../audit/auditLog.js'
import type { GatewayClient } from '../gateway/client.js'
import type { ReadOidStore } from '../store/readOidStore.js'
import type { RateBudget } from '../limits/rateBudget.js'
import type { ChangeSetStore } from '../core/changeset/store.js'
import type { ApprovalNonceStore } from '../core/changeset/approvalNonce.js'
import type { AppRateBudget } from '../limits/appRateBudget.js'
import { CredentialStore } from '../store/credentialStore.js'
import type { Envelope } from '../tools/envelope.js'
import type { ToolAnnotations } from '../tools/types.js'
import { AppError, AuthError, RateError } from '../errors.js'
import { approveAndExecute as approveAndExecuteService, type ApproveParams, type ApproveResult } from '../core/changeset/confirmService.js'

// app-only（面板專用）工具的執行環境：與 L2ToolContext 同源身分資訊（sessionId/bearerHash/
// businessList 皆由 token 推導、絕不接受 input 自報身分），但服務對象是面板輪詢而非 LLM 對話。
export interface AppToolContext {
  gateway: GatewayClient
  accessToken: string
  userLabel: string
  sessionId: string
  bearerHash: string
  businessList: unknown[]
  // Task 5/6: same §6.2 scope-binding substrate the L0/L2 tools share (readOids) plus the two
  // independent budget counters RateBudget owns (session/day READ window via .consume(), and the
  // per-user-day CHANGE-SET window via .consumeChangeset()). Added for app_get_batch_view (reads)
  // and app_create_changeset (change-set creation), which must register/count against the SAME
  // substrate an equivalent L0/L2 tool call would. This is DISTINCT from appRateBudget below (the
  // panel-polling sliding window, consumed unconditionally by wrapAppTool itself for every app
  // tool call). The app pipeline shell deliberately does NOT force-count any RateBudget counter —
  // only appRateBudget is shell-enforced; a tool that does a real gateway read must call
  // ctx.rateBudget.consume() itself (app_get_batch_view), and a tool that stages a change-set
  // gets ctx.rateBudget.consumeChangeset() "for free" only because it calls into
  // src/changeset/tools.ts#createChangesetCore, which calls it internally — app_create_changeset
  // must NOT also call ctx.rateBudget.consume() itself, that would double-charge the unrelated
  // read budget for a call that does no standalone gateway read of its own.
  readOids: ReadOidStore
  rateBudget: RateBudget
  changeSets: ChangeSetStore
  nonces: ApprovalNonceStore
  now: () => number
  genId: () => string
  baseUrl: string // for confirm_url, e.g. http://127.0.0.1:8787
  // Task 11: the shared approve+execute sequence (src/changeset/confirmService.ts), pre-bound to
  // this request's identity by wrapAppTool below. `who` is injected by the closure — never taken
  // from tool input — so an app tool can never approve/execute AS someone other than the caller
  // this session's bearer resolved to.
  approveAndExecute: (p: Omit<ApproveParams, 'who'>) => Promise<ApproveResult>
  // Task 6: same out-of-band delivery contract as L2ToolContext.emitConfirmUrl (src/server/
  // l2Context.ts) — added so app_create_changeset (src/tools/appTools.ts) can call the shared
  // src/changeset/tools.ts#createChangesetCore unmodified. AppToolContext is now a full
  // structural superset of L2ToolContext.
  emitConfirmUrl: (changesetId: string, url: string) => void
  scheduleTz: string
  traceId: string
}

export interface AppToolDef {
  name: string
  description: string
  inputShape: Record<string, unknown>
  annotations?: ToolAnnotations
  handler(args: any, ctx: AppToolContext): Promise<Envelope>
}

export interface AppPipelineDeps {
  tokenManager: TokenManager
  appRateBudget: AppRateBudget
  // Task 5: see AppToolContext.readOids/rateBudget above for why these are separate from
  // appRateBudget — wired here so app.ts can pass the SAME instances the L0/L2 pipeline uses.
  readOids: ReadOidStore
  rateBudget: RateBudget
  audit: AuditLog
  gateway: GatewayClient
  changeSets: ChangeSetStore
  nonces: ApprovalNonceStore
  now: () => number
  genId: () => string
  baseUrl: string
  // Task 6: same instance app.ts wires into l2Deps.emitConfirmUrl — both entry points into
  // createChangesetCore (be2_create_changeset and app_create_changeset) must deliver the
  // confirm_url out-of-band identically.
  emitConfirmUrl: (changesetId: string, url: string) => void
  // Same lazy-resolver contract as confirmRoutes.ts's ConfirmDeps.modifyUserFrom (src/server/
  // app.ts's modifyUserFromPlaceholder) — only ever invoked LAZILY inside approveAndExecute, never
  // here at pipeline-construction/request time.
  modifyUserFrom: (accessToken: string) => string
  scheduleTz: string
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }
const errResult = (code: string, message: string): ToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }], isError: true })

// 鏡射 toolPipeline.ts 的 runWrapped：span → getFreshAccessToken → rate-consume → handler →
// 雙軌 result → audit。唯一實質差異是限流走 appRateBudget（獨立滑動窗），不碰既有 RateBudget
// ——面板每 3s 輪詢會迅速燒光 LLM 那份 100/session 預算，兩者必須分離。
export function wrapAppTool(tool: AppToolDef, deps: AppPipelineDeps) {
  const tracer = trace.getTracer('be2-mcp')
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const reqCtx = requestContext.getStore()
    if (!reqCtx) return errResult('NO_AUTH_CONTEXT', 'missing request auth context')
    return tracer.startActiveSpan(`mcp.apptool/${tool.name}`, async span => {
      const started = Date.now(); const traceId = ensureTraceId(span.spanContext().traceId)
      span.setAttribute('mcp.apptool', tool.name); span.setAttribute('mcp.session_id', reqCtx.sessionId)
      let userLabel = 'unknown'
      let status: 'ok' | 'error' | 'denied_rate' | 'denied_auth' = 'ok'
      let result: ToolResult; let message: string | undefined
      try {
        const user = await deps.tokenManager.getFreshAccessToken(reqCtx.bearer)
        userLabel = user.userLabel; span.setAttribute('user_id', userLabel)
        deps.appRateBudget.consume(reqCtx.sessionId)   // 獨立限流，不碰 RateBudget
        const envelope = await tool.handler(args, {
          gateway: deps.gateway.withTrace(traceId), traceId, accessToken: user.accessToken, userLabel,
          sessionId: reqCtx.sessionId, bearerHash: CredentialStore.hash(reqCtx.bearer),
          businessList: user.businessList, readOids: deps.readOids, rateBudget: deps.rateBudget,
          changeSets: deps.changeSets, nonces: deps.nonces,
          now: deps.now, genId: deps.genId,
          baseUrl: deps.baseUrl,
          emitConfirmUrl: deps.emitConfirmUrl,
          scheduleTz: deps.scheduleTz,
          // Closure binds THIS request's resolved identity (accessToken/userLabel/sessionId) —
          // never taken from tool args. modifyUser stays unresolved until approveAndExecute needs
          // it (lazy), so read-only app tools (e.g. app_get_changeset_view) never pay the cost of
          // — or fail on — modify_user resolution.
          approveAndExecute: p => approveAndExecuteService(
            { changeSets: deps.changeSets, gateway: deps.gateway, audit: deps.audit, now: deps.now, modifyUserFrom: deps.modifyUserFrom },
            { ...p, who: { accessToken: user.accessToken, userLabel, sessionId: reqCtx.sessionId, identityId: user.identityId, traceId } },
          ),
        })
        // Task 5: mirrors toolPipeline.ts's runWrapped — same substrate, same generic recording —
        // so app_get_batch_view's oids land in the identical session-scoped store
        // be2_create_changeset's SCOPE_NOT_READ gate reads from. Harmless no-op for the other app
        // tools (view/confirm-link/confirm), which never populate envelope.read_oids.
        if (envelope.read_oids.length) await deps.readOids.record(reqCtx.sessionId, envelope.read_oids)
        // Task 6: mirrors toolPipeline.ts's runWrapped exactly (was previously out of sync — see
        // carry-forward from Task 2 review). Fully failed (no items) => audited as error. Items +
        // errors => status stays ok but the first error entry is STILL recorded into audit
        // errorMessage: that's how a spec-§4.3 degraded gate (warn-and-proceed, e.g.
        // ACTION_CODE_UNVERIFIED from app_create_changeset) leaves an audit trace — no separate
        // warning pathway exists, so without this the warning silently never reached audit_log.
        if (envelope.errors.length > 0) {
          const f = envelope.errors[0]; message = f.code ? `${f.code}: ${f.message}` : f.message
          if (envelope.items.length === 0) status = 'error'
        }
        result = { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope as never }
      } catch (e) {
        status = e instanceof RateError ? 'denied_rate' : e instanceof AuthError ? 'denied_auth' : 'error'
        span.recordException(e as Error); span.setStatus({ code: SpanStatusCode.ERROR })
        const code = e instanceof AppError ? e.code : 'INTERNAL'
        message = e instanceof AppError ? e.message : 'internal error in be2-mcp — check server logs'
        if (status === 'error') console.error(`be2-mcp apptool ${tool.name} failed:`, e)
        result = errResult(code, message)
      } finally {
        // 安全衛生：nonce 是一次性批准密碼，即使 verifyAndConsume 已消耗掉、對重放已無用，
        // 仍不該明文留在 audit_log。稽核只記編輯過的副本，handler 收到的 args 不受影響。
        const auditParams = 'nonce' in args ? { ...args, nonce: '[redacted]' } : args
        // message may be set even when status==='ok' (partial errors / degrade warnings, see the
        // comment above at the envelope.errors branch) — record it as-is, matching
        // toolPipeline.ts's runWrapped, so the audit trail shows warn-and-proceed outcomes too,
        // not only hard failures.
        try {
          await deps.audit.record({ userLabel, sessionId: reqCtx.sessionId, clientInfo: reqCtx.clientInfo,
          tool: `app/${tool.name}`, params: auditParams, status, errorMessage: message,
          eventType: 'tool_call', severity: status === 'ok' ? 'INFO' : 'ERROR',
          traceId, durationMs: Date.now() - started })
        } finally {
          span.end()
        }
      }
      return result
    })
  }
}
