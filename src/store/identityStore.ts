import type { Db } from './dbTypes.js'
export interface Identity {
  identityId: string; userLabel: string; accessToken: string; refreshToken: string
  businessList: unknown[]; accessExpiresAt: number; updatedAt: number
}
export class IdentityStore {
  constructor(private db: Db) {}
  private rowToIdentity(r: Record<string, unknown>): Identity {
    return { identityId: r.identity_id as string, userLabel: r.user_label as string, accessToken: r.access_token as string,
      refreshToken: r.refresh_token as string, businessList: JSON.parse(r.business_list_json as string),
      accessExpiresAt: r.access_expires_at as number, updatedAt: r.updated_at as number }
  }
  async get(identityId: string): Promise<Identity | undefined> {
    const r = (await this.db.query('SELECT * FROM be2_identities WHERE identity_id = $1', [identityId])).rows[0] as Record<string, unknown> | undefined
    return r ? this.rowToIdentity(r) : undefined
  }
  async listByUserLabel(userLabel: string): Promise<Identity[]> {
    const rows = (await this.db.query('SELECT * FROM be2_identities WHERE lower(trim(user_label)) = lower(trim($1))', [userLabel])).rows as Array<Record<string, unknown>>
    return rows.map(r => this.rowToIdentity(r))
  }
  async upsert(rec: Identity): Promise<void> {
    await this.db.query(
      `INSERT INTO be2_identities (identity_id,user_label,access_token,refresh_token,business_list_json,access_expires_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (identity_id) DO UPDATE SET user_label=EXCLUDED.user_label, access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
       business_list_json=EXCLUDED.business_list_json, access_expires_at=EXCLUDED.access_expires_at, updated_at=EXCLUDED.updated_at`,
      [rec.identityId, rec.userLabel, rec.accessToken, rec.refreshToken, JSON.stringify(rec.businessList), rec.accessExpiresAt, rec.updatedAt])
  }
  async delete(identityId: string): Promise<void> { await this.db.query('DELETE FROM be2_identities WHERE identity_id = $1', [identityId]) }

  // keep-alive 跨實例防撞(spec §6):條件式 UPDATE 認領,輸方本 tick 跳過。與 casStatus 同原語。
  async claimKeepalive(identityId: string, nowMs: number, claimTtlMs: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE be2_identities SET keepalive_claimed_at=$1 WHERE identity_id=$2
       AND (keepalive_claimed_at IS NULL OR keepalive_claimed_at < $3)`,
      [nowMs, identityId, nowMs - claimTtlMs])
    return r.rowCount === 1
  }
}
