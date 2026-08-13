import type Database from 'better-sqlite3'
export interface Identity {
  identityId: string; userLabel: string; accessToken: string; refreshToken: string
  businessList: unknown[]; accessExpiresAt: number; updatedAt: number
}
export class IdentityStore {
  constructor(private db: Database.Database) {}
  get(identityId: string): Identity | undefined {
    const r = this.db.prepare('SELECT * FROM be2_identities WHERE identity_id = ?').get(identityId) as Record<string, unknown> | undefined
    if (!r) return undefined
    return { identityId: r.identity_id as string, userLabel: r.user_label as string, accessToken: r.access_token as string,
      refreshToken: r.refresh_token as string, businessList: JSON.parse(r.business_list_json as string),
      accessExpiresAt: r.access_expires_at as number, updatedAt: r.updated_at as number }
  }
  upsert(rec: Identity): void {
    this.db.prepare(`INSERT INTO be2_identities (identity_id,user_label,access_token,refresh_token,business_list_json,access_expires_at,updated_at)
      VALUES (@identityId,@userLabel,@accessToken,@refreshToken,@businessListJson,@accessExpiresAt,@updatedAt)
      ON CONFLICT(identity_id) DO UPDATE SET user_label=@userLabel,access_token=@accessToken,refresh_token=@refreshToken,
      business_list_json=@businessListJson,access_expires_at=@accessExpiresAt,updated_at=@updatedAt`)
      .run({ ...rec, businessListJson: JSON.stringify(rec.businessList) })
  }
  delete(identityId: string): void { this.db.prepare('DELETE FROM be2_identities WHERE identity_id = ?').run(identityId) }
}
