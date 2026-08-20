import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { runOAuthPurge } from '../scripts/oauth-purge.js'

// Task 11：oauth-purge 的核心邏輯測試。只驗證「刪過期/孤兒」與「保留活的」兩件事，
// 不碰 script 本身的 CLI/console 輸出（那只是薄殼）。

function seedIdentity(identities: IdentityStore, id: string) {
  identities.upsert({ identityId: id, userLabel: `label-${id}`, accessToken: 'a', refreshToken: 'r', businessList: [], accessExpiresAt: 9_999_999_999, updatedAt: 1 })
}

describe('runOAuthPurge', () => {
  it('刪過期 auth code；保留未過期的', () => {
    const db = openDb(':memory:')
    const oauth = new OAuthStore(db)
    oauth.insertAuthCode({ codeHash: 'expired', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I1', exp: 1000, consumed: 0 })
    oauth.insertAuthCode({ codeHash: 'alive', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I1', exp: 9_999_999_999, consumed: 0 })

    const now = 5000
    const result = runOAuthPurge(db, now)

    expect(result.expiredAuthCodes).toBe(1)
    expect(oauth.getAuthCode('expired')).toBeUndefined()
    expect(oauth.getAuthCode('alive')).toBeDefined()
  })

  it('刪過期 refresh；保留未過期者（含 consumed-but-unexpired，仍需供 reuse 偵測）', () => {
    const db = openDb(':memory:')
    const oauth = new OAuthStore(db)
    oauth.insertRefresh({ refreshHash: 'expired-unconsumed', identityId: 'I1', clientId: 'c1', exp: 1000, consumed: 0 })
    oauth.insertRefresh({ refreshHash: 'expired-consumed', identityId: 'I1', clientId: 'c1', exp: 1000, consumed: 1 })
    oauth.insertRefresh({ refreshHash: 'alive-consumed', identityId: 'I1', clientId: 'c1', exp: 9_999_999_999, consumed: 1 })
    oauth.insertRefresh({ refreshHash: 'alive-unconsumed', identityId: 'I1', clientId: 'c1', exp: 9_999_999_999, consumed: 0 })

    const now = 5000
    const result = runOAuthPurge(db, now)

    expect(result.expiredRefresh).toBe(2)
    expect(oauth.getRefresh('expired-unconsumed')).toBeUndefined()
    expect(oauth.getRefresh('expired-consumed')).toBeUndefined()
    // 保留：未過期，即使已 consumed —— reuse-detection 要靠它存在才能判斷「這顆已經被用過一次」。
    expect(oauth.getRefresh('alive-consumed')).toBeDefined()
    expect(oauth.getRefresh('alive-unconsumed')).toBeDefined()
  })

  it('刪無 credential 引用的 ghost identity（family-revoke 孤兒）；保留仍被 credential 引用的 identity', () => {
    const db = openDb(':memory:')
    const identities = new IdentityStore(db)
    const credentials = new CredentialStore(db)
    seedIdentity(identities, 'ghost')
    seedIdentity(identities, 'alive')
    // 只有 alive 仍被一張 credential 引用；ghost 完全沒有任何 credential 指向它
    // （典型成因：Task 10 的 refresh-reuse family revoke 砍光了某 identity 底下所有 oauth_access
    // credential，identity 列本身卻沒人清，變成一筆仍存有真實 be2 access/refresh token 的孤兒列）。
    credentials.insert({ credHash: CredentialStore.hash('secretForAlive'), identityId: 'alive', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })

    const result = runOAuthPurge(db, 5000)

    expect(result.ghostIdentities).toBe(1)
    expect(identities.get('ghost')).toBeUndefined()
    expect(identities.get('alive')).toBeDefined()
  })

  it('non-vacuous：混合資料下同時清過期 code/refresh/ghost identity，且保留所有活資料', () => {
    const db = openDb(':memory:')
    const oauth = new OAuthStore(db)
    const identities = new IdentityStore(db)
    const credentials = new CredentialStore(db)

    seedIdentity(identities, 'I-alive')
    seedIdentity(identities, 'I-ghost')
    credentials.insert({ credHash: CredentialStore.hash('secret'), identityId: 'I-alive', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })

    oauth.insertAuthCode({ codeHash: 'code-expired', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I-alive', exp: 100, consumed: 1 })
    oauth.insertAuthCode({ codeHash: 'code-alive', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I-alive', exp: 9_999_999_999, consumed: 0 })
    oauth.insertRefresh({ refreshHash: 'refresh-expired', identityId: 'I-alive', clientId: 'c1', exp: 100, consumed: 0 })
    oauth.insertRefresh({ refreshHash: 'refresh-alive', identityId: 'I-alive', clientId: 'c1', exp: 9_999_999_999, consumed: 1 })

    const now = 5000
    const result = runOAuthPurge(db, now)

    expect(result).toEqual({ expiredAuthCodes: 1, expiredRefresh: 1, ghostIdentities: 1 })
    expect(oauth.getAuthCode('code-expired')).toBeUndefined()
    expect(oauth.getAuthCode('code-alive')).toBeDefined()
    expect(oauth.getRefresh('refresh-expired')).toBeUndefined()
    expect(oauth.getRefresh('refresh-alive')).toBeDefined()
    expect(identities.get('I-ghost')).toBeUndefined()
    expect(identities.get('I-alive')).toBeDefined()
  })

  it('冪等：連跑兩次第二次不再有東西可刪', () => {
    const db = openDb(':memory:')
    const oauth = new OAuthStore(db)
    oauth.insertAuthCode({ codeHash: 'expired', clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', identityId: 'I1', exp: 100, consumed: 0 })

    runOAuthPurge(db, 5000)
    const second = runOAuthPurge(db, 5000)

    expect(second).toEqual({ expiredAuthCodes: 0, expiredRefresh: 0, ghostIdentities: 0 })
  })

  it('保護 scheduled change-set 引用的 ghost identity，轉 cancelled 後再 purge 會清', () => {
    const db = openDb(':memory:')
    const identities = new IdentityStore(db)
    seedIdentity(identities, 'scheduled-ghost')

    db.prepare(`
      INSERT INTO change_sets (id, creator_label, creator_bearer_hash, session_id, action_type, items_json, diff_json, diff_version, status, created_at, executor_identity_id)
      VALUES (?, 'u', 'h', 's', 't', '[]', '{}', 'v1', 'scheduled', 1, ?)
    `).run('cs1', 'scheduled-ghost')

    // 第一次：雖然無 credential，但被 scheduled 的 executor 引用 → 不能清
    const result1 = runOAuthPurge(db, 5000)
    expect(result1.ghostIdentities).toBe(0)
    expect(identities.get('scheduled-ghost')).toBeDefined()

    // 轉 cancelled
    db.prepare("UPDATE change_sets SET status = 'cancelled' WHERE id = 'cs1'").run()

    // 第二次：已經不是 scheduled → 被清
    const result2 = runOAuthPurge(db, 5000)
    expect(result2.ghostIdentities).toBe(1)
    expect(identities.get('scheduled-ghost')).toBeUndefined()
  })
})
