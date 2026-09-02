import { GatewayError } from '../../../errors.js'
import { fetchJson } from '../../../gateway/httpJson.js'
import { decodePlatformId } from './userUuid.js'
import { announceKeyVarFor } from '../../../config.js'

// svc-b2c 成功 = HTTP 200 且 metadata.status '0000'（§3 契約）。與 core GatewayClient 不同 host/header/
// envelope，故 module-local 自建。user-uuid 由 accessToken 自解（讀寫三處統一，皆有 accessToken）。
function ok0000(body: Record<string, unknown>): boolean {
  const meta = body?.metadata as { status?: unknown } | undefined
  return String(meta?.status ?? '') === '0000'
}
function errParts(body: Record<string, unknown>, status: number): { code: string; message: string } {
  const meta = (body?.metadata ?? {}) as { status?: unknown; desc?: unknown }
  return { code: String(meta.status ?? `HTTP_${status}`), message: String(meta.desc ?? 'announcement error') }
}

export class AnnouncementClient {
  private baseUrl: string
  private apiKey: string
  private fetchImpl: typeof fetch
  private timeoutMs: number
  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'user-uuid': decodePlatformId(accessToken),
      'x-auth-id': 'be2',
    }
  }

  // HTTP 底層（fetch/timeout/json/unreachable→502）委派共用 fetchJson（src/gateway/httpJson.ts）；
  // 本 client 只保留 svc-b2c 專屬語義：0000 成功判定 + metadata 錯誤碼萃取 + 特有 header。
  private check(label: string, r: { ok: boolean; status: number; body: Record<string, unknown> }): Record<string, unknown> {
    if (!r.ok || !ok0000(r.body)) {
      const { code, message } = errParts(r.body, r.status)
      throw new GatewayError(code, `${label} -> ${r.status}: ${message}`, r.ok ? 502 : r.status)
    }
    return r.body
  }

  async listByProdOids(accessToken: string, prodOids: string[]): Promise<unknown[]> {
    const qs = new URLSearchParams({ page: '1', perPage: '100', prodOids: prodOids.join(',') })
    const r = await fetchJson(this.fetchImpl, `${this.baseUrl}/admin/product/announcement?${qs}`,
      { method: 'GET', headers: this.headers(accessToken) }, this.timeoutMs, 'GET announcement')
    const data = (this.check('GET announcement', r) as { data?: unknown }).data
    return Array.isArray(data) ? data : []
  }

  async create(accessToken: string, body: Record<string, unknown>): Promise<unknown> {
    const r = await fetchJson(this.fetchImpl, `${this.baseUrl}/admin/product/announcement`,
      { method: 'POST', headers: this.headers(accessToken), body: JSON.stringify(body) }, this.timeoutMs, 'POST announcement')
    const b = this.check('POST announcement', r)
    return (b as { data?: unknown }).data ?? b
  }

  async getDetail(accessToken: string, announcementOid: number | string): Promise<unknown> {
    const r = await fetchJson(this.fetchImpl, `${this.baseUrl}/admin/product/announcement/${announcementOid}`,
      { method: 'GET', headers: this.headers(accessToken) }, this.timeoutMs, 'GET announcement detail')
    const b = this.check('GET announcement detail', r)
    return (b as { data?: unknown }).data ?? b
  }

  // PATCH 送整份文件（full REPLACE，§6.2）；response data 恆為 null，故不回傳 unwrap 值。
  async patch(accessToken: string, announcementOid: number | string, body: Record<string, unknown>): Promise<void> {
    const r = await fetchJson(this.fetchImpl, `${this.baseUrl}/admin/product/announcement/${announcementOid}`,
      { method: 'PATCH', headers: this.headers(accessToken), body: JSON.stringify(body) }, this.timeoutMs, 'PATCH announcement')
    this.check('PATCH announcement', r)
  }
}

// env-aware x-api-key 解析：依 BE2_ENV 從 config.ts 的集中映射（announceKeyVarFor）取對應變數名，
// 避免部署到 stage/prod 時仍誤用 SIT key（D3-5）。映射的單一事實來源在 config.ts，這裡只消費。
export function resolveAnnounceApiKey(): string {
  const env = process.env.BE2_ENV ?? 'sit'
  const varName = announceKeyVarFor(env)
  const key = process.env[varName]
  if (!key) throw new GatewayError('ANNOUNCE_KEY_MISSING', `${varName} not set for BE2_ENV=${env}`, 500)
  return key
}

// 工廠：從 process.env 讀 svc-b2c host（沿用 GATEWAY_URL 的 gateway host + /svc-b2c/api/v1）與依 BE2_ENV
// 解析出的 api key。live 寫入卡 S2S 403 前，key 可能未設 → 缺 key 時明確報錯（build/單元測試不經此路徑）。
export function makeAnnouncementClient(): AnnouncementClient {
  const gw = process.env.GATEWAY_URL
  if (!gw) throw new GatewayError('GATEWAY_URL_MISSING', 'GATEWAY_URL not set', 500)
  const apiKey = resolveAnnounceApiKey()
  return new AnnouncementClient({ baseUrl: `${gw.replace(/\/$/, '')}/svc-b2c/api/v1`, apiKey })
}
