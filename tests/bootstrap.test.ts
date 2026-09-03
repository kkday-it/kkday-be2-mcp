import { describe, it, expect, vi } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { enrollUser, generateBearer } from '../src/auth/enroll.js'

function fakeJwt(expSec: number, extraClaims: Record<string, unknown> = {}): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec, ...extraClaims })}.sig`
}

async function makeDeps() {
  const db = await openTestDb()
  return { identities: new IdentityStore(db), credentials: new CredentialStore(db) }
}

describe('enroll', () => {
  it('generateBearer format + uniqueness', () => {
    const b = generateBearer()
    expect(b).toMatch(/^be2mcp_[0-9a-f]{48}$/)
    expect(generateBearer()).not.toBe(b)
  })

  it('enroll 建 identity + static_bearer credential 指向它', async () => {
    const { identities, credentials } = await makeDeps()
    const auth = {
      exchangeCode: async () => ({ accessToken: fakeJwt(2_000_000_000), refreshToken: 'R', businessList: [] }),
    } as never
    const { bearer } = await enrollUser({ identities, credentials, auth }, { userLabel: 'u', code: 'C' }, () => 1)
    const cred = (await credentials.getBySecret(bearer))!
    expect(cred.kind).toBe('static_bearer')
    expect(await identities.get(cred.identityId)).toMatchObject({ refreshToken: 'R' })
  })

  it('enrolls via account+password: login -> exchange -> store, returns bearer that resolves', async () => {
    const { identities, credentials } = await makeDeps()
    const jwt = fakeJwt(2_000_000_000)
    const auth = {
      login: vi.fn(async () => ({ authorizationCode: 'code-1' })),
      exchangeCode: vi.fn(async () => ({ accessToken: jwt, refreshToken: 'r1', businessList: [{ a: 1 }] })),
    }
    const { bearer } = await enrollUser({ identities, credentials, auth: auth as never },
      { userLabel: 'pilot@kkday.com', account: 'pilot@kkday.com', password: 'pw' })
    expect(auth.login).toHaveBeenCalledWith('pilot@kkday.com', 'pw', { otp: undefined })
    const cred = (await credentials.getBySecret(bearer))!
    expect(cred.kind).toBe('static_bearer')
    const identity = (await identities.get(cred.identityId))!
    expect(identity.userLabel).toBe('pilot@kkday.com')
    expect(identity.accessToken).toBe(jwt)
    expect(identity.accessExpiresAt).toBe(2_000_000_000_000)
  })

  it('derives stored userLabel from the access token authKey claim, not the passed-in label, when authKey is present', async () => {
    const { identities, credentials } = await makeDeps()
    const jwt = fakeJwt(2_000_000_000, { authKey: 'real.identity@kkday.com' })
    const auth = {
      login: vi.fn(async () => ({ authorizationCode: 'code-1' })),
      exchangeCode: vi.fn(async () => ({ accessToken: jwt, refreshToken: 'r1', businessList: [] })),
    }
    const { bearer } = await enrollUser({ identities, credentials, auth: auth as never },
      { userLabel: 'label-passed-at-enroll-time@kkday.com', account: 'pilot@kkday.com', password: 'pw' })
    const cred = (await credentials.getBySecret(bearer))!
    expect((await identities.get(cred.identityId))!.userLabel).toBe('real.identity@kkday.com')
  })

  it('falls back to the passed-in userLabel when the token has no authKey claim', async () => {
    const { identities, credentials } = await makeDeps()
    const jwt = fakeJwt(2_000_000_000)
    const auth = {
      login: vi.fn(async () => ({ authorizationCode: 'code-1' })),
      exchangeCode: vi.fn(async () => ({ accessToken: jwt, refreshToken: 'r1', businessList: [] })),
    }
    const { bearer } = await enrollUser({ identities, credentials, auth: auth as never },
      { userLabel: 'fallback@kkday.com', account: 'pilot@kkday.com', password: 'pw' })
    const cred = (await credentials.getBySecret(bearer))!
    expect((await identities.get(cred.identityId))!.userLabel).toBe('fallback@kkday.com')
  })

  it('enrolls via pasted authorizationCode (browser fallback), skipping login', async () => {
    const { identities, credentials } = await makeDeps()
    const auth = {
      login: vi.fn(),
      exchangeCode: vi.fn(async () => ({ accessToken: fakeJwt(2_000_000_000), refreshToken: 'r', businessList: [] })),
    }
    const { bearer } = await enrollUser({ identities, credentials, auth: auth as never }, { userLabel: 'p@kkday.com', code: 'uuid-9' })
    expect(auth.login).not.toHaveBeenCalled()
    expect(auth.exchangeCode).toHaveBeenCalledWith('uuid-9')
    expect(await credentials.getBySecret(bearer)).toBeDefined()
  })
})
