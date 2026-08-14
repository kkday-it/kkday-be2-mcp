import { describe, it, expect } from 'vitest'
import {
  platformToBooleans,
  booleansToPlatform,
  validateInventoryPlatformItems,
  validateShelfScheduleItems,
  sanitizeQueue,
} from '../src/changeset/batchValidate.js'
import type { InventoryPlatform, InventoryPlatformItem, ShelfScheduleItem } from '../src/changeset/types.js'

const NOW = Date.parse('2026-08-14T00:00:00Z')

describe('platformToBooleans / booleansToPlatform', () => {
  it('BE2 -> {false,false}', () => {
    expect(platformToBooleans('BE2')).toEqual({ is_external_inventory: false, is_inventory_mgmt: false })
  })
  it('BE2_SCM -> {false,true}', () => {
    expect(platformToBooleans('BE2_SCM')).toEqual({ is_external_inventory: false, is_inventory_mgmt: true })
  })
  it('EXTERNAL -> {true,false}', () => {
    expect(platformToBooleans('EXTERNAL')).toEqual({ is_external_inventory: true, is_inventory_mgmt: false })
  })
  it('three states round-trip both ways', () => {
    const states: InventoryPlatform[] = ['BE2', 'BE2_SCM', 'EXTERNAL']
    for (const s of states) {
      expect(booleansToPlatform(platformToBooleans(s))).toBe(s)
    }
  })
  it('undefined combo (EXTERNAL+mgmt=true, "11") maps back to undefined', () => {
    expect(booleansToPlatform({ is_external_inventory: true, is_inventory_mgmt: true })).toBeUndefined()
  })
})

describe('validateInventoryPlatformItems', () => {
  const item = (o: Partial<InventoryPlatformItem> = {}): InventoryPlatformItem => ({
    item_oid: 'i1',
    supplier_oid: 's1',
    target: 'BE2_SCM',
    affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'pkg1', pkg_name: 'Plan A' }],
    ...o,
  })

  it('accepts a single valid item', () => {
    expect(validateInventoryPlatformItems([item()])).toBeNull()
  })

  it('rejects duplicate (item_oid, supplier_oid) with both conflicting pkg_names in the message', () => {
    const a = item({ affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'pkg1', pkg_name: 'Plan A' }] })
    const b = item({ target: 'BE2', affected_pkgs: [{ prod_oid: 'p2', pkg_oid: 'pkg2', pkg_name: 'Plan B' }] })
    const msg = validateInventoryPlatformItems([a, b])
    expect(msg).not.toBeNull()
    expect(msg).toContain('Plan A')
    expect(msg).toContain('Plan B')
  })

  it('rejects an item with empty affected_pkgs', () => {
    const msg = validateInventoryPlatformItems([item({ affected_pkgs: [] })])
    expect(msg).not.toBeNull()
  })

  it('allows the same item_oid with a different supplier_oid', () => {
    expect(validateInventoryPlatformItems([item(), item({ supplier_oid: 's2' })])).toBeNull()
  })
})

describe('validateShelfScheduleItems', () => {
  const item = (o: Partial<ShelfScheduleItem> = {}): ShelfScheduleItem => ({
    prod_oid: 'p1',
    pkg_oid: 'pkg1',
    queue: [{ reserve_date_utc: '2026-08-20 10:00:00', reserve_status: true }],
    ...o,
  })

  it('accepts a valid future entry', () => {
    expect(validateShelfScheduleItems([item()], () => NOW)).toBeNull()
  })

  it('rejects a past reserve_date_utc', () => {
    const msg = validateShelfScheduleItems([item({ queue: [{ reserve_date_utc: '2026-08-01 00:00:00', reserve_status: true }] })], () => NOW)
    expect(msg).not.toBeNull()
  })

  it('rejects duplicate pkg_oid across items in the same change-set', () => {
    const msg = validateShelfScheduleItems([item(), item({ prod_oid: 'p2' })], () => NOW)
    expect(msg).not.toBeNull()
  })

  it('allows an empty queue (= clear the schedule)', () => {
    expect(validateShelfScheduleItems([item({ queue: [] })], () => NOW)).toBeNull()
  })

  it('rejects a malformed reserve_date_utc (not "YYYY-MM-DD HH:mm:ss")', () => {
    const msg = validateShelfScheduleItems([item({ queue: [{ reserve_date_utc: '2026-08-20T10:00:00Z', reserve_status: true }] })], () => NOW)
    expect(msg).not.toBeNull()
  })
})

describe('sanitizeQueue', () => {
  it('drops server-only fields and keeps only reserve_date_utc/reserve_status', () => {
    const out = sanitizeQueue([
      { reserve_date: '2026-08-20 10:00:00', reserve_status: true, created_at: '2026-08-01', created_by: 'x' } as never,
    ])
    expect(out).toEqual([{ reserve_date_utc: '2026-08-20 10:00:00', reserve_status: true }])
  })

  it('sorts ascending by date', () => {
    const out = sanitizeQueue([
      { reserve_date: '2026-08-25 00:00:00', reserve_status: false },
      { reserve_date: '2026-08-20 10:00:00', reserve_status: true },
    ])
    expect(out.map(e => e.reserve_date_utc)).toEqual(['2026-08-20 10:00:00', '2026-08-25 00:00:00'])
  })

  it('produces the same result regardless of input order', () => {
    const a = sanitizeQueue([
      { reserve_date: '2026-08-25 00:00:00', reserve_status: false },
      { reserve_date: '2026-08-20 10:00:00', reserve_status: true },
    ])
    const b = sanitizeQueue([
      { reserve_date: '2026-08-20 10:00:00', reserve_status: true },
      { reserve_date: '2026-08-25 00:00:00', reserve_status: false },
    ])
    expect(a).toEqual(b)
  })
})
