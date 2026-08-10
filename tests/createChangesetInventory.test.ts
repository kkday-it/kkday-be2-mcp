import { describe, it, expect } from 'vitest'
import { validateInventoryItems } from '../src/changeset/inventoryValidate.js'
import type { InventoryItem } from '../src/changeset/types.js'

const NOW = Date.parse('2026-08-10T00:00:00Z')
const base: InventoryItem = { item_oid: 'i1', supplier_oid: 's1', op: 'adjust', quantity: 50, dates: ['2026-08-15'] }

describe('validateInventoryItems', () => {
  it('accepts a valid adjust item', () => {
    expect(validateInventoryItems([base], NOW)).toBeUndefined()
  })
  it('rejects adjust with quantity 0', () => {
    expect(validateInventoryItems([{ ...base, quantity: 0 }], NOW)?.message).toMatch(/adjust.*non-zero/i)
  })
  it('rejects set with negative quantity', () => {
    expect(validateInventoryItems([{ ...base, op: 'set', quantity: -1 }], NOW)?.message).toMatch(/set.*>= 0/i)
  })
  it('rejects non-integer quantity', () => {
    expect(validateInventoryItems([{ ...base, quantity: 1.5 }], NOW)?.message).toMatch(/integer/i)
  })
  it('rejects past dates (UTC date compare)', () => {
    expect(validateInventoryItems([{ ...base, dates: ['2026-08-09'] }], NOW)?.message).toMatch(/past/i)
  })
  it('accepts today', () => {
    expect(validateInventoryItems([{ ...base, dates: ['2026-08-10'] }], NOW)).toBeUndefined()
  })
  it('rejects a duplicate (item, supplier, date) across the whole change-set', () => {
    const dup = validateInventoryItems([base, { ...base, op: 'set', quantity: 9 }], NOW)
    expect(dup?.message).toMatch(/duplicate/i)
    expect(dup?.key).toBe('i1:s1:2026-08-15')
  })
  it('allows the same date on a different supplier', () => {
    expect(validateInventoryItems([base, { ...base, supplier_oid: 's2' }], NOW)).toBeUndefined()
  })
  it('rejects duplicate dates inside one item', () => {
    expect(validateInventoryItems([{ ...base, dates: ['2026-08-15', '2026-08-15'] }], NOW)?.message).toMatch(/duplicate/i)
  })
})
