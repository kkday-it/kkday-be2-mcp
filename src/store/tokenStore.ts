import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { IdentityStore, type Identity } from './identityStore.js'
import { CredentialStore } from './credentialStore.js'

export interface TokenRecord {
  bearerHash: string
  userLabel: string
  accessToken: string
  refreshToken: string
  businessList: unknown[]
  accessExpiresAt: number
  updatedAt: number
}

// 相容 adapter：對外維持 Phase 1a/2a/2b 既有的扁平 TokenRecord API（class 名 / 方法簽章
// 全部不變），內部改架在 IdentityStore + CredentialStore 之上——一個 bearerHash 對映一個
// identity，行為與舊的「扁平 user_tokens 表」模型完全等價，所以既有呼叫端
// （app.ts、confirmRoutes.ts、ssoRoutes.ts、toolPipeline.ts、appPipeline.ts、enroll.ts 及其
// 對應測試）在 Task 2–4 期間零改動仍綠。identities/credentials 兩個 store 只是 db 的薄包裝
// （無內部狀態），故建構子仍只收單一 `db`，內部直接 new 兩份指向同一個 db 即可，不必變更
// 建構子簽章、也不必動前述任何呼叫端。
export class TokenStore {
  readonly identities: IdentityStore
  readonly credentials: CredentialStore

  constructor(private db: Database.Database) {
    this.identities = new IdentityStore(db)
    this.credentials = new CredentialStore(db)
  }

  static hashBearer(bearer: string): string {
    return createHash('sha256').update(bearer).digest('hex')
  }

  getByBearer(bearer: string): TokenRecord | undefined {
    return this.getByBearerHash(TokenStore.hashBearer(bearer))
  }

  getByBearerHash(hash: string): TokenRecord | undefined {
    const cred = this.credentials.get(hash)
    if (!cred) return undefined
    const identity = this.identities.get(cred.identityId)
    if (!identity) return undefined
    return this.toRecord(hash, identity)
  }

  private toRecord(bearerHash: string, identity: Identity): TokenRecord {
    return {
      bearerHash,
      userLabel: identity.userLabel,
      accessToken: identity.accessToken,
      refreshToken: identity.refreshToken,
      businessList: identity.businessList,
      accessExpiresAt: identity.accessExpiresAt,
      updatedAt: identity.updatedAt,
    }
  }

  // Phase 2b fix: web-session teardown (logout / idle-expiry / dead-session) must purge the be2
  // access+refresh token it owns — otherwise the row lives on in user_tokens forever, at rest,
  // with no session left that can ever reach it. Wired via WebSessionStore's onDelete callback
  // (src/server/webSessionStore.ts, src/server/app.ts) so every session-removal path cleans up.
  // adapter 語意：只砍這一個 credential；identity 只有在「沒有任何 credential 再引用它」
  // 時才一併刪除（同一 identity 可能還有別的 credential，如 web_session + static_bearer 並存）。
  deleteByBearerHash(hash: string): void {
    const cred = this.credentials.get(hash)
    if (!cred) return
    this.credentials.delete(hash)
    if (this.credentials.countByIdentity(cred.identityId) === 0) {
      this.identities.delete(cred.identityId)
    }
  }

  upsert(rec: TokenRecord): void {
    const existing = this.credentials.get(rec.bearerHash)
    const identityId = existing ? existing.identityId : randomUUID()
    this.identities.upsert({
      identityId,
      userLabel: rec.userLabel,
      accessToken: rec.accessToken,
      refreshToken: rec.refreshToken,
      businessList: rec.businessList,
      accessExpiresAt: rec.accessExpiresAt,
      updatedAt: rec.updatedAt,
    })
    if (!existing) {
      this.credentials.insert({
        credHash: rec.bearerHash,
        identityId,
        kind: 'static_bearer',
        expiresAt: null,
        updatedAt: rec.updatedAt,
      })
    }
  }
}
