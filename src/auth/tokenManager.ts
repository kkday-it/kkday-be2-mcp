import type { Identity } from '../store/identityStore.js'
import type { IdentityStore } from '../store/identityStore.js'
import { CredentialStore } from '../store/credentialStore.js'
import type { AuthServiceClient } from './authServiceClient.js'
import { decodeJwtExpMs } from './jwt.js'
import { AppError, AuthError } from '../errors.js'

export interface UserAuthContext { accessToken: string; userLabel: string; businessList: unknown[]; identityId: string }

export interface TokenManagerStores { identities: IdentityStore; credentials: CredentialStore }

export class TokenManager {
  private skewMs: number
  private now: () => number
  private onReauthRequired?: (identityId: string) => void
  // Single-flight 現在以 identityId 為 key（而非個別 credential 的 hash）——be2 refresh
  // 只在 identity 這一層 rotate 一次；同一 identity 底下無論幾個 credential（oauth_access /
  // static_bearer / web_session）並發觸發 refresh 都必須共用同一次 in-flight refresh，
  // 否則兩個 credential 各自 doRefresh 會撞上 be2 refresh-token rotation（舊 refresh 被
  // 對方作廢）。In-process 對 Phase 1a 單一 instance 正確；多 instance 部署須改分散式鎖
  // （Redis SET NX / DB advisory lock）。
  private inflight = new Map<string, Promise<Identity>>()

  constructor(private stores: TokenManagerStores, private auth: AuthServiceClient,
    opts: { skewMs?: number; now?: () => number; onReauthRequired?: (identityId: string) => void } = {}) {
    this.skewMs = opts.skewMs ?? 5 * 60_000
    this.now = opts.now ?? Date.now
    this.onReauthRequired = opts.onReauthRequired
  }

  /** 呼叫端慣用入口——bearer 的 secret hash 即 credential 的 credHash。 */
  async getFreshAccessToken(bearer: string): Promise<UserAuthContext> {
    return this.getFreshBySecret(bearer)
  }

  async getFreshBySecret(secret: string): Promise<UserAuthContext> {
    return this.getFreshByCredHash(CredentialStore.hash(secret))
  }

  async getFreshByCredHash(credHash: string): Promise<UserAuthContext> {
    const cred = this.stores.credentials.get(credHash)
    if (!cred) throw new AuthError('UNKNOWN_BEARER', 'unknown bearer token — reconnect your MCP client (it will be prompted to re-authorize via OAuth); headless fallback: npm run bootstrap-user', 401)
    const identity = this.stores.identities.get(cred.identityId)
    if (!identity) throw new AuthError('UNKNOWN_BEARER', 'unknown bearer token — reconnect your MCP client (it will be prompted to re-authorize via OAuth); headless fallback: npm run bootstrap-user', 401)
    return this.freshFromIdentity(identity, cred.identityId)
  }

  /** 排程執行入口(spec §6):以持久化的 identityId 直接取新鮮 token。 */
  async getFreshByIdentityId(identityId: string): Promise<UserAuthContext> {
    const identity = this.stores.identities.get(identityId)
    if (!identity) throw new AuthError('UNKNOWN_IDENTITY', 'identity no longer exists — the scheduled change-set cannot execute; re-create it after logging in again', 401)
    return this.freshFromIdentity(identity, identityId)
  }

  /** 排程 keep-alive(spec §6):只對「將於 windowMs 內到期」者**強制** refresh;到期判斷留在
   *  本類內,scheduler 只給名單。DB claim(claimKeepalive)防多實例重複 refresh 撞 rotation。
   *  永不 throw——失敗逐一回報(terminal=4xx 撤權類,由 scheduler 據以 fail 排程件),
   *  執行時刻的失敗仍由 getFreshByIdentityId 把關。
   *  ⚠️ 不走 freshFromIdentity——它只在 skewMs 內才 refresh,windowMs>skewMs 的區間會空轉
   *  (claim 了卻沒 refresh、下 tick 再 claim,假成功 audit 洗版)。這裡直接進 doRefresh,
   *  但沿用同一 inflight single-flight map,與 lazy 路徑互不重複 refresh。 */
  async keepAlive(identityIds: string[], opts: { windowMs: number; claimTtlMs: number }):
      Promise<{ refreshed: string[]; failed: Array<{ identityId: string; code: string; terminal: boolean }> }> {
    const refreshed: string[] = []
    const failed: Array<{ identityId: string; code: string; terminal: boolean }> = []
    for (const id of identityIds) {
      const identity = this.stores.identities.get(id)
      if (!identity) { failed.push({ identityId: id, code: 'UNKNOWN_IDENTITY', terminal: true }); continue }
      if (identity.accessExpiresAt - this.now() >= opts.windowMs) continue
      if (!this.stores.identities.claimKeepalive(id, this.now(), opts.claimTtlMs)) continue
      try {
        let flight = this.inflight.get(id)
        if (!flight) {
          flight = this.doRefresh(identity, id).finally(() => this.inflight.delete(id))
          this.inflight.set(id, flight)
        }
        const updated = await flight
        // transient 分支會回舊 identity(未 rotate)——只有真的延壽才算 refreshed,避免假成功 audit。
        if (updated.accessExpiresAt > identity.accessExpiresAt) refreshed.push(id)
      } catch (e) {
        // AuthError(REAUTH_REQUIRED / UNKNOWN_*)= terminal:identity 已死,scheduler 應立即
        // fail 其名下排程件,否則每 tick 重打 auth-service 直到 T(error 洗版 + hammering)。
        failed.push({ identityId: id, code: (e as { code?: string }).code ?? 'REFRESH_FAILED',
          terminal: e instanceof AuthError })
      }
    }
    return { refreshed, failed }
  }

  private async freshFromIdentity(identity: Identity, identityId: string): Promise<UserAuthContext> {
    if (identity.accessExpiresAt - this.now() < this.skewMs) {
      let flight = this.inflight.get(identityId)
      if (!flight) {
        flight = this.doRefresh(identity, identityId).finally(() => this.inflight.delete(identityId))
        this.inflight.set(identityId, flight)
      }
      identity = await flight
    }
    return { accessToken: identity.accessToken, userLabel: identity.userLabel, businessList: identity.businessList, identityId }
  }

  private async doRefresh(identity: Identity, identityId: string): Promise<Identity> {
    let tokens
    try {
      tokens = await this.auth.refresh(identity.refreshToken)
    } catch (e) {
      // Definitive 4xx from auth-service = rotated-away, expired, or user_status
      // disabled — fail closed, require re-enroll.
      if (e instanceof AuthError && e.status >= 400 && e.status < 500) {
        try {
          this.onReauthRequired?.(identityId)
        } catch (err) {
          console.error('onReauthRequired callback failed:', err)
        }
        throw new AuthError('REAUTH_REQUIRED', `be2 session expired or revoked (${e.code}) — this connection has been reset; your MCP client will re-run the OAuth login on its next request (headless fallback: npm run bootstrap-user)`, 401)
      }
      // Transient (network / 5xx): the refresh was pre-emptive. If the stored access
      // token hasn't actually expired yet, keep serving it and retry refresh next call.
      if (identity.accessExpiresAt > this.now()) return identity
      throw new AppError('AUTH_SERVICE_UNAVAILABLE', 'auth-service unreachable and access token expired — retry shortly', 503)
    }
    const updated: Identity = {
      ...identity,
      identityId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      businessList: tokens.businessList,
      accessExpiresAt: decodeJwtExpMs(tokens.accessToken),
      updatedAt: this.now(),
    }
    this.stores.identities.upsert(updated)
    return updated
  }
}
