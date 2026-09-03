import type { Db } from '../store/dbTypes.js'

// Task 6：DCR client、authorization_code、refresh token 的 store 層。
// code/refresh 一律只存呼叫端已算好的 hash（sha256）—— 本類別完全不接觸明文，
// 也不做雜湊；caller（Task 7/9 的 authorize/token routes）負責雜湊後才傳進來。

export interface OAuthClient { clientId: string; redirectUris: string[]; createdAt: number }
export interface OAuthAuthCode {
  codeHash: string; clientId: string; redirectUri: string; codeChallenge: string
  identityId: string; exp: number; consumed: number
}
export interface OAuthRefresh {
  refreshHash: string; identityId: string; clientId: string; exp: number; consumed: number
  // Task 10: hash of the oauth_access credential minted in the SAME issuance as this refresh
  // (authorization_code exchange or a prior rotation). Lets rotation delete exactly that one
  // access credential instead of every oauth_access row for the identity — optional/nullable so
  // Task 6's existing insertRefresh callers (tests/oauthStore.test.ts) keep compiling untouched.
  accessCredHash?: string
}

export class OAuthStore {
  constructor(private db: Db) {}

  async insertClient(rec: OAuthClient): Promise<void> {
    await this.db.query('INSERT INTO oauth_clients (client_id, redirect_uris_json, created_at) VALUES ($1,$2,$3)',
      [rec.clientId, JSON.stringify(rec.redirectUris), rec.createdAt])
  }
  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    const r = (await this.db.query('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId])).rows[0] as Record<string, unknown> | undefined
    if (!r) return undefined
    return { clientId: r.client_id as string, redirectUris: JSON.parse(r.redirect_uris_json as string), createdAt: r.created_at as number }
  }

  async insertAuthCode(rec: OAuthAuthCode): Promise<void> {
    await this.db.query(
      `INSERT INTO oauth_auth_codes (code_hash, client_id, redirect_uri, code_challenge, identity_id, exp, consumed)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [rec.codeHash, rec.clientId, rec.redirectUri, rec.codeChallenge, rec.identityId, rec.exp, rec.consumed === 1])
  }
  async getAuthCode(codeHash: string): Promise<OAuthAuthCode | undefined> {
    const r = (await this.db.query('SELECT * FROM oauth_auth_codes WHERE code_hash = $1', [codeHash])).rows[0] as Record<string, unknown> | undefined
    if (!r) return undefined
    return {
      codeHash: r.code_hash as string, clientId: r.client_id as string, redirectUri: r.redirect_uri as string,
      codeChallenge: r.code_challenge as string, identityId: r.identity_id as string, exp: r.exp as number,
      consumed: (r.consumed as boolean) ? 1 : 0,
    }
  }
  async consumeAuthCode(codeHash: string): Promise<void> {
    await this.db.query('UPDATE oauth_auth_codes SET consumed = TRUE WHERE code_hash = $1', [codeHash])
  }

  async insertRefresh(rec: OAuthRefresh): Promise<void> {
    await this.db.query(
      `INSERT INTO oauth_refresh (refresh_hash, identity_id, client_id, exp, consumed, access_cred_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [rec.refreshHash, rec.identityId, rec.clientId, rec.exp, rec.consumed === 1, rec.accessCredHash ?? null])
  }
  private rowToRefresh(r: Record<string, unknown>): OAuthRefresh {
    return {
      refreshHash: r.refresh_hash as string, identityId: r.identity_id as string, clientId: r.client_id as string,
      exp: r.exp as number, consumed: (r.consumed as boolean) ? 1 : 0,
      accessCredHash: (r.access_cred_hash as string | null) ?? undefined,
    }
  }

  async getRefresh(refreshHash: string): Promise<OAuthRefresh | undefined> {
    const r = (await this.db.query('SELECT * FROM oauth_refresh WHERE refresh_hash = $1', [refreshHash])).rows[0] as Record<string, unknown> | undefined
    return r ? this.rowToRefresh(r) : undefined
  }

  async getRefreshByAccessCredHash(accessCredHash: string): Promise<OAuthRefresh | undefined> {
    const r = (await this.db.query('SELECT * FROM oauth_refresh WHERE access_cred_hash = $1', [accessCredHash])).rows[0] as Record<string, unknown> | undefined
    return r ? this.rowToRefresh(r) : undefined
  }

  async countRefreshByIdentity(identityId: string): Promise<number> {
    return (await this.db.query<{ c: number }>('SELECT COUNT(*) c FROM oauth_refresh WHERE identity_id = $1', [identityId])).rows[0].c
  }
  async markRefreshConsumed(refreshHash: string): Promise<void> {
    await this.db.query('UPDATE oauth_refresh SET consumed = TRUE WHERE refresh_hash = $1', [refreshHash])
  }
  async deleteRefreshByIdentity(identityId: string): Promise<void> {
    await this.db.query('DELETE FROM oauth_refresh WHERE identity_id = $1', [identityId])
  }
}
