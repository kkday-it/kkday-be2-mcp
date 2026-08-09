import { trace, SpanStatusCode } from '@opentelemetry/api'
import { requestContext } from './requestContext.js'
import type { TokenManager } from '../auth/tokenManager.js'
import type { RateBudget } from '../limits/rateBudget.js'
import type { AuditLog } from '../audit/auditLog.js'
import type { GatewayClient } from '../gateway/client.js'
import type { ReadOidStore } from '../store/readOidStore.js'
import type { ToolDef } from '../tools/types.js'
import { AppError, AuthError, RateError } from '../errors.js'

export interface PipelineDeps {
  tokenManager: TokenManager
  rateBudget: RateBudget
  audit: AuditLog
  gateway: GatewayClient
  readOids: ReadOidStore
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function errResult(code: string, message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }], isError: true }
}

export function wrapTool(tool: ToolDef, deps: PipelineDeps) {
  const tracer = trace.getTracer('be2-mcp')
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const ctx = requestContext.getStore()
    if (!ctx) return errResult('NO_AUTH_CONTEXT', 'missing request auth context')

    return tracer.startActiveSpan(`mcp.tool/${tool.name}`, async span => {
      const started = Date.now()
      const traceId = span.spanContext().traceId
      span.setAttribute('mcp.tool', tool.name)
      span.setAttribute('mcp.session_id', ctx.sessionId)
      let userLabel = 'unknown'
      let status: 'ok' | 'error' | 'denied_rate' | 'denied_auth' = 'ok'
      let result: ToolResult
      let message: string | undefined
      try {
        const user = await deps.tokenManager.getFreshAccessToken(ctx.bearer)
        userLabel = user.userLabel
        span.setAttribute('user_id', userLabel)
        deps.rateBudget.consume(userLabel, ctx.sessionId)
        const envelope = await tool.handler(args as never, {
          gateway: deps.gateway, accessToken: user.accessToken, userLabel,
        })
        if (envelope.read_oids.length) deps.readOids.record(ctx.sessionId, envelope.read_oids)
        if (envelope.items.length === 0 && envelope.errors.length > 0) {
          status = 'error'
          const first = envelope.errors[0]
          message = first.code ? `${first.code}: ${first.message}` : first.message
        }
        result = { content: [{ type: 'text', text: JSON.stringify(envelope) }] }
      } catch (e) {
        status = e instanceof RateError ? 'denied_rate' : e instanceof AuthError ? 'denied_auth' : 'error'
        span.recordException(e as Error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        const code = e instanceof AppError ? e.code : 'INTERNAL'
        message = e instanceof AppError ? e.message : 'internal error in be2-mcp — check server logs'
        if (status === 'error') console.error(`be2-mcp tool ${tool.name} failed:`, e)
        result = errResult(code, message)
      } finally {
        deps.audit.record({
          userLabel, sessionId: ctx.sessionId, clientInfo: ctx.clientInfo, tool: tool.name,
          params: args, status, errorMessage: status === 'ok' ? undefined : message,
          traceId, durationMs: Date.now() - started,
        })
        span.end()
      }
      return result
    })
  }
}
