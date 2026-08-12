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
        deps.audit.record({ userLabel, sessionId: reqCtx.sessionId, clientInfo: reqCtx.clientInfo,
          tool: `app/${tool.name}`, params: args, status, errorMessage: status === 'ok' ? undefined : message,
          traceId, durationMs: Date.now() - started })
        span.end()
      }
      return result
    })
  }
}
