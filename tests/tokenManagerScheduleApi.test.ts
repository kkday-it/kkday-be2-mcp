import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { TokenManager } from '../src/auth/tokenManager.js'
import type { AuthServiceClient } from '../src/auth/authServiceClient.js'

function setup(accessExpiresAt: number, refreshImpl: () => Promise<unknown>) {
  const db = openDb(':memory:')
  const identities = new IdentityStore(db)
  const credentials = new CredentialStore(db)
  identities.upsert({ identityId: 'id-1', userLabel: 'u', accessToken: 'old', refreshToken: 'r0',
    businessList: [], accessExpiresAt, updatedAt: 0 })
  const auth = { refresh: vi.fn(refreshImpl) } as unknown as AuthServiceClient
  const t = { v: 1_000_000 }
  const tm = new TokenManager({ identities, credentials }, auth, { now: () => t.v, skewMs: 60_000 })
  return { tm, identities, auth, t }
}
// 新 token 需可 decodeJwtExpMs——仿既有 tokenManager 測試的假 JWT 產法(header.payload{exp}.sig base64)。
const fakeJwt = (expMs: number) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(expMs / 1000) })}.x`
}

it('getFreshByIdentityId returns fresh context; unknown id → AuthError', async () => {
  const { tm } = setup(Number.MAX_SAFE_INTEGER, async () => { throw new Error('no refresh expected') })
  const u = await tm.getFreshByIdentityId('id-1')
  expect(u).toMatchObject({ identityId: 'id-1', accessToken: 'old' })
  await expect(tm.getFreshByIdentityId('nope')).rejects.toMatchObject({ code: 'UNKNOWN_IDENTITY' })
})

it('keepAlive refreshes only identities expiring within windowMs, and only when claim wins', async () => {
  const { tm, auth, t } = setup(1_000_000 + 30_000 /* 30s 內到期 */, async () =>
    ({ accessToken: fakeJwt(1_000_000 + 3_600_000), refreshToken: 'r1', businessList: [] }))
  const out1 = await tm.keepAlive(['id-1'], { windowMs: 60_000, claimTtlMs: 30_000 })
  expect(out1.refreshed).toEqual(['id-1'])
  // 第二次:claim 未過 TTL → 跳過(不重複 refresh)
  const out2 = await tm.keepAlive(['id-1'], { windowMs: 60_000, claimTtlMs: 30_000 })
  expect(out2.refreshed).toEqual([])
  expect(auth.refresh).toHaveBeenCalledTimes(1)
  // access 還很久才到期 → 不 refresh
  t.v += 40_000
  const out3 = await tm.keepAlive(['id-1'], { windowMs: 60_000, claimTtlMs: 30_000 })
  expect(out3.refreshed).toEqual([])
})

it('keepAlive reports terminal failures without throwing', async () => {
  const { tm } = setup(1_000_000 + 30_000, async () => {
    const { AuthError } = await import('../src/errors.js')
    throw new AuthError('AU9001', 'revoked', 401)
  })
  const out = await tm.keepAlive(['id-1'], { windowMs: 60_000, claimTtlMs: 30_000 })
  expect(out.refreshed).toEqual([])
  expect(out.failed).toEqual([{ identityId: 'id-1', code: 'REAUTH_REQUIRED', terminal: true }])
})

it('keepAlive force-refreshes inside windowMs even beyond tokenManager skew (no spin band)', async () => {
  // access 於 8min 後到期:> skew(5min) 但 < window(10min)——必須真的 refresh,不得空轉。
  const { tm, auth } = setup(1_000_000 + 8 * 60_000, async () =>
    ({ accessToken: fakeJwt(1_000_000 + 3_600_000), refreshToken: 'r1', businessList: [] }))
  const out = await tm.keepAlive(['id-1'], { windowMs: 10 * 60_000, claimTtlMs: 30_000 })
  expect(out.refreshed).toEqual(['id-1'])
  expect(auth.refresh).toHaveBeenCalledTimes(1)
})
