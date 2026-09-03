import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'

describe('OAuthStore', () => {
  it('client insert/get round-trip；redirect_uris 存成 JSON', async () => {
    const db = await openTestDb()
    const s = new OAuthStore(db)
    await s.insertClient({ clientId: 'c1', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], createdAt: 1 })
    expect(await s.getClient('c1')).toEqual({ clientId: 'c1', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], createdAt: 1 })
    expect(await s.getClient('nope')).toBeUndefined()
    await db.close()
  })

  it('auth code：只存 hash，get/consume 正常，未知 hash 回 undefined', async () => {
    const d = await openTestDb(); const s = new OAuthStore(d)
    await s.insertAuthCode({ codeHash: 'h1', clientId: 'c1', redirectUri: 'https://x/callback', codeChallenge: 'ch1', identityId: 'I1', exp: 100, consumed: 0 })
    expect(await s.getAuthCode('h1')).toMatchObject({ codeHash: 'h1', clientId: 'c1', identityId: 'I1', consumed: 0 })
    await s.consumeAuthCode('h1')
    expect((await s.getAuthCode('h1'))!.consumed).toBe(1)
    expect(await s.getAuthCode('missing')).toBeUndefined()
    // 明文絕不落地：DB 只查得到 hash 欄位，查不到任何原始 code
    const raw = (await d.query<{ code_hash: string }>('SELECT code_hash FROM oauth_auth_codes')).rows.map(r => r.code_hash)
    expect(raw).toEqual(['h1'])
    await d.close()
  })

  it('refresh：只存 hash，get/markConsumed/deleteByIdentity 正常', async () => {
    const d = await openTestDb(); const s = new OAuthStore(d)
    await s.insertRefresh({ refreshHash: 'r1', identityId: 'I1', clientId: 'c1', exp: 200, consumed: 0 })
    await s.insertRefresh({ refreshHash: 'r2', identityId: 'I1', clientId: 'c1', exp: 200, consumed: 0 })
    expect(await s.getRefresh('r1')).toMatchObject({ refreshHash: 'r1', identityId: 'I1', clientId: 'c1', consumed: 0 })
    await s.markRefreshConsumed('r1')
    expect((await s.getRefresh('r1'))!.consumed).toBe(1)
    // rotation 語意：consumed 標記而非刪除（供 Task 10 的 reuse 偵測 / family revoke）
    expect(await s.getRefresh('r1')).toBeDefined()
    await s.deleteRefreshByIdentity('I1')
    expect(await s.getRefresh('r1')).toBeUndefined()
    expect(await s.getRefresh('r2')).toBeUndefined()
    const raw = (await d.query<{ refresh_hash: string }>('SELECT refresh_hash FROM oauth_refresh')).rows.map(r => r.refresh_hash)
    expect(raw).toEqual([])
    await d.close()
  })
})
