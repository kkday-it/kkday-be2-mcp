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
  // 一次性消費必須是單條條件式 UPDATE（spec §3.3/§6 CAS 慣例）：只有 consumed 仍為 FALSE 時才
  // 翻轉，rowCount===1 才算這次呼叫搶到。無條件 UPDATE 會讓兩個並發請求都通過前面的 SELECT
  // 檢查而各自把 code 換成一組 token（雙發）。回傳是否搶贏，caller 據此決定發 token 或 fail。
  async consumeAuthCode(codeHash: string): Promise<boolean> {
    const r = await this.db.query('UPDATE oauth_auth_codes SET consumed = TRUE WHERE code_hash = $1 AND consumed = FALSE', [codeHash])
    return r.rowCount === 1
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
  // 同 consumeAuthCode 的條件式翻轉：只有 consumed 仍為 FALSE 才成立。輸掉 race（rowCount===0）
  // 代表這顆 refresh 正被並發雙用——這是 token 遭竊訊號，caller 據此走 reuse-detection family
  // revoke（RFC 9700 fail-closed），否則兩個並發請求都會通過 consumed===0 檢查而各自 rotate 一次。
  async markRefreshConsumed(refreshHash: string): Promise<boolean> {
    const r = await this.db.query('UPDATE oauth_refresh SET consumed = TRUE WHERE refresh_hash = $1 AND consumed = FALSE', [refreshHash])
    return r.rowCount === 1
  }
  async deleteRefreshByIdentity(identityId: string): Promise<void> {
    await this.db.query('DELETE FROM oauth_refresh WHERE identity_id = $1', [identityId])
  }
}
