import { describe, it, expect, vi } from 'vitest'
import { computeInventoryDiff } from '../src/modules/product/inventorySetting/diff.js'
import { DiffError } from '../src/core/changeset/diff.js'

function ctx(mode: any, search: any) {
  return {
    accessToken: 'tok',
    gateway: {
      get: vi.fn(async () => ({ item_config: { inventory_setting: mode } })),
      post: vi.fn(async () => search),
    },
  } as any
}
const item = { item_oid: '1650033', supplier_oid: '181', quantity: 50 }

describe('computeInventoryDiff (fullday SET)', () => {
  it('produces current->target for item_by_amount', async () => {
    const d = await computeInventoryDiff([item], ctx({ control_type: 1, inventory_type: 0 }, { '1650033': { fullday: 32 } }))
    expect(d[0]).toEqual({ item_oid: '1650033', supplier_oid: '181', current: 32, target: 50, no_op: false })
  })
  it('no_op when current === target', async () => {
    const d = await computeInventoryDiff([{ ...item, quantity: 32 }], ctx({ control_type: 1, inventory_type: 0 }, { '1650033': { fullday: 32 } }))
    expect(d[0].no_op).toBe(true)
  })
  it('current undefined (unset) is legal for SET', async () => {
    const d = await computeInventoryDiff([item], ctx({ control_type: 1, inventory_type: 0 }, { '1650033': { fullday: null } }))
    expect(d[0].current).toBeUndefined()
    expect(d[0].target).toBe(50)
  })
  it('throws DiffError for non-item_by_amount mode', async () => {
    await expect(computeInventoryDiff([item], ctx({ control_type: 2, inventory_type: 1 }, {}))).rejects.toBeInstanceOf(DiffError)
  })
  it('throws DiffError when the read fails (fail-closed)', async () => {
    const c = ctx({ control_type: 1, inventory_type: 0 }, {}); c.gateway.get = vi.fn(async () => { throw new Error('boom') })
    await expect(computeInventoryDiff([item], c)).rejects.toBeInstanceOf(DiffError)
  })
})
