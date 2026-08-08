import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { TokenStore } from '../src/store/tokenStore.js'

function makeStore() {
  return new TokenStore(openDb(':memory:'))
}

describe('TokenStore', () => {
  it('round-trips a record via the raw bearer', () => {
    const s = makeStore()
    const rec = {
      bearerHash: TokenStore.hashBearer('be2mcp_abc'),
      userLabel: 'pilot@kkday.com',
      accessToken: 'fake-jwt', refreshToken: 'fake-refresh',
      businessList: [{ action: 'x' }],
      accessExpiresAt: 1000, updatedAt: 1,
    }
    s.upsert(rec)
    const got = s.getByBearer('be2mcp_abc')
    expect(got).toMatchObject({ userLabel: 'pilot@kkday.com', accessToken: 'fake-jwt' })
    expect(got!.businessList).toEqual([{ action: 'x' }])
  })
  it('returns undefined for unknown bearer', () => {
    expect(makeStore().getByBearer('nope')).toBeUndefined()
  })
  it('upsert overwrites by bearerHash (rotation)', () => {
    const s = makeStore()
    const hash = TokenStore.hashBearer('b')
    const base = { bearerHash: hash, userLabel: 'u', businessList: [], updatedAt: 1 }
    s.upsert({ ...base, accessToken: 'a1', refreshToken: 'r1', accessExpiresAt: 1 })
    s.upsert({ ...base, accessToken: 'a2', refreshToken: 'r2', accessExpiresAt: 2 })
    expect(s.getByBearer('b')!.refreshToken).toBe('r2')
  })
  it('audit_log rejects UPDATE and DELETE (append-only triggers)', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO audit_log (ts, user_label, session_id, client_info, tool, params_json, status, trace_id, duration_ms)
                VALUES (1,'u','s','c','t','{}','ok','tr',5)`).run()
    expect(() => db.prepare(`UPDATE audit_log SET status='hacked'`).run()).toThrow(/append-only/)
    expect(() => db.prepare(`DELETE FROM audit_log`).run()).toThrow(/append-only/)
  })
})
