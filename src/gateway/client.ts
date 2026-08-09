import { GatewayError } from '../errors.js'

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
      const err = (body?.error ?? body) as Record<string, unknown>
      throw new GatewayError(String(err?.code ?? `HTTP_${res.status}`),
        `GET ${path} -> ${res.status}: ${String(err?.message ?? 'gateway error')}`, res.status)
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
      const err = (b?.error ?? b) as Record<string, unknown>
      throw new GatewayError(String(err?.code ?? `HTTP_${res.status}`),
        `PUT ${path} -> ${res.status}: ${String(err?.message ?? 'gateway error')}`, res.status)
    }
    return (b as { data?: unknown }).data ?? b
  }
}
