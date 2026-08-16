import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { RateError } from '../src/errors.js'

describe('RateBudget', () => {
  it('allows under the limits', () => {
    const rb = new RateBudget(openDb(':memory:'), { perSession: 3, perUserDay: 10 })
    expect(() => { rb.consume('u', 's1'); rb.consume('u', 's1'); rb.consume('u', 's1') }).not.toThrow()
  })
  it('throws RATE_SESSION at session limit, other sessions unaffected', () => {
    const rb = new RateBudget(openDb(':memory:'), { perSession: 2, perUserDay: 100 })
    rb.consume('u', 's1'); rb.consume('u', 's1')
    expect(() => rb.consume('u', 's1')).toThrowError(RateError)
    expect(() => rb.consume('u', 's2')).not.toThrow()
  })
  it('throws RATE_USER_DAY across sessions, resets next UTC day', () => {
    let day = Date.UTC(2026, 7, 9, 12)
    const rb = new RateBudget(openDb(':memory:'), { perSession: 100, perUserDay: 2, now: () => day })
    rb.consume('u', 's1'); rb.consume('u', 's2')
    expect(() => rb.consume('u', 's3')).toThrowError(/daily/i)
    day += 24 * 3600_000
    expect(() => rb.consume('u', 's3')).not.toThrow()
  })
  it('purges counter rows older than 3 days (table stays bounded)', () => {
    let t = Date.UTC(2026, 7, 1, 12)
    const db = openDb(':memory:')
    const rb = new RateBudget(db, { now: () => t })
    rb.consume('u', 'old-session')
    t += 4 * 24 * 3600_000
    rb.consume('u', 'new-session')
    const keys = (db.prepare('SELECT counter_key FROM rate_counters').all() as Array<{ counter_key: string }>).map(r => r.counter_key)
    expect(keys.some(k => k.includes('old-session'))).toBe(false)
    expect(keys.some(k => k.includes('new-session'))).toBe(true)
  })
})
