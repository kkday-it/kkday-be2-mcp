import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { TokenManager } from '../src/auth/tokenManager.js'

// helper：造一顆 exp=<ms> 的最小 JWT（header.payload.sig，base64url）
function makeJwt(expMs: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(expMs / 1000), authKey: 'u' })}.sig`
}

function setup(now: () => number, refresh: ReturnType<typeof vi.fn>) {
  const db = openDb(':memory:')
  const identities = new IdentityStore(db)
  const credentials = new CredentialStore(db)
  identities.upsert({ identityId: 'I1', userLabel: 'u', accessToken: 'OLD', refreshToken: 'R1', businessList: [], accessExpiresAt: 0, updatedAt: 0 })
  credentials.insert({ credHash: CredentialStore.hash('tokA'), identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 0 })
  credentials.insert({ credHash: CredentialStore.hash('sidB'), identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 0 })
  const auth = { refresh } as never
  const tm = new TokenManager({ identities, credentials }, auth, { now, skewMs: 60_000 })
  return { tm, identities }
}

describe('TokenManager — identity-scoped refresh', () => {
  it('兩 credential 指向同 identity：refresh 只呼叫一次、兩者都拿到新鮮 token', async () => {
    const t = 1_000_000
    const refresh = vi.fn().mockResolvedValue({ accessToken: makeJwt(t + 3_600_000), refreshToken: 'R2', businessList: [] })
    const { tm } = setup(() => t, refresh)
    const a = await tm.getFreshBySecret('tokA') // 觸發 refresh（過期，identity accessExpiresAt=0）
    const b = await tm.getFreshBySecret('sidB') // 同 identity，已刷新，不再 refresh
    expect(a.accessToken).toBe(b.accessToken) // 同一份新鮮 token
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('未知 secret → UNKNOWN_BEARER 401', async () => {
    const { tm } = setup(() => 0, vi.fn())
    await expect(tm.getFreshBySecret('nope')).rejects.toMatchObject({ status: 401 })
  })

  it('getFreshByCredHash 對已知 credHash 行為與 getFreshBySecret 一致', async () => {
    const t = 1_000_000
    const refresh = vi.fn().mockResolvedValue({ accessToken: makeJwt(t + 3_600_000), refreshToken: 'R2', businessList: [] })
    const { tm } = setup(() => t, refresh)
    const byHash = await tm.getFreshByCredHash(CredentialStore.hash('tokA'))
    const bySecret = await tm.getFreshBySecret('tokA')
    expect(byHash.accessToken).toBe(bySecret.accessToken)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
