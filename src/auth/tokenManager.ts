import { TokenStore, type TokenRecord } from '../store/tokenStore.js'
import type { AuthServiceClient } from './authServiceClient.js'
import { decodeJwtExpMs } from './jwt.js'
import { AppError, AuthError } from '../errors.js'

export interface UserAuthContext { accessToken: string; userLabel: string; businessList: unknown[] }

export class TokenManager {
  private skewMs: number
  private now: () => number
  // Single-flight per bearer. In-process is correct for Phase 1a's single instance;
  // multi-instance deployment must move this to a shared lock (Redis SET NX / DB advisory lock).
  private inflight = new Map<string, Promise<TokenRecord>>()

  constructor(private store: TokenStore, private auth: AuthServiceClient,
    opts: { skewMs?: number; now?: () => number } = {}) {
    this.skewMs = opts.skewMs ?? 5 * 60_000
    this.now = opts.now ?? Date.now
  }

  async getFreshAccessToken(bearer: string): Promise<UserAuthContext> {
    let rec = this.store.getByBearer(bearer)
    if (!rec) throw new AuthError('UNKNOWN_BEARER', 'unknown bearer token — run bootstrap-user to enroll', 401)

    if (rec.accessExpiresAt - this.now() < this.skewMs) {
      const key = rec.bearerHash
      let flight = this.inflight.get(key)
      if (!flight) {
        flight = this.doRefresh(rec).finally(() => this.inflight.delete(key))
        this.inflight.set(key, flight)
      }
      rec = await flight
    }
    return { accessToken: rec.accessToken, userLabel: rec.userLabel, businessList: rec.businessList }
  }

  private async doRefresh(rec: TokenRecord): Promise<TokenRecord> {
    let tokens
    try {
      tokens = await this.auth.refresh(rec.refreshToken)
    } catch (e) {
      // Definitive 4xx from auth-service = rotated-away, expired, or user_status
      // disabled — fail closed, require re-enroll.
      if (e instanceof AuthError && e.status >= 400 && e.status < 500) {
        throw new AuthError('REAUTH_REQUIRED', `be2 session expired or revoked (${e.code}) — re-run bootstrap-user`, 401)
      }
      // Transient (network / 5xx): the refresh was pre-emptive. If the stored access
      // token hasn't actually expired yet, keep serving it and retry refresh next call.
      if (rec.accessExpiresAt > this.now()) return rec
      throw new AppError('AUTH_SERVICE_UNAVAILABLE', 'auth-service unreachable and access token expired — retry shortly', 503)
    }
    const updated: TokenRecord = {
      ...rec,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      businessList: tokens.businessList,
      accessExpiresAt: decodeJwtExpMs(tokens.accessToken),
      updatedAt: this.now(),
    }
    this.store.upsert(updated)
    return updated
  }
}
