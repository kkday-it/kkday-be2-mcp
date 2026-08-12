import { trace, SpanStatusCode } from '@opentelemetry/api'
import { requestContext } from './requestContext.js'
import type { TokenManager } from '../auth/tokenManager.js'
import type { AuditLog } from '../audit/auditLog.js'
import type { GatewayClient } from '../gateway/client.js'
import type { ChangeSetStore } from '../changeset/store.js'
import type { ApprovalNonceStore } from '../changeset/approvalNonce.js'
import type { AppRateBudget } from '../limits/appRateBudget.js'
import { TokenStore } from '../store/tokenStore.js'
import type { Envelope } from '../tools/envelope.js'
import { AppError, AuthError, RateError } from '../errors.js'
import { approveAndExecute as approveAndExecuteService, type ApproveParams, type ApproveResult } from '../changeset/confirmService.js'

// app-only（面板專用）工具的執行環境：與 L2ToolContext 同源身分資訊（sessionId/bearerHash/
// businessList 皆由 token 推導、絕不接受 input 自報身分），但服務對象是面板輪詢而非 LLM 對話。
export interface AppToolContext {
  gateway: GatewayClient
  accessToken: string
  userLabel: string
  sessionId: string
  bearerHash: string
  businessList: unknown[]
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
}

export interface AppToolDef {
  name: string
  description: string
  inputShape: Record<string, unknown>
  handler(args: any, ctx: AppToolContext): Promise<Envelope>
}

export interface AppPipelineDeps {
  tokenManager: TokenManager
  appRateBudget: AppRateBudget
  audit: AuditLog
  gateway: GatewayClient
  changeSets: ChangeSetStore
  nonces: ApprovalNonceStore
  now: () => number
  genId: () => string
  baseUrl: string
  // Same lazy-resolver contract as confirmRoutes.ts's ConfirmDeps.modifyUserFrom (src/server/
  // app.ts's modifyUserFromPlaceholder) — only ever invoked LAZILY inside approveAndExecute, never
  // here at pipeline-construction/request time.
  modifyUserFrom: (accessToken: string) => string
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
      const started = Date.now(); const traceId = span.spanContext().traceId
      span.setAttribute('mcp.apptool', tool.name); span.setAttribute('mcp.session_id', reqCtx.sessionId)
      let userLabel = 'unknown'
      let status: 'ok' | 'error' | 'denied_rate' | 'denied_auth' = 'ok'
      let result: ToolResult; let message: string | undefined
      try {
        const user = await deps.tokenManager.getFreshAccessToken(reqCtx.bearer)
        userLabel = user.userLabel; span.setAttribute('user_id', userLabel)
        deps.appRateBudget.consume(reqCtx.sessionId)   // 獨立限流，不碰 RateBudget
        const envelope = await tool.handler(args, {
          gateway: deps.gateway, accessToken: user.accessToken, userLabel,
          sessionId: reqCtx.sessionId, bearerHash: TokenStore.hashBearer(reqCtx.bearer),
          businessList: user.businessList, changeSets: deps.changeSets, nonces: deps.nonces,
          now: deps.now, genId: deps.genId,
          baseUrl: deps.baseUrl,
          // Closure binds THIS request's resolved identity (accessToken/userLabel/sessionId) —
          // never taken from tool args. modifyUser stays unresolved until approveAndExecute needs
          // it (lazy), so read-only app tools (e.g. app_get_changeset_view) never pay the cost of
          // — or fail on — modify_user resolution.
          approveAndExecute: p => approveAndExecuteService(
            { changeSets: deps.changeSets, gateway: deps.gateway, audit: deps.audit, now: deps.now, modifyUserFrom: deps.modifyUserFrom },
            { ...p, who: { accessToken: user.accessToken, userLabel, sessionId: reqCtx.sessionId } },
          ),
        })
        if (envelope.items.length === 0 && envelope.errors.length > 0) {
          status = 'error'; const f = envelope.errors[0]; message = f.code ? `${f.code}: ${f.message}` : f.message
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
        deps.audit.record({ userLabel, sessionId: reqCtx.sessionId, clientInfo: reqCtx.clientInfo,
          tool: `app/${tool.name}`, params: auditParams, status, errorMessage: status === 'ok' ? undefined : message,
          traceId, durationMs: Date.now() - started })
        span.end()
      }
      return result
    })
  }
}
