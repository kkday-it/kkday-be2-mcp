import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { RateError } from '../src/errors.js'
describe('RateBudget.consumeChangeset', () => {
  it('throws RATE_CHANGESET_DAY over the daily cap', async () => {
    const db = await openTestDb()
    const rb = new RateBudget(db)
    for (let i = 0; i < 3; i++) await rb.consumeChangeset('u', 3)
    await expect(rb.consumeChangeset('u', 3)).rejects.toThrow(RateError)
    await db.close()
  })
})
