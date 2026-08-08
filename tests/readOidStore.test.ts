import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ReadOidStore } from '../src/store/readOidStore.js'

describe('ReadOidStore', () => {
  it('records and queries per-session oids; sessions are isolated', () => {
    const s = new ReadOidStore(openDb(':memory:'))
    s.record('sess1', ['p1', 'k1'])
    s.record('sess2', ['p9'])
    expect(s.has('sess1', 'p1')).toBe(true)
    expect(s.has('sess1', 'p9')).toBe(false)
    expect(s.list('sess1').sort()).toEqual(['k1', 'p1'])
  })
  it('re-recording the same oid is a no-op (no throw)', () => {
    const s = new ReadOidStore(openDb(':memory:'))
    s.record('sess1', ['p1'])
    expect(() => s.record('sess1', ['p1'])).not.toThrow()
    expect(s.list('sess1')).toEqual(['p1'])
  })
  it('purges rows past retention on the next record()', () => {
    let t = 1_000_000
    const s = new ReadOidStore(openDb(':memory:'), { retentionMs: 100, now: () => t })
    s.record('old-sess', ['p1'])
    t += 200
    s.record('new-sess', ['p2'])
    expect(s.has('old-sess', 'p1')).toBe(false)
    expect(s.has('new-sess', 'p2')).toBe(true)
  })
})
