import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { ReadOidStore } from '../src/store/readOidStore.js'

describe('ReadOidStore', () => {
  it('records and queries per-session oids; sessions are isolated', async () => {
    const db = await openTestDb()
    const s = new ReadOidStore(db)
    await s.record('sess1', ['p1', 'k1'])
    await s.record('sess2', ['p9'])
    expect(await s.has('sess1', 'p1')).toBe(true)
    expect(await s.has('sess1', 'p9')).toBe(false)
    expect((await s.list('sess1')).sort()).toEqual(['k1', 'p1'])
    await db.close()
  })
  it('re-recording the same oid is a no-op (no throw)', async () => {
    const db = await openTestDb()
    const s = new ReadOidStore(db)
    await s.record('sess1', ['p1'])
    await s.record('sess1', ['p1'])
    expect(await s.list('sess1')).toEqual(['p1'])
    await db.close()
  })
  it('purges rows past retention on the next record()', async () => {
    let t = 1_000_000
    const db = await openTestDb()
    const s = new ReadOidStore(db, { retentionMs: 100, now: () => t })
    await s.record('old-sess', ['p1'])
    t += 200
    await s.record('new-sess', ['p2'])
    expect(await s.has('old-sess', 'p1')).toBe(false)
    expect(await s.has('new-sess', 'p2')).toBe(true)
    await db.close()
  })
})
