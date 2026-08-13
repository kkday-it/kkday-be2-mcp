import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'

function db() { return openDb(':memory:') }

describe('OAuthStore', () => {
  it('client insert/get round-trip；redirect_uris 存成 JSON', () => {
    const s = new OAuthStore(db())
    s.insertClient({ clientId: 'c1', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], createdAt: 1 })
    expect(s.getClient('c1')).toEqual({ clientId: 'c1', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], createdAt: 1 })
    expect(s.getClient('nope')).toBeUndefined()
  })

  it('auth code：只存 hash，get/consume 正常，未知 hash 回 undefined', () => {
    const d = db(); const s = new OAuthStore(d)
    s.insertAuthCode({ codeHash: 'h1', clientId: 'c1', redirectUri: 'https://x/callback', codeChallenge: 'ch1', identityId: 'I1', exp: 100, consumed: 0 })
    expect(s.getAuthCode('h1')).toMatchObject({ codeHash: 'h1', clientId: 'c1', identityId: 'I1', consumed: 0 })
    s.consumeAuthCode('h1')
    expect(s.getAuthCode('h1')!.consumed).toBe(1)
    expect(s.getAuthCode('missing')).toBeUndefined()
    // 明文絕不落地：DB 只查得到 hash 欄位，查不到任何原始 code
    const raw = (d.prepare('SELECT code_hash FROM oauth_auth_codes').all() as { code_hash: string }[]).map(r => r.code_hash)
    expect(raw).toEqual(['h1'])
  })

  it('refresh：只存 hash，get/markConsumed/deleteByIdentity 正常', () => {
    const d = db(); const s = new OAuthStore(d)
    s.insertRefresh({ refreshHash: 'r1', identityId: 'I1', clientId: 'c1', exp: 200, consumed: 0 })
    s.insertRefresh({ refreshHash: 'r2', identityId: 'I1', clientId: 'c1', exp: 200, consumed: 0 })
    expect(s.getRefresh('r1')).toMatchObject({ refreshHash: 'r1', identityId: 'I1', clientId: 'c1', consumed: 0 })
    s.markRefreshConsumed('r1')
    expect(s.getRefresh('r1')!.consumed).toBe(1)
    // rotation 語意：consumed 標記而非刪除（供 Task 10 的 reuse 偵測 / family revoke）
    expect(s.getRefresh('r1')).toBeDefined()
    s.deleteRefreshByIdentity('I1')
    expect(s.getRefresh('r1')).toBeUndefined()
    expect(s.getRefresh('r2')).toBeUndefined()
    const raw = (d.prepare('SELECT refresh_hash FROM oauth_refresh').all() as { refresh_hash: string }[]).map(r => r.refresh_hash)
    expect(raw).toEqual([])
  })
})
