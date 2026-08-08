import { AuthError } from '../errors.js'

export interface AuthTokens { accessToken: string; refreshToken: string; businessList: unknown[] }

export class AuthServiceClient {
  private baseUrl: string
  private serviceKey: string
  private fetchImpl: typeof fetch

  constructor(opts: { baseUrl: string; serviceKey: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.serviceKey = opts.serviceKey
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async request(method: string, path: string, opts: { json?: unknown; serviceKey?: boolean } = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (opts.serviceKey) headers.authorization = this.serviceKey
    if (opts.json !== undefined) headers['content-type'] = 'application/json'
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method, headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const err = (body?.error ?? body) as Record<string, unknown>
      // Message: code + generic text only. Never include request payloads (credentials).
      throw new AuthError(String(err?.code ?? `HTTP_${res.status}`),
        `auth-service ${method} ${path} failed: ${String(err?.message ?? res.status)}`, res.status)
    }
    return (body as { data?: unknown }).data ?? body
  }

  async login(account: string, password: string, extra: { device?: string; otp?: string } = {}): Promise<{ authorizationCode: string }> {
    const data = await this.request('POST', '/api/v1/auth/be2/login', {
      json: { account, password, ...(extra.device ? { device: extra.device } : {}), ...(extra.otp ? { otp: extra.otp } : {}) },
    }) as { authorizationCode?: string }
    if (!data.authorizationCode) throw new AuthError('NO_AUTH_CODE', 'login response missing authorizationCode', 502)
    return { authorizationCode: data.authorizationCode }
  }

  async exchangeCode(code: string): Promise<AuthTokens> {
    return this.toTokens(await this.request('GET', `/api/v1/login-authorization-code/${encodeURIComponent(code)}`, { serviceKey: true }))
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    return this.toTokens(await this.request('PATCH', `/api/v1/refresh-token/${encodeURIComponent(refreshToken)}`, { serviceKey: true }))
  }

  private toTokens(data: unknown): AuthTokens {
    const d = data as Partial<AuthTokens>
    if (!d.accessToken || !d.refreshToken) throw new AuthError('BAD_TOKEN_RESPONSE', 'auth-service response missing tokens', 502)
    return { accessToken: d.accessToken, refreshToken: d.refreshToken, businessList: d.businessList ?? [] }
  }
}
