import { trace, SpanStatusCode } from '@opentelemetry/api'
import { requestContext, type RequestContext } from './requestContext.js'
import type { TokenManager, UserAuthContext } from '../auth/tokenManager.js'
import type { RateBudget } from '../limits/rateBudget.js'
import type { AuditLog } from '../audit/auditLog.js'
import type { GatewayClient } from '../gateway/client.js'
import type { ReadOidStore } from '../store/readOidStore.js'
import type { ChangeSetStore } from '../core/changeset/store.js'
import { CredentialStore } from '../store/credentialStore.js'
import type { ToolDef } from '../tools/types.js'
import type { L2ToolDef, L2ToolContext } from './l2Context.js'
import type { Envelope } from '../tools/envelope.js'
import { AppError, AuthError, RateError } from '../errors.js'

export interface PipelineDeps {
  tokenManager: TokenManager
  rateBudget: RateBudget
  audit: AuditLog
  gateway: GatewayClient
  readOids: ReadOidStore
}

// L2 (change-set) tools need the same span+auth+rate+audit shell as L0 read tools, plus the
// substrate to build an L2ToolContext (changeset store, confirm-url base, id/token minting).
export interface L2PipelineDeps extends PipelineDeps {
  changeSets: ChangeSetStore
  baseUrl: string // for confirm_url, e.g. http://127.0.0.1:8787 — must match where confirmRoutes is mounted
  genId: () => string
  now: () => number
  emitConfirmUrl: (changesetId: string, url: string) => void
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function errResult(code: string, message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }], isError: true }
}

// Shared shell: auth-refresh -> rate-consume -> call handler -> record read_oids -> audit.
// Parametrized over the per-tool-kind context (ToolContext for L0, L2ToolContext for L2) so
// wrapTool/wrapL2Tool differ only in what context they hand the tool's handler.
function runWrapped<Ctx>(
  toolName: string,
  deps: Pick<PipelineDeps, 'tokenManager' | 'rateBudget' | 'audit' | 'readOids'>,
  buildCtx: (user: UserAuthContext, reqCtx: RequestContext) => Ctx,
  callHandler: (ctx: Ctx, args: Record<string, unknown>) => Promise<Envelope>,
) {
  const tracer = trace.getTracer('be2-mcp')
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const reqCtx = requestContext.getStore()
    if (!reqCtx) return errResult('NO_AUTH_CONTEXT', 'missing request auth context')

    return tracer.startActiveSpan(`mcp.tool/${toolName}`, async span => {
      const started = Date.now()
      const traceId = span.spanContext().traceId
      span.setAttribute('mcp.tool', toolName)
      span.setAttribute('mcp.session_id', reqCtx.sessionId)
      let userLabel = 'unknown'
      let status: 'ok' | 'error' | 'denied_rate' | 'denied_auth' = 'ok'
      let result: ToolResult
      let message: string | undefined
      try {
        const user = await deps.tokenManager.getFreshAccessToken(reqCtx.bearer)
        userLabel = user.userLabel
        span.setAttribute('user_id', userLabel)
        deps.rateBudget.consume(userLabel, reqCtx.sessionId)
        const toolCtx = buildCtx(user, reqCtx)
        const envelope = await callHandler(toolCtx, args)
        if (envelope.read_oids.length) deps.readOids.record(reqCtx.sessionId, envelope.read_oids)
        if (envelope.errors.length > 0) {
          // Fully failed (no items) => audited as error. Items + errors => status stays ok but
          // the first error entry is still recorded into audit error_message: that's how a
          // spec-§4.3 degraded gate (warn-and-proceed, e.g. ACTION_CODE_UNVERIFIED) leaves an
          // audit trace through the existing channel — no separate warning pathway.
          const first = envelope.errors[0]
          message = first.code ? `${first.code}: ${first.message}` : first.message
          if (envelope.items.length === 0) status = 'error'
        }
        // 一份結果兩個受眾：text 給 model（格式不變＝零回歸）、structuredContent 給面板。
        // envelope 是純資料物件，直接當 structuredContent。敏感值一律不在 envelope 裡（見計畫 Global Constraints）。
        result = {
          content: [{ type: 'text', text: JSON.stringify(envelope) }],
          structuredContent: envelope as unknown as Record<string, unknown>,
        }
      } catch (e) {
        status = e instanceof RateError ? 'denied_rate' : e instanceof AuthError ? 'denied_auth' : 'error'
        span.recordException(e as Error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        const code = e instanceof AppError ? e.code : 'INTERNAL'
        message = e instanceof AppError ? e.message : 'internal error in be2-mcp — check server logs'
        if (status === 'error') console.error(`be2-mcp tool ${toolName} failed:`, e)
        result = errResult(code, message)
      } finally {
        deps.audit.record({
          userLabel, sessionId: reqCtx.sessionId, clientInfo: reqCtx.clientInfo, tool: toolName,
          // message may be set even when status==='ok' (partial errors / degrade warnings) —
          // record it so the audit trail shows warn-and-proceed outcomes, not just failures.
          params: args, status, errorMessage: message,
          traceId, durationMs: Date.now() - started,
        })
        span.end()
      }
      return result
    })
  }
}

export function wrapTool(tool: ToolDef, deps: PipelineDeps) {
  return runWrapped(tool.name, deps,
    user => ({ gateway: deps.gateway, accessToken: user.accessToken, userLabel: user.userLabel }),
    (ctx, args) => tool.handler(args as never, ctx))
}

// Identity (sessionId/bearerHash/businessList) is derived from the request context + fresh
// token only — never from tool input (spec §6: no self-declared identity/scope). readOids is
// the same session-scoped substrate the L0 tools populate; be2_create_changeset's
// SCOPE_NOT_READ gate reads from it, so this shell must keep recording into it exactly like
// wrapTool does above.
export function wrapL2Tool(tool: L2ToolDef, deps: L2PipelineDeps) {
  return runWrapped(tool.name, deps,
    (user, reqCtx): L2ToolContext => ({
      gateway: deps.gateway,
      accessToken: user.accessToken,
      userLabel: user.userLabel,
      sessionId: reqCtx.sessionId,
      bearerHash: CredentialStore.hash(reqCtx.bearer),
      businessList: user.businessList,
      readOids: deps.readOids,
      changeSets: deps.changeSets,
      rateBudget: deps.rateBudget,
      baseUrl: deps.baseUrl,
      genId: deps.genId,
      now: deps.now,
      emitConfirmUrl: deps.emitConfirmUrl,
    }),
    (ctx, args) => tool.handler(args as never, ctx))
}
