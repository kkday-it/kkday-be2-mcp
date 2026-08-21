import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseInventoryFullday, readItemMode, isItemByAmount } from '../src/tools/inventoryShape.js'
const fixture = JSON.parse(readFileSync('tests/fixtures/inventory-quantities.json', 'utf8'))

describe('parseInventoryFullday', () => {
  it('reads data[itemOid].fullday from the full envelope', () => {
    expect(parseInventoryFullday(fixture, '1650033')).toBe(32)
  })
  it('reads from an already-unwrapped map (gateway strips .data)', () => {
    expect(parseInventoryFullday({ '1650033': { fullday: 32 } }, '1650033')).toBe(32)
  })
  it('coerces a numeric string', () => {
    expect(parseInventoryFullday({ data: { '7': { fullday: '15' } } }, '7')).toBe(15)
  })
  it('returns undefined for null / missing / NaN (never 0)', () => {
    expect(parseInventoryFullday({ data: { '7': { fullday: null } } }, '7')).toBeUndefined()
    expect(parseInventoryFullday({ data: {} }, '7')).toBeUndefined()
    expect(parseInventoryFullday({ data: { '7': { fullday: 'x' } } }, '7')).toBeUndefined()
    expect(parseInventoryFullday(undefined, '7')).toBeUndefined()
  })
})

describe('readItemMode / isItemByAmount', () => {
  const basic = { item_config: { inventory_setting: { control_type: 1, inventory_type: 0 } } }
  it('reads control_type/inventory_type from basic-info', () => {
    expect(readItemMode(basic)).toEqual({ control_type: 1, inventory_type: 0 })
  })
  it('item_by_amount is 1/0 only', () => {
    expect(isItemByAmount({ control_type: 1, inventory_type: 0 })).toBe(true)
    expect(isItemByAmount({ control_type: 2, inventory_type: 0 })).toBe(false)
    expect(isItemByAmount({ control_type: 1, inventory_type: 1 })).toBe(false)
    expect(isItemByAmount({ control_type: undefined, inventory_type: null })).toBe(false)
  })
})
