import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'

it('identity upsert/get round-trip + rotate 覆寫同一筆', async () => {
  const db = await openTestDb()
  const s = new IdentityStore(db)
  await s.upsert({ identityId: 'I1', userLabel: 'u', accessToken: 'a1', refreshToken: 'r1', businessList: [1], accessExpiresAt: 100, updatedAt: 1 })
  await s.upsert({ identityId: 'I1', userLabel: 'u', accessToken: 'a2', refreshToken: 'r2', businessList: [1], accessExpiresAt: 200, updatedAt: 2 })
  expect(await s.get('I1')).toMatchObject({ accessToken: 'a2', refreshToken: 'r2', accessExpiresAt: 200 })
  await db.close()
})
it('credential 三種 kind 指向同 identity；getBySecret 只存 hash', async () => {
  const d = await openTestDb(); const cs = new CredentialStore(d)
  await cs.insert({ credHash: CredentialStore.hash('tokA'), identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  await cs.insert({ credHash: CredentialStore.hash('sidB'), identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 1 })
  expect(await cs.getBySecret('tokA')).toMatchObject({ identityId: 'I1', kind: 'oauth_access' })
  expect(await cs.getBySecret('sidB')).toMatchObject({ identityId: 'I1', kind: 'web_session' })
  // 明文不落地：DB 內查不到明文
  const raw = (await d.query<{ cred_hash: string }>('SELECT cred_hash FROM credentials')).rows.map(r => r.cred_hash)
  expect(raw).not.toContain('tokA')
  expect(await cs.countByIdentity('I1')).toBe(2)
  await d.close()
})
it('deleteByIdentity 清掉該 identity 全部 credential', async () => {
  const d = await openTestDb(); const cs = new CredentialStore(d)
  await cs.insert({ credHash: CredentialStore.hash('x'), identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  await cs.deleteByIdentity('I1')
  expect(await cs.getBySecret('x')).toBeUndefined()
  await d.close()
})
// 遷移自 tests/tokenStore.test.ts（Task 5 刪除 TokenStore adapter 時搬移）：這條測的是
// db 的 schema trigger，與 TokenStore 本身無關，故獨立保留於此。PG 版：0001_baseline.sql 的
// audit_log_immutable() trigger 取代原 SQLite trigger，直接對 Db.query 斷言。
it('audit_log rejects UPDATE and DELETE (append-only triggers)', async () => {
  const d = await openTestDb()
  await d.query(`INSERT INTO audit_log (ts, user_label, session_id, client_info, tool, params_json, status, trace_id, duration_ms)
              VALUES (1,'u','s','c','t','{}','ok','tr',5)`)
  await expect(d.query(`UPDATE audit_log SET status='hacked'`)).rejects.toThrow(/append-only/)
  await expect(d.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/)
  await d.close()
})
