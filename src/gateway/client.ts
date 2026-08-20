import { GatewayError } from '../errors.js'

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

export class GatewayClient {
  private baseUrl: string
  private fetchImpl: typeof fetch
  private timeoutMs: number

  constructor(opts: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
  }

  async get(path: string, accessToken: string, query?: Record<string, string>): Promise<unknown> {
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}${qs}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'x-auth-id': 'be2' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new GatewayError('GATEWAY_UNREACHABLE', `GET ${path} failed: ${(e as Error).name}`, 502)
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const { code, message } = gatewayErrorParts(body, res.status)
      throw new GatewayError(code, `GET ${path} -> ${res.status}: ${message}`, res.status)
    }
    return (body as { data?: unknown }).data ?? body
  }

  async put(path: string, accessToken: string, body: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/json', 'x-auth-id': 'be2' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new GatewayError('GATEWAY_UNREACHABLE', `PUT ${path} failed: ${(e as Error).name}`, 502)
    }
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const { code, message } = gatewayErrorParts(b, res.status)
      throw new GatewayError(code, `PUT ${path} -> ${res.status}: ${message}`, res.status)
    }
    return (b as { data?: unknown }).data ?? b
  }

  async post(path: string, accessToken: string, body: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/json', 'x-auth-id': 'be2' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new GatewayError('GATEWAY_UNREACHABLE', `POST ${path} failed: ${(e as Error).name}`, 502)
    }
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const { code, message } = gatewayErrorParts(b, res.status)
      throw new GatewayError(code, `POST ${path} -> ${res.status}: ${message}`, res.status)
    }
    return (b as { data?: unknown }).data ?? b
  }
}
