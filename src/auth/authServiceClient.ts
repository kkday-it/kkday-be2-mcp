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
      // VERIFIED against live SIT be2-220 (2026-08-09): auth-service uses a
      // {metadata:{status,desc}, data} envelope, including on error responses
      // (e.g. HTTP 422 with metadata.status === 'AU9010'). Fall back to the
      // legacy {error:{code,message}} shape, then a generic HTTP_{status}.
      const metadata = body?.metadata as Record<string, unknown> | undefined
      const legacyErr = body?.error as Record<string, unknown> | undefined
      const code = metadata?.status ?? legacyErr?.code ?? `HTTP_${res.status}`
      const message = metadata?.desc ?? legacyErr?.message ?? res.status
      // Message: code + generic text only. Never include request payloads (credentials).
      throw new AuthError(String(code),
        `auth-service ${method} ${path} failed: ${String(message)}`, res.status)
    }
    return (body as { data?: unknown }).data ?? body
  }

  async login(account: string, password: string, extra: { device?: string; otp?: string } = {}): Promise<{ authorizationCode: string }> {
    const data = await this.request('POST', '/api/v1/auth/be2/login', {
      json: { account, password, ...(extra.device ? { device: extra.device } : {}), ...(extra.otp ? { otp: extra.otp } : {}) },
    }) as { authorizationCode?: string; authorization_code?: string }
    const authorizationCode = data.authorizationCode ?? data.authorization_code
    if (!authorizationCode) throw new AuthError('NO_AUTH_CODE', 'login response missing authorizationCode', 502)
    return { authorizationCode }
  }

  async exchangeCode(code: string): Promise<AuthTokens> {
    return this.toTokens(await this.request('GET', `/api/v1/login-authorization-code/${encodeURIComponent(code)}`, { serviceKey: true }))
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    return this.toTokens(await this.request('PATCH', `/api/v1/refresh-token/${encodeURIComponent(refreshToken)}`, { serviceKey: true }))
  }

  private toTokens(data: unknown): AuthTokens {
    // Success-payload key casing (camelCase vs snake_case) is UNVERIFIED against
    // live SIT (login was blocked by stale credentials, see docs/be2-mcp/sit-contracts.md).
    // Accept both until confirmed in Task 16.
    const d = data as Record<string, unknown>
    const accessToken = (d.accessToken ?? d.access_token) as string | undefined
    const refreshToken = (d.refreshToken ?? d.refresh_token) as string | undefined
    const businessList = (d.businessList ?? d.business_list ?? []) as unknown[]
    if (!accessToken || !refreshToken) throw new AuthError('BAD_TOKEN_RESPONSE', 'auth-service response missing tokens', 502)
    return { accessToken, refreshToken, businessList }
  }
}
