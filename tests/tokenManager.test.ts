import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { TokenStore } from '../src/store/tokenStore.js'
import { TokenManager } from '../src/auth/tokenManager.js'
import { AppError, AuthError } from '../src/errors.js'

function fakeJwt(expSec: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec })}.sig`
}

function setup(expiresInMs: number) {
  const store = new TokenStore(openDb(':memory:'))
  const now = 1_000_000_000_000
  store.upsert({
    bearerHash: TokenStore.hashBearer('b1'), userLabel: 'pilot@kkday.com',
    accessToken: 'old-access', refreshToken: 'old-refresh', businessList: [],
    accessExpiresAt: now + expiresInMs, updatedAt: now,
  })
  const freshJwt = fakeJwt(Math.floor((now + 50 * 60_000) / 1000))
  let calls = 0
  const auth = {
    refresh: vi.fn(async (_rt: string) => {
      calls++
      await new Promise(r => setTimeout(r, 10)) // let concurrency pile up
      return { accessToken: freshJwt, refreshToken: `r-${calls}`, businessList: [{ fresh: true }] }
    }),
  }
  const mgr = new TokenManager(store, auth as never, { now: () => now })
  return { mgr, store, auth, freshJwt }
}

describe('TokenManager', () => {
  it('returns stored token when far from expiry, without refreshing', async () => {
    const { mgr, auth } = setup(30 * 60_000)
    const ctx = await mgr.getFreshAccessToken('b1')
    expect(ctx.accessToken).toBe('old-access')
    expect(auth.refresh).not.toHaveBeenCalled()
  })
  it('refreshes when within skew, persists rotated tokens + fresh businessList', async () => {
    const { mgr, store, auth, freshJwt } = setup(60_000) // 1min left < 5min skew
    const ctx = await mgr.getFreshAccessToken('b1')
    expect(auth.refresh).toHaveBeenCalledWith('old-refresh')
    expect(ctx.accessToken).toBe(freshJwt)
    const rec = store.getByBearer('b1')!
    expect(rec.refreshToken).toBe('r-1')
    expect(rec.businessList).toEqual([{ fresh: true }])
  })
  it('single-flight: 5 concurrent calls -> exactly 1 refresh', async () => {
    const { mgr, auth } = setup(60_000)
    const results = await Promise.all(Array.from({ length: 5 }, () => mgr.getFreshAccessToken('b1')))
    expect(auth.refresh).toHaveBeenCalledTimes(1)
    expect(new Set(results.map(r => r.accessToken)).size).toBe(1)
  })
  it('unknown bearer -> AuthError UNKNOWN_BEARER 401', async () => {
    const { mgr } = setup(0)
    await expect(mgr.getFreshAccessToken('nope')).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === 'UNKNOWN_BEARER' && e.status === 401)
  })
  it('definitive 4xx refresh rejection -> AuthError REAUTH_REQUIRED 401', async () => {
    const { mgr, auth } = setup(60_000)
    auth.refresh.mockRejectedValueOnce(new AuthError('ENTRY_TOKEN_IS_EXPIRED', 'expired', 401))
    await expect(mgr.getFreshAccessToken('b1')).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === 'REAUTH_REQUIRED')
  })
  it('transient refresh failure with still-valid token -> serves stored token, no throw', async () => {
    const { mgr, auth } = setup(60_000) // 1min left: inside skew but NOT expired
    auth.refresh.mockRejectedValueOnce(new TypeError('fetch failed'))
    const ctx = await mgr.getFreshAccessToken('b1')
    expect(ctx.accessToken).toBe('old-access')
  })
  it('transient refresh failure with expired token -> 503 AUTH_SERVICE_UNAVAILABLE (not REAUTH_REQUIRED)', async () => {
    const { mgr, auth } = setup(-1) // already expired
    auth.refresh.mockRejectedValueOnce(new AuthError('HTTP_503', 'upstream down', 503))
    await expect(mgr.getFreshAccessToken('b1')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'AUTH_SERVICE_UNAVAILABLE' && e.status === 503)
  })
})
