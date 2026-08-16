import { describe, it, expect } from 'vitest'
import { parseQuantities, groupDatesByMonth, findRows, rowDate, rowQty, setRowQty } from '../src/tools/inventoryShape.js'

describe('parseQuantities', () => {
  it('parses rows under any candidate top-level key and candidate field names', () => {
    const raw = { itemInventory: [{ date: '2026-08-15', quantity: 10 }, { date: '2026-08-16', quantity: 0 }] }
    expect(parseQuantities(raw).byDate).toEqual({ '2026-08-15': 10, '2026-08-16': 0 })
  })
  it('parses snake_case variants', () => {
    const raw = { item_inventory: [{ inventory_date: '2026-08-15', inventory_qty: 3 }] }
    expect(parseQuantities(raw).byDate).toEqual({ '2026-08-15': 3 })
  })
  it('returns empty byDate on unknown shapes (never throws)', () => {
    expect(parseQuantities(undefined).byDate).toEqual({})
    expect(parseQuantities({ nothing: true }).byDate).toEqual({})
  })
  it('setRowQty overwrites the matched quantity key in place', () => {
    const row: Record<string, unknown> = { date: '2026-08-15', quantity: 10, other: 'kept' }
    setRowQty(row, 60)
    expect(row).toEqual({ date: '2026-08-15', quantity: 60, other: 'kept' })
    expect(rowQty(row)).toBe(60)
    expect(rowDate(row)).toBe('2026-08-15')
  })
  it('findRows handles a bare array response', () => {
    expect(findRows([{ date: 'd', quantity: 1 }])).toHaveLength(1)
  })
})

describe('groupDatesByMonth', () => {
  it('groups and preserves order within a month', () => {
    const m = groupDatesByMonth(['2026-08-30', '2026-09-01', '2026-08-31'])
    expect([...m.keys()]).toEqual(['2026-08', '2026-09'])
    expect(m.get('2026-08')).toEqual(['2026-08-30', '2026-08-31'])
  })
})
