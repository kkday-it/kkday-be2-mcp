import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createChangesetTool } from '../src/core/changeset/tools.js'
import {
  platformToBooleans,
  booleansToPlatform,
  validateInventoryPlatformItems,
} from '../src/modules/product/inventoryPlatform/validate.js'
import {
  validateShelfScheduleItems,
  sanitizeQueue,
} from '../src/modules/product/shelfSchedule/validate.js'
import type { InventoryPlatform, InventoryPlatformItem, ShelfScheduleItem } from '../src/core/changeset/types.js'

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
  it('platformToBooleans throws on an out-of-enum value (exhaustive guard, never silently undefined)', () => {
    expect(() => platformToBooleans('BOGUS' as never)).toThrow(/BOGUS/)
  })
})

// Regression (Task 2 review #1): the new item shapes must be strict z.objects in the union —
// a loose z.record would swallow malformed SHELF items (missing target_is_active, or entirely
// unrelated objects) that previously failed zod, silently weakening existing validation.
describe('createChangesetTool zod inputShape strictness', () => {
  const schema = z.object(createChangesetTool.inputShape)
  const platItems = [{ item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM', affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' }] }]

  it('still rejects a malformed shelf item missing target_is_active', () => {
    expect(schema.safeParse({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1' }] }).success).toBe(false)
  })
  it('still rejects a completely unrelated object as an item', () => {
    expect(schema.safeParse({ action_type: 'shelf_toggle_product', items: [{ foo: 'bar' }] }).success).toBe(false)
  })
  it('accepts valid inventory_platform items', () => {
    expect(schema.safeParse({ action_type: 'inventory_platform', items: platItems }).success).toBe(true)
  })
  it('rejects an out-of-enum target at the zod layer', () => {
    expect(schema.safeParse({ action_type: 'inventory_platform', items: [{ ...platItems[0], target: 'SCM' }] }).success).toBe(false)
  })
  it('rejects affected_pkgs entries missing a required string field', () => {
    expect(schema.safeParse({ action_type: 'inventory_platform', items: [{ ...platItems[0], affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1' }] }] }).success).toBe(false)
  })
  it('accepts valid shelf_schedule items, including an empty queue', () => {
    expect(schema.safeParse({ action_type: 'shelf_schedule', items: [
      { prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2026-08-20 10:00:00', reserve_status: true }] },
      { prod_oid: 'p1', pkg_oid: 'k2', queue: [] },
    ] }).success).toBe(true)
  })
  it('rejects a queue entry whose reserve_status is not boolean', () => {
    expect(schema.safeParse({ action_type: 'shelf_schedule', items: [{ prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2026-08-20 10:00:00', reserve_status: 'yes' }] }] }).success).toBe(false)
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
