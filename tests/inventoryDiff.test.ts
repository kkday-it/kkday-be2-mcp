import { describe, it, expect } from 'vitest'
import { computeInventoryDiff } from '../src/modules/product/inventorySetting/diff.js'
import { computeChangesetDiff, DiffError } from '../src/core/changeset/diff.js'
import { inventorySettingModule } from '../src/modules/product/inventorySetting/module.js'
import { shelfToggleProductModule } from '../src/modules/product/shelfToggle/module.js'
const diffVersionHash = inventorySettingModule.diffVersion as (d: unknown[]) => string
import type { InventoryItem } from '../src/core/changeset/types.js'

function gatewayWith(byMonth: Record<string, unknown>) {
  return {
    calls: [] as string[],
    async get(path: string, _at: string, query?: Record<string, string>) {
      this.calls.push(`${path}?year_month=${query?.year_month}`)
      return byMonth[query!.year_month] ?? { itemInventory: [] }
    },
    async put() { throw new Error('diff must never write') },
  }
}
const ctxOf = (gw: unknown) => ({ gateway: gw as never, accessToken: 'at', userLabel: 'u' })
const item = (o: Partial<InventoryItem> = {}): InventoryItem =>
  ({ item_oid: 'i1', supplier_oid: 's1', op: 'adjust', quantity: 50, dates: ['2026-08-15'], ...o })

describe('computeInventoryDiff', () => {
  it('adjust: target = current + delta, computed from live read', async () => {
    const gw = gatewayWith({ '2026-08': { itemInventory: [{ date: '2026-08-15', quantity: 10 }] } })
    const [d] = await computeInventoryDiff([item()], ctxOf(gw))
    expect(d.dates).toEqual([{ date: '2026-08-15', current: 10, target: 60, no_op: false, would_go_negative: false }])
  })
  it('adjust below zero flags would_go_negative (no throw — preview must render it)', async () => {
    const gw = gatewayWith({ '2026-08': { itemInventory: [{ date: '2026-08-15', quantity: 10 }] } })
    const [d] = await computeInventoryDiff([item({ quantity: -20 })], ctxOf(gw))
    expect(d.dates[0]).toMatchObject({ target: -10, would_go_negative: true })
  })
  it('set: no_op when live already equals target', async () => {
    const gw = gatewayWith({ '2026-08': { itemInventory: [{ date: '2026-08-15', quantity: 100 }] } })
    const [d] = await computeInventoryDiff([item({ op: 'set', quantity: 100 })], ctxOf(gw))
    expect(d.dates[0]).toMatchObject({ current: 100, target: 100, no_op: true })
  })
  it('adjust on a date with no readable base throws DiffError (嚴禁盲寫)', async () => {
    const gw = gatewayWith({ '2026-08': { itemInventory: [] } })
    await expect(computeInventoryDiff([item()], ctxOf(gw))).rejects.toBeInstanceOf(DiffError)
  })
  it('set on an unknown base is allowed with current undefined', async () => {
    const gw = gatewayWith({ '2026-08': { itemInventory: [] } })
    const [d] = await computeInventoryDiff([item({ op: 'set', quantity: 5 })], ctxOf(gw))
    expect(d.dates[0]).toMatchObject({ current: undefined, target: 5, no_op: false })
  })
  it('reads once per month (cross-month dates → two GETs)', async () => {
    const gw = gatewayWith({
      '2026-08': { itemInventory: [{ date: '2026-08-31', quantity: 1 }] },
      '2026-09': { itemInventory: [{ date: '2026-09-01', quantity: 2 }] },
    })
    await computeInventoryDiff([item({ dates: ['2026-08-31', '2026-09-01'] })], ctxOf(gw))
    expect(gw.calls).toHaveLength(2)
  })
})

describe('diffVersionHash op split (spec §4)', () => {
  const mk = (current: number, op: 'set' | 'adjust') => ([{
    item_oid: 'i1', supplier_oid: 's1', op, quantity: 50,
    dates: [{ date: '2026-08-15', current, target: op === 'set' ? 50 : current + 50, no_op: false, would_go_negative: false }],
  }])
  it('set: base drift changes the hash (stale guard fires)', () => {
    expect(diffVersionHash(mk(10, 'set'))).not.toBe(diffVersionHash(mk(11, 'set')))
  })
  it('adjust: base drift does NOT change the hash (no stale on drift)', () => {
    expect(diffVersionHash(mk(10, 'adjust'))).toBe(diffVersionHash(mk(11, 'adjust')))
  })
  it('adjust: delta or date change DOES change the hash', () => {
    const a = mk(10, 'adjust'); const b = mk(10, 'adjust')
    ;(b[0] as { quantity: number }).quantity = 51
    expect(diffVersionHash(a)).not.toBe(diffVersionHash(b))
  })
  it('shelf diff hashing is unchanged', () => {
    const shelf = [{ prod_oid: 'p1', target_is_active: false, current_is_active: true, no_op: false }]
    expect(shelfToggleProductModule.diffVersion(shelf)).toBe(shelfToggleProductModule.diffVersion([...shelf]))
  })
})

describe('computeChangesetDiff dispatcher', () => {
  it('routes inventory_setting to computeInventoryDiff', async () => {
    const gw = gatewayWith({ '2026-08': { itemInventory: [{ date: '2026-08-15', quantity: 10 }] } })
    const diff = await computeChangesetDiff('inventory_setting', [item()], ctxOf(gw))
    expect((diff[0] as { item_oid: string }).item_oid).toBe('i1')
  })
})
