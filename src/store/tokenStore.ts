import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export interface TokenRecord {
  bearerHash: string
  userLabel: string
  accessToken: string
  refreshToken: string
  businessList: unknown[]
  accessExpiresAt: number
  updatedAt: number
}

export class TokenStore {
  constructor(private db: Database.Database) {}

  static hashBearer(bearer: string): string {
    return createHash('sha256').update(bearer).digest('hex')
  }

  getByBearer(bearer: string): TokenRecord | undefined {
    return this.getByBearerHash(TokenStore.hashBearer(bearer))
  }

  getByBearerHash(hash: string): TokenRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM user_tokens WHERE bearer_hash = ?')
      .get(hash) as Record<string, unknown> | undefined
    return row ? this.rowToRecord(row) : undefined
  }

  private rowToRecord(row: Record<string, unknown>): TokenRecord {
    return {
      bearerHash: row.bearer_hash as string,
      userLabel: row.user_label as string,
      accessToken: row.access_token as string,
      refreshToken: row.refresh_token as string,
      businessList: JSON.parse(row.business_list_json as string),
      accessExpiresAt: row.access_expires_at as number,
      updatedAt: row.updated_at as number,
    }
  }

  upsert(rec: TokenRecord): void {
    this.db.prepare(`
      INSERT INTO user_tokens (bearer_hash, user_label, access_token, refresh_token, business_list_json, access_expires_at, updated_at)
      VALUES (@bearerHash, @userLabel, @accessToken, @refreshToken, @businessListJson, @accessExpiresAt, @updatedAt)
      ON CONFLICT(bearer_hash) DO UPDATE SET
        user_label=@userLabel, access_token=@accessToken, refresh_token=@refreshToken,
        business_list_json=@businessListJson, access_expires_at=@accessExpiresAt, updated_at=@updatedAt
    `).run({ ...rec, businessListJson: JSON.stringify(rec.businessList) })
  }
}
