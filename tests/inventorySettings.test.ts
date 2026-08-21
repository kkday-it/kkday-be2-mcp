import { describe, it, expect, vi } from 'vitest'
import { inventorySettingsTool } from '../src/tools/inventorySettings.js'

function ctx(overrides: Partial<{ status: unknown; search: unknown }> = {}) {
  return {
    accessToken: 'tok',
    gateway: {
      get: vi.fn(async (p: string) => overrides.status ?? { is_processing: false, previous_status: null }),
      post: vi.fn(async (p: string, _t: string, body: any) => overrides.search ?? { '1650033': { fullday: 32 } }),
    },
  } as any
}

describe('be2_get_inventory_settings (fullday)', () => {
  it('reads status only when no supplier_oid', async () => {
    const c = ctx()
    const env = await inventorySettingsTool.handler({ item_oid: '1650033' } as any, c)
    expect(c.gateway.post).not.toHaveBeenCalled()
    expect(env.items[0]).toMatchObject({ item_oid: '1650033', is_processing: false })
  })
  it('POSTs inventories/search with {supplier_oid,page} and returns fullday', async () => {
    const c = ctx()
    const env = await inventorySettingsTool.handler({ item_oid: '1650033', supplier_oid: '181' } as any, c)
    expect(c.gateway.post).toHaveBeenCalledWith('/product/api/v1/items/1650033/inventories/search', 'tok', { supplier_oid: '181', page: 1 })
    expect((env.items[0] as any).fullday).toBe(32)
  })
  it('degrades to a warning when search rejects', async () => {
    const c = ctx(); c.gateway.post = vi.fn(async () => { throw Object.assign(new Error('403'), { code: 'AU9403' }) })
    const env = await inventorySettingsTool.handler({ item_oid: '1650033', supplier_oid: '181' } as any, c)
    expect(env.errors.length).toBe(1)
    expect(env.items[0]).toMatchObject({ item_oid: '1650033' })
  })
})
