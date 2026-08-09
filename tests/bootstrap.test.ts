import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { TokenStore } from '../src/store/tokenStore.js'
import { enrollUser, generateBearer } from '../src/auth/enroll.js'

function fakeJwt(expSec: number, extraClaims: Record<string, unknown> = {}): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec, ...extraClaims })}.sig`
}

describe('enroll', () => {
  it('generateBearer format + uniqueness', () => {
    const b = generateBearer()
    expect(b).toMatch(/^be2mcp_[0-9a-f]{48}$/)
    expect(generateBearer()).not.toBe(b)
  })
  it('enrolls via account+password: login -> exchange -> store, returns bearer that resolves', async () => {
    const store = new TokenStore(openDb(':memory:'))
    const jwt = fakeJwt(2_000_000_000)
    const auth = {
      login: vi.fn(async () => ({ authorizationCode: 'code-1' })),
      exchangeCode: vi.fn(async () => ({ accessToken: jwt, refreshToken: 'r1', businessList: [{ a: 1 }] })),
    }
    const { bearer } = await enrollUser({ store, auth: auth as never },
      { userLabel: 'pilot@kkday.com', account: 'pilot@kkday.com', password: 'pw' })
    expect(auth.login).toHaveBeenCalledWith('pilot@kkday.com', 'pw', { otp: undefined })
    const rec = store.getByBearer(bearer)!
    expect(rec.userLabel).toBe('pilot@kkday.com')
    expect(rec.accessToken).toBe(jwt)
    expect(rec.accessExpiresAt).toBe(2_000_000_000_000)
  })
  it('derives stored userLabel from the access token authKey claim, not the passed-in label, when authKey is present', async () => {
    const store = new TokenStore(openDb(':memory:'))
    const jwt = fakeJwt(2_000_000_000, { authKey: 'real.identity@kkday.com' })
    const auth = {
      login: vi.fn(async () => ({ authorizationCode: 'code-1' })),
      exchangeCode: vi.fn(async () => ({ accessToken: jwt, refreshToken: 'r1', businessList: [] })),
    }
    const { bearer } = await enrollUser({ store, auth: auth as never },
      { userLabel: 'label-passed-at-enroll-time@kkday.com', account: 'pilot@kkday.com', password: 'pw' })
    const rec = store.getByBearer(bearer)!
    expect(rec.userLabel).toBe('real.identity@kkday.com')
  })
  it('falls back to the passed-in userLabel when the token has no authKey claim', async () => {
    const store = new TokenStore(openDb(':memory:'))
    const jwt = fakeJwt(2_000_000_000)
    const auth = {
      login: vi.fn(async () => ({ authorizationCode: 'code-1' })),
      exchangeCode: vi.fn(async () => ({ accessToken: jwt, refreshToken: 'r1', businessList: [] })),
    }
    const { bearer } = await enrollUser({ store, auth: auth as never },
      { userLabel: 'fallback@kkday.com', account: 'pilot@kkday.com', password: 'pw' })
    expect(store.getByBearer(bearer)!.userLabel).toBe('fallback@kkday.com')
  })
  it('enrolls via pasted authorizationCode (browser fallback), skipping login', async () => {
    const store = new TokenStore(openDb(':memory:'))
    const auth = {
      login: vi.fn(),
      exchangeCode: vi.fn(async () => ({ accessToken: fakeJwt(2_000_000_000), refreshToken: 'r', businessList: [] })),
    }
    const { bearer } = await enrollUser({ store, auth: auth as never }, { userLabel: 'p@kkday.com', code: 'uuid-9' })
    expect(auth.login).not.toHaveBeenCalled()
    expect(auth.exchangeCode).toHaveBeenCalledWith('uuid-9')
    expect(store.getByBearer(bearer)).toBeDefined()
  })
})
