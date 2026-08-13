import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { TokenStore } from '../src/store/tokenStore.js'
import { TokenManager } from '../src/auth/tokenManager.js'
import { AuthError } from '../src/errors.js'

function fakeJwt(expSec: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec })}.sig`
}
function seed() {
  const store = new TokenStore(openDb(':memory:'))
  const now = 1_000_000_000_000
  const hash = TokenStore.hashBearer('b1')
  store.upsert({ bearerHash: hash, userLabel: 'p@kkday.com', accessToken: fakeJwt(Math.floor((now + 30 * 60_000) / 1000)), refreshToken: 'r', businessList: [{ a: 1 }], accessExpiresAt: now + 30 * 60_000, updatedAt: now })
  return { store, hash, now }
}
describe('token-by-hash', () => {
  it('TokenStore.getByBearerHash returns the record', () => {
    const { store, hash } = seed()
    expect(store.getByBearerHash(hash)!.userLabel).toBe('p@kkday.com')
    expect(store.getByBearerHash('nope')).toBeUndefined()
  })
  it('TokenManager.getFreshByHash returns ctx without refresh when far from expiry', async () => {
    const { store, hash, now } = seed()
    const auth = { refresh: vi.fn() }
    const mgr = new TokenManager({ identities: store.identities, credentials: store.credentials }, auth as never, { now: () => now })
    const ctx = await mgr.getFreshByHash(hash)
    expect(ctx.userLabel).toBe('p@kkday.com')
    expect(ctx.businessList).toEqual([{ a: 1 }])
    expect(auth.refresh).not.toHaveBeenCalled()
  })
  it('unknown hash -> AuthError UNKNOWN_BEARER 401', async () => {
    const { store, now } = seed()
    const mgr = new TokenManager({ identities: store.identities, credentials: store.credentials }, { refresh: vi.fn() } as never, { now: () => now })
    await expect(mgr.getFreshByHash('nope')).rejects.toSatisfy((e: unknown) => e instanceof AuthError && e.code === 'UNKNOWN_BEARER')
  })
})
