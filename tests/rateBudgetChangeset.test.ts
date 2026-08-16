import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { RateError } from '../src/errors.js'
describe('RateBudget.consumeChangeset', () => {
  it('throws RATE_CHANGESET_DAY over the daily cap', () => {
    const rb = new RateBudget(openDb(':memory:'))
    for (let i = 0; i < 3; i++) rb.consumeChangeset('u', 3)
    expect(() => rb.consumeChangeset('u', 3)).toThrowError(RateError)
  })
})
