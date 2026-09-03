import { describe, it, expect, vi } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { TokenManager } from '../src/auth/tokenManager.js'

// helper：造一顆 exp=<ms> 的最小 JWT（header.payload.sig，base64url）
function makeJwt(expMs: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(expMs / 1000), authKey: 'u' })}.sig`
}

async function setup(now: () => number, refresh: ReturnType<typeof vi.fn>) {
  const db = await openTestDb()
  const identities = new IdentityStore(db)
  const credentials = new CredentialStore(db)
  await identities.upsert({ identityId: 'I1', userLabel: 'u', accessToken: 'OLD', refreshToken: 'R1', businessList: [], accessExpiresAt: 0, updatedAt: 0 })
  await credentials.insert({ credHash: CredentialStore.hash('tokA'), identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 0 })
  await credentials.insert({ credHash: CredentialStore.hash('sidB'), identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 0 })
  const auth = { refresh } as never
  const tm = new TokenManager({ identities, credentials }, auth, { now, skewMs: 60_000 })
  return { tm, identities }
}

describe('TokenManager — identity-scoped refresh', () => {
  it('兩 credential 指向同 identity：refresh 只呼叫一次、兩者都拿到新鮮 token', async () => {
    const t = 1_000_000
    const refresh = vi.fn().mockResolvedValue({ accessToken: makeJwt(t + 3_600_000), refreshToken: 'R2', businessList: [] })
    const { tm } = await setup(() => t, refresh)
    const a = await tm.getFreshBySecret('tokA') // 觸發 refresh（過期，identity accessExpiresAt=0）
    const b = await tm.getFreshBySecret('sidB') // 同 identity，已刷新，不再 refresh
    expect(a.accessToken).toBe(b.accessToken) // 同一份新鮮 token
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('兩 credential 併發觸發同 identity refresh：single-flight 真的只跑一次（非序列假象）', async () => {
    // 與上面那則序列版不同：這裡用 Promise.all 真正併發送出兩個請求。序列版的問題是
    // 第一個 await 完成時 identity 已刷新，第二個呼叫根本不會再進 refresh 分支，
    // 就算 single-flight 誤 key 成 credential（而非 identityId）也會綠燈、抓不到問題。
    // 併發送出時，兩者都會在「identity 仍是過期舊值」的當下同時判斷需要 refresh、
    // 同時查 in-flight map——這才是真正會撞上 be2 refresh-token rotation 的情境，
    // 也才能證明 single-flight 是以 identityId 為 key（而非各自的 credHash）。
    const t = 1_000_000
    let calls = 0
    const refresh = vi.fn(async (_rt: string) => {
      calls++
      await new Promise(r => setTimeout(r, 10)) // 讓兩邊都卡在 in-flight 期間，逼真重疊
      return { accessToken: makeJwt(t + 3_600_000), refreshToken: `r-${calls}`, businessList: [] }
    })
    const { tm } = await setup(() => t, refresh)
    const [a, b] = await Promise.all([
      tm.getFreshBySecret('tokA'),
      tm.getFreshBySecret('sidB'),
    ])
    expect(refresh).toHaveBeenCalledTimes(1) // 若誤 key 成 credential，這裡會是 2
    expect(a.accessToken).toBe(b.accessToken)
  })

  it('未知 secret → UNKNOWN_BEARER 401', async () => {
    const { tm } = await setup(() => 0, vi.fn())
    await expect(tm.getFreshBySecret('nope')).rejects.toMatchObject({ status: 401 })
  })

  it('getFreshByCredHash 對已知 credHash 行為與 getFreshBySecret 一致', async () => {
    const t = 1_000_000
    const refresh = vi.fn().mockResolvedValue({ accessToken: makeJwt(t + 3_600_000), refreshToken: 'R2', businessList: [] })
    const { tm } = await setup(() => t, refresh)
    const byHash = await tm.getFreshByCredHash(CredentialStore.hash('tokA'))
    const bySecret = await tm.getFreshBySecret('tokA')
    expect(byHash.accessToken).toBe(bySecret.accessToken)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
