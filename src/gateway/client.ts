import { GatewayError } from '../errors.js'
import { fetchJson } from './httpJson.js'

// be2 錯誤回應有兩種 envelope（2026-08-16 彩排實測 + sit-contracts）：
// `{data:null, meta:{status,desc}}`（product-service 直達）與 `{metadata:{status,desc}, data}`
// （部分 be2-api 端點）。原本只認 `.error/.code/.message`，這兩種形狀會退化成
// HTTP_xxx/"gateway error"、丟失 be2 錯誤碼（如 131105）與中文訊息。
function gatewayErrorParts(body: Record<string, unknown>, status: number): { code: string; message: string } {
  const err = (body?.error ?? body) as Record<string, unknown>
  const meta = (body?.meta ?? body?.metadata) as Record<string, unknown> | undefined
  const code = err?.code ?? meta?.status
  const message = err?.message ?? meta?.desc
  return { code: String(code ?? `HTTP_${status}`), message: String(message ?? 'gateway error') }
}

const BE2_HEADERS = { accept: 'application/json', 'x-auth-id': 'be2' } as const

export class GatewayClient {
  private baseUrl: string
  private fetchImpl: typeof fetch
  private timeoutMs: number
  private traceId?: string

  constructor(opts: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
  }

  withTrace(traceId: string): GatewayClient {
    const bound = Object.create(this) as GatewayClient
    bound.traceId = traceId
    return bound
  }

  private traceHeaders(): Record<string, string> {
    return this.traceId ? { "request-uuid": this.traceId } : {}

  }

  // 成功語義（data envelope 解包）與錯誤碼萃取（meta/metadata/error）留在此層；HTTP 底層
  // （fetch/timeout/json/unreachable→502）委派 fetchJson（src/gateway/httpJson.ts），與 announcement
  // 的 svc-b2c client 共用同一原語（code-review Standards 軸 Duplicated Code 收斂）。行為不變。
  private unwrap(path: string, method: string, r: { ok: boolean; status: number; body: Record<string, unknown> }): unknown {
    if (!r.ok) {
      const { code, message } = gatewayErrorParts(r.body, r.status)
      throw new GatewayError(code, `${method} ${path} -> ${r.status}: ${message}`, r.status)
    }
    return (r.body as { data?: unknown }).data ?? r.body
  }

  async get(path: string, accessToken: string, query?: Record<string, string>): Promise<unknown> {
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''
    const r = await fetchJson(this.fetchImpl, `${this.baseUrl}${path}${qs}`,
      { headers: { authorization: `Bearer ${accessToken}`, ...BE2_HEADERS, ...this.traceHeaders() } }, this.timeoutMs, `GET ${path}`)
    return this.unwrap(path, 'GET', r)
  }

  async put(path: string, accessToken: string, body: unknown): Promise<unknown> {
    const r = await fetchJson(this.fetchImpl, `${this.baseUrl}${path}`,
      { method: 'PUT', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...BE2_HEADERS, ...this.traceHeaders() }, body: JSON.stringify(body) },
      this.timeoutMs, `PUT ${path}`)
    return this.unwrap(path, 'PUT', r)
  }

  async post(path: string, accessToken: string, body: unknown): Promise<unknown> {
    const r = await fetchJson(this.fetchImpl, `${this.baseUrl}${path}`,
      { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...BE2_HEADERS, ...this.traceHeaders() }, body: JSON.stringify(body) },
      this.timeoutMs, `POST ${path}`)
    return this.unwrap(path, 'POST', r)
  }
}
