import type Database from 'better-sqlite3'

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
  constructor(private db: Database.Database) {}

  insertClient(rec: OAuthClient): void {
    this.db.prepare('INSERT INTO oauth_clients (client_id, redirect_uris_json, created_at) VALUES (?,?,?)')
      .run(rec.clientId, JSON.stringify(rec.redirectUris), rec.createdAt)
  }
  getClient(clientId: string): OAuthClient | undefined {
    const r = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as Record<string, unknown> | undefined
    if (!r) return undefined
    return { clientId: r.client_id as string, redirectUris: JSON.parse(r.redirect_uris_json as string), createdAt: r.created_at as number }
  }

  insertAuthCode(rec: OAuthAuthCode): void {
    this.db.prepare(`INSERT INTO oauth_auth_codes (code_hash, client_id, redirect_uri, code_challenge, identity_id, exp, consumed)
      VALUES (@codeHash,@clientId,@redirectUri,@codeChallenge,@identityId,@exp,@consumed)`).run(rec)
  }
  getAuthCode(codeHash: string): OAuthAuthCode | undefined {
    const r = this.db.prepare('SELECT * FROM oauth_auth_codes WHERE code_hash = ?').get(codeHash) as Record<string, unknown> | undefined
    if (!r) return undefined
    return {
      codeHash: r.code_hash as string, clientId: r.client_id as string, redirectUri: r.redirect_uri as string,
      codeChallenge: r.code_challenge as string, identityId: r.identity_id as string, exp: r.exp as number, consumed: r.consumed as number,
    }
  }
  consumeAuthCode(codeHash: string): void {
    this.db.prepare('UPDATE oauth_auth_codes SET consumed = 1 WHERE code_hash = ?').run(codeHash)
  }

  insertRefresh(rec: OAuthRefresh): void {
    this.db.prepare(`INSERT INTO oauth_refresh (refresh_hash, identity_id, client_id, exp, consumed, access_cred_hash)
      VALUES (@refreshHash,@identityId,@clientId,@exp,@consumed,@accessCredHash)`)
      .run({ ...rec, accessCredHash: rec.accessCredHash ?? null })
  }
  getRefresh(refreshHash: string): OAuthRefresh | undefined {
    const r = this.db.prepare('SELECT * FROM oauth_refresh WHERE refresh_hash = ?').get(refreshHash) as Record<string, unknown> | undefined
    if (!r) return undefined
    return {
      refreshHash: r.refresh_hash as string, identityId: r.identity_id as string, clientId: r.client_id as string,
      exp: r.exp as number, consumed: r.consumed as number,
      accessCredHash: (r.access_cred_hash as string | null) ?? undefined,
    }
  }
  markRefreshConsumed(refreshHash: string): void {
    this.db.prepare('UPDATE oauth_refresh SET consumed = 1 WHERE refresh_hash = ?').run(refreshHash)
  }
  deleteRefreshByIdentity(identityId: string): void {
    this.db.prepare('DELETE FROM oauth_refresh WHERE identity_id = ?').run(identityId)
  }
}
