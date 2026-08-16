import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'

function db() { return openDb(':memory:') }

it('identity upsert/get round-trip + rotate 覆寫同一筆', () => {
  const s = new IdentityStore(db())
  s.upsert({ identityId: 'I1', userLabel: 'u', accessToken: 'a1', refreshToken: 'r1', businessList: [1], accessExpiresAt: 100, updatedAt: 1 })
  s.upsert({ identityId: 'I1', userLabel: 'u', accessToken: 'a2', refreshToken: 'r2', businessList: [1], accessExpiresAt: 200, updatedAt: 2 })
  expect(s.get('I1')).toMatchObject({ accessToken: 'a2', refreshToken: 'r2', accessExpiresAt: 200 })
})
it('credential 三種 kind 指向同 identity；getBySecret 只存 hash', () => {
  const d = db(); const cs = new CredentialStore(d)
  cs.insert({ credHash: CredentialStore.hash('tokA'), identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  cs.insert({ credHash: CredentialStore.hash('sidB'), identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 1 })
  expect(cs.getBySecret('tokA')).toMatchObject({ identityId: 'I1', kind: 'oauth_access' })
  expect(cs.getBySecret('sidB')).toMatchObject({ identityId: 'I1', kind: 'web_session' })
  // 明文不落地：DB 內查不到明文
  const raw = (d.prepare('SELECT cred_hash FROM credentials').all() as {cred_hash:string}[]).map(r => r.cred_hash)
  expect(raw).not.toContain('tokA')
  expect(cs.countByIdentity('I1')).toBe(2)
})
it('deleteByIdentity 清掉該 identity 全部 credential', () => {
  const cs = new CredentialStore(db())
  cs.insert({ credHash: CredentialStore.hash('x'), identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  cs.deleteByIdentity('I1')
  expect(cs.getBySecret('x')).toBeUndefined()
})
// 遷移自 tests/tokenStore.test.ts（Task 5 刪除 TokenStore adapter 時搬移）：這條測的是
// db.ts 的 schema trigger，與 TokenStore 本身無關，故獨立保留於此。
it('audit_log rejects UPDATE and DELETE (append-only triggers)', () => {
  const d = db()
  d.prepare(`INSERT INTO audit_log (ts, user_label, session_id, client_info, tool, params_json, status, trace_id, duration_ms)
              VALUES (1,'u','s','c','t','{}','ok','tr',5)`).run()
  expect(() => d.prepare(`UPDATE audit_log SET status='hacked'`).run()).toThrow(/append-only/)
  expect(() => d.prepare(`DELETE FROM audit_log`).run()).toThrow(/append-only/)
})
