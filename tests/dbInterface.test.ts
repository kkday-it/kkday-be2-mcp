import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'

describe('Db (PGlite transport)', () => {
  it('query 回 rows + rowCount；int8 正規化為 number', async () => {
    const db = await openTestDb()
    await db.query(`INSERT INTO rate_counters (counter_key, count, window_start) VALUES ($1, $2, $3)`, ['k', 7, 1756900000000])
    const r = await db.query<{ count: number; window_start: number }>(`SELECT count, window_start FROM rate_counters WHERE counter_key = $1`, ['k'])
    expect(r.rowCount).toBe(1)
    expect(r.rows[0].count).toBe(7)
    expect(typeof r.rows[0].count).toBe('number')
    expect(r.rows[0].window_start).toBe(1756900000000)
    await db.close()
  })

  it('UPDATE 的 rowCount 反映 affected rows（CAS 依賴）', async () => {
    const db = await openTestDb()
    await db.query(`INSERT INTO web_sessions (session_id, identity_id, created_at, last_seen_at) VALUES ('s','i',1,1)`)
    const hit = await db.query(`UPDATE web_sessions SET last_seen_at = 2 WHERE session_id = 's'`)
    const miss = await db.query(`UPDATE web_sessions SET last_seen_at = 2 WHERE session_id = 'nope'`)
    expect(hit.rowCount).toBe(1)
    expect(miss.rowCount).toBe(0)
    await db.close()
  })

  it('transaction：throw 即 rollback', async () => {
    const db = await openTestDb()
    await expect(db.transaction(async (tx) => {
      await tx.query(`INSERT INTO web_sessions (session_id, identity_id, created_at, last_seen_at) VALUES ('t','i',1,1)`)
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const r = await db.query(`SELECT 1 FROM web_sessions WHERE session_id = 't'`)
    expect(r.rowCount).toBe(0)
    await db.close()
  })

  it('openTestDb 每次獨立（隔離不互汙）', async () => {
    const a = await openTestDb()
    const b = await openTestDb()
    await a.query(`INSERT INTO web_sessions (session_id, identity_id, created_at, last_seen_at) VALUES ('iso','i',1,1)`)
    const r = await b.query(`SELECT 1 FROM web_sessions WHERE session_id = 'iso'`)
    expect(r.rowCount).toBe(0)
    await Promise.all([a.close(), b.close()])
  })
})
