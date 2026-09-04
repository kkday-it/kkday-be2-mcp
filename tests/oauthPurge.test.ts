import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { runOAuthPurge } from '../scripts/oauth-purge.js'

// Task 11：oauth-purge 的核心邏輯測試。只驗證「刪過期/孤兒」與「保留活的」兩件事，
// 不碰 script 本身的 CLI/console 輸出（那只是薄殼）。

async function seedIdentity(identities: IdentityStore, id: string) {
  await identities.upsert({ identityId: id, userLabel: `label-${id}`, accessToken: 'a', refreshToken: 'r', businessList: [], accessExpiresAt: 9_999_999_999, updatedAt: 1 })
}

describe('runOAuthPurge', () => {
  it('刪過期 auth code；保留未過期的', async () => {
    const db = await openTestDb()
    const oauth = new OAuthStore(db)
    await oauth.insertAuthCode({ codeHash: 'expired', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I1', exp: 1000, consumed: 0 })
    await oauth.insertAuthCode({ codeHash: 'alive', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I1', exp: 9_999_999_999, consumed: 0 })

    const now = 5000
    const result = await runOAuthPurge(db, now)

    expect(result.expiredAuthCodes).toBe(1)
    expect(await oauth.getAuthCode('expired')).toBeUndefined()
    expect(await oauth.getAuthCode('alive')).toBeDefined()
  })

  it('刪過期 refresh；保留未過期者（含 consumed-but-unexpired，仍需供 reuse 偵測）', async () => {
    const db = await openTestDb()
    const oauth = new OAuthStore(db)
    await oauth.insertRefresh({ refreshHash: 'expired-unconsumed', identityId: 'I1', clientId: 'c1', exp: 1000, consumed: 0 })
    await oauth.insertRefresh({ refreshHash: 'expired-consumed', identityId: 'I1', clientId: 'c1', exp: 1000, consumed: 1 })
    await oauth.insertRefresh({ refreshHash: 'alive-consumed', identityId: 'I1', clientId: 'c1', exp: 9_999_999_999, consumed: 1 })
    await oauth.insertRefresh({ refreshHash: 'alive-unconsumed', identityId: 'I1', clientId: 'c1', exp: 9_999_999_999, consumed: 0 })

    const now = 5000
    const result = await runOAuthPurge(db, now)

    expect(result.expiredRefresh).toBe(2)
    expect(await oauth.getRefresh('expired-unconsumed')).toBeUndefined()
    expect(await oauth.getRefresh('expired-consumed')).toBeUndefined()
    // 保留：未過期，即使已 consumed —— reuse-detection 要靠它存在才能判斷「這顆已經被用過一次」。
    expect(await oauth.getRefresh('alive-consumed')).toBeDefined()
    expect(await oauth.getRefresh('alive-unconsumed')).toBeDefined()
  })

  it('刪無 credential 引用的 ghost identity（family-revoke 孤兒）；保留仍被 credential 引用的 identity', async () => {
    const db = await openTestDb()
    const identities = new IdentityStore(db)
    const credentials = new CredentialStore(db)
    await seedIdentity(identities, 'ghost')
    await seedIdentity(identities, 'alive')
    // 只有 alive 仍被一張 credential 引用；ghost 完全沒有任何 credential 指向它
    // （典型成因：Task 10 的 refresh-reuse family revoke 砍光了某 identity 底下所有 oauth_access
    // credential，identity 列本身卻沒人清，變成一筆仍存有真實 be2 access/refresh token 的孤兒列）。
    await credentials.insert({ credHash: CredentialStore.hash('secretForAlive'), identityId: 'alive', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })

    const result = await runOAuthPurge(db, 5000)

    expect(result.ghostIdentities).toBe(1)
    expect(await identities.get('ghost')).toBeUndefined()
    expect(await identities.get('alive')).toBeDefined()
  })

  it('non-vacuous：混合資料下同時清過期 code/refresh/ghost identity，且保留所有活資料', async () => {
    const db = await openTestDb()
    const oauth = new OAuthStore(db)
    const identities = new IdentityStore(db)
    const credentials = new CredentialStore(db)

    await seedIdentity(identities, 'I-alive')
    await seedIdentity(identities, 'I-ghost')
    await credentials.insert({ credHash: CredentialStore.hash('secret'), identityId: 'I-alive', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })

    await oauth.insertAuthCode({ codeHash: 'code-expired', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I-alive', exp: 100, consumed: 1 })
    await oauth.insertAuthCode({ codeHash: 'code-alive', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I-alive', exp: 9_999_999_999, consumed: 0 })
    await oauth.insertRefresh({ refreshHash: 'refresh-expired', identityId: 'I-alive', clientId: 'c1', exp: 100, consumed: 0 })
    await oauth.insertRefresh({ refreshHash: 'refresh-alive', identityId: 'I-alive', clientId: 'c1', exp: 9_999_999_999, consumed: 1 })

    const now = 5000
    const result = await runOAuthPurge(db, now)

    expect(result).toEqual({ expiredAuthCodes: 1, expiredRefresh: 1, ghostIdentities: 1 })
    expect(await oauth.getAuthCode('code-expired')).toBeUndefined()
    expect(await oauth.getAuthCode('code-alive')).toBeDefined()
    expect(await oauth.getRefresh('refresh-expired')).toBeUndefined()
    expect(await oauth.getRefresh('refresh-alive')).toBeDefined()
    expect(await identities.get('I-ghost')).toBeUndefined()
    expect(await identities.get('I-alive')).toBeDefined()
  })

  it('冪等：連跑兩次第二次不再有東西可刪', async () => {
    const db = await openTestDb()
    const oauth = new OAuthStore(db)
    await oauth.insertAuthCode({ codeHash: 'expired', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I1', exp: 100, consumed: 0 })

    await runOAuthPurge(db, 5000)
    const second = await runOAuthPurge(db, 5000)

    expect(second).toEqual({ expiredAuthCodes: 0, expiredRefresh: 0, ghostIdentities: 0 })
  })

  it('保護 scheduled change-set 引用的 ghost identity，轉 cancelled 後再 purge 會清', async () => {
    const db = await openTestDb()
    const identities = new IdentityStore(db)
    await seedIdentity(identities, 'scheduled-ghost')

    await db.query(`
      INSERT INTO change_sets (id, creator_label, creator_bearer_hash, session_id, action_type, items_json, diff_json, diff_version, status, created_at, executor_identity_id)
      VALUES ($1, 'u', 'h', 's', 't', '[]', '{}', 'v1', 'scheduled', 1, $2)
    `, ['cs1', 'scheduled-ghost'])

    // 第一次：雖然無 credential，但被 scheduled 的 executor 引用 → 不能清
    const result1 = await runOAuthPurge(db, 5000)
    expect(result1.ghostIdentities).toBe(0)
    expect(await identities.get('scheduled-ghost')).toBeDefined()

    // 轉 cancelled
    await db.query("UPDATE change_sets SET status = 'cancelled' WHERE id = 'cs1'")

    // 第二次：已經不是 scheduled → 被清
    const result2 = await runOAuthPurge(db, 5000)
    expect(result2.ghostIdentities).toBe(1)
    expect(await identities.get('scheduled-ghost')).toBeUndefined()
  })

  it('保護 claim 後短暫處於 approved(execute_at_utc 非 null) 的 ghost identity（I-1）', async () => {
    const db = await openTestDb()
    const identities = new IdentityStore(db)
    await seedIdentity(identities, 'claimed-ghost')

    await db.query(`
      INSERT INTO change_sets (id, creator_label, creator_bearer_hash, session_id, action_type, items_json, diff_json, diff_version, status, created_at, executor_identity_id, execute_at_utc)
      VALUES ($1, 'u', 'h', 's', 't', '[]', '{}', 'v1', 'scheduled', 1, $2, 9999999999)
    `, ['cs2', 'claimed-ghost'])

    // 排程件被 claim 後短暫進入 approved（execute_at_utc 仍非 null）——此窗內 purge 不能清
    await db.query("UPDATE change_sets SET status = 'approved' WHERE id = 'cs2'")

    const result = await runOAuthPurge(db, 5000)
    expect(result.ghostIdentities).toBe(0)
    expect(await identities.get('claimed-ghost')).toBeDefined()

    // 執行完轉 done 後（execute_at_utc 仍非 null，但 status 已非 scheduled/approved-with-null-check-passing case）
    // 一旦真的不再是 scheduled 或「approved 且 execute_at_utc 非 null」的組合，就會被清
    await db.query("UPDATE change_sets SET status = 'done' WHERE id = 'cs2'")
    const result2 = await runOAuthPurge(db, 5000)
    expect(result2.ghostIdentities).toBe(1)
    expect(await identities.get('claimed-ghost')).toBeUndefined()
  })
})
