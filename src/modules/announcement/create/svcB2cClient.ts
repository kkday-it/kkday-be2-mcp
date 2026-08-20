import { GatewayError } from '../../../errors.js'
import { decodePlatformId } from './userUuid.js'

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

  async listByProdOids(accessToken: string, prodOids: string[]): Promise<unknown[]> {
    const qs = new URLSearchParams({ page: '1', perPage: '100', prodOids: prodOids.join(',') })
    let r: Response
    try {
      r = await this.fetchImpl(`${this.baseUrl}/admin/product/announcement?${qs}`, {
        method: 'GET', headers: this.headers(accessToken), signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new GatewayError('GATEWAY_UNREACHABLE', `GET announcement failed: ${(e as Error).name}`, 502)
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!r.ok || !ok0000(body)) {
      const { code, message } = errParts(body, r.status)
      throw new GatewayError(code, `GET announcement -> ${r.status}: ${message}`, r.ok ? 502 : r.status)
    }
    const data = (body as { data?: unknown }).data
    return Array.isArray(data) ? data : []
  }

  async create(accessToken: string, body: Record<string, unknown>): Promise<unknown> {
    let r: Response
    try {
      r = await this.fetchImpl(`${this.baseUrl}/admin/product/announcement`, {
        method: 'POST', headers: this.headers(accessToken), body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new GatewayError('GATEWAY_UNREACHABLE', `POST announcement failed: ${(e as Error).name}`, 502)
    }
    const b = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!r.ok || !ok0000(b)) {
      const { code, message } = errParts(b, r.status)
      throw new GatewayError(code, `POST announcement -> ${r.status}: ${message}`, r.ok ? 502 : r.status)
    }
    return (b as { data?: unknown }).data ?? b
  }
}

// 工廠：從 process.env 讀 svc-b2c host（沿用 GATEWAY_URL 的 gateway host + /svc-b2c/api/v1）與固定 api key。
// live 寫入卡 S2S 403 前，key 可能未設 → 缺 key 時明確報錯（build/單元測試不經此路徑）。
export function makeAnnouncementClient(): AnnouncementClient {
  const gw = process.env.GATEWAY_URL
  const apiKey = process.env.SIT_ANNOUNCE_API_KEY
  if (!gw) throw new GatewayError('GATEWAY_URL_MISSING', 'GATEWAY_URL not set', 500)
  if (!apiKey) throw new GatewayError('ANNOUNCE_KEY_MISSING', 'SIT_ANNOUNCE_API_KEY not set (announcement live-write blocked)', 500)
  return new AnnouncementClient({ baseUrl: `${gw.replace(/\/$/, '')}/svc-b2c/api/v1`, apiKey })
}
