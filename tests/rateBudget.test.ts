import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { RateError } from '../src/errors.js'

describe('RateBudget', () => {
  it('allows under the limits', async () => {
    const db = await openTestDb()
    const rb = new RateBudget(db, { perSession: 3, perUserDay: 10 })
    await rb.consume('u', 's1'); await rb.consume('u', 's1'); await rb.consume('u', 's1')
    await db.close()
  })
  it('throws RATE_SESSION at session limit, other sessions unaffected', async () => {
    const db = await openTestDb()
    const rb = new RateBudget(db, { perSession: 2, perUserDay: 100 })
    await rb.consume('u', 's1'); await rb.consume('u', 's1')
    await expect(rb.consume('u', 's1')).rejects.toThrow(RateError)
    await rb.consume('u', 's2')
    await db.close()
  })
  it('throws RATE_USER_DAY across sessions, resets next UTC day', async () => {
    let day = Date.UTC(2026, 7, 9, 12)
    const db = await openTestDb()
    const rb = new RateBudget(db, { perSession: 100, perUserDay: 2, now: () => day })
    await rb.consume('u', 's1'); await rb.consume('u', 's2')
    await expect(rb.consume('u', 's3')).rejects.toThrow(/daily/i)
    day += 24 * 3600_000
    await rb.consume('u', 's3')
    await db.close()
  })
  it('purges counter rows older than 3 days (table stays bounded)', async () => {
    let t = Date.UTC(2026, 7, 1, 12)
    const db = await openTestDb()
    const rb = new RateBudget(db, { now: () => t })
    await rb.consume('u', 'old-session')
    t += 4 * 24 * 3600_000
    await rb.consume('u', 'new-session')
    const keys = (await db.query<{ counter_key: string }>('SELECT counter_key FROM rate_counters')).rows.map(r => r.counter_key)
    expect(keys.some(k => k.includes('old-session'))).toBe(false)
    expect(keys.some(k => k.includes('new-session'))).toBe(true)
    await db.close()
  })
})
