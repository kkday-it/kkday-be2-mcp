import { describe, it, expect, vi } from 'vitest'
import { execInventory } from '../src/modules/product/inventorySetting/executor.js'

function mkDeps(search: any, putImpl?: any) {
  const gateway = {
    get: vi.fn(async (p: string) => p.endsWith('/status') ? { is_processing: false } : search),
    post: vi.fn(async () => search),
    put: putImpl ?? vi.fn(async () => ({ meta: { status: '100000' } })),
  }
  return { deps: { gateway } as any, gateway }
}
const item = { item_oid: '1650033', supplier_oid: '181', quantity: 50 }

describe('execInventory (fullday SET)', () => {
  it('PUTs quantity with remain_qty {itemOid:{fullday}} + modify_type 1', async () => {
    const { deps, gateway } = mkDeps({ '1650033': { fullday: 32 } })
    const r = await execInventory(deps, 'tok', 'user-uuid', item, 'trace')
    expect(gateway.put).toHaveBeenCalledWith(
      '/product/api/v1/items/1650033/inventories/181/quantity', 'tok',
      { inventory_data: { remain_qty: { '1650033': { fullday: 50 } }, modify_type: 1 }, modify_user: 'user-uuid' })
    expect(r.status).toBe('done')
    expect(r.before).toEqual({ fullday: 32 })
  })
  it('skips no_op (current === target)', async () => {
    const { deps, gateway } = mkDeps({ '1650033': { fullday: 50 } })
    const r = await execInventory(deps, 'tok', 'u', item, 'trace')
    expect(gateway.put).not.toHaveBeenCalled()
    expect(r.status).toBe('skipped_noop')
  })
  it('busy guard fails closed when is_processing stays true', async () => {
    const { deps, gateway } = mkDeps({ '1650033': { fullday: 32 } })
    gateway.get = vi.fn(async (p: string) => p.endsWith('/status') ? { is_processing: true } : { '1650033': { fullday: 32 } })
    const r = await execInventory({ ...deps, sleep: async () => {}, poll: { retries: 1, delayMs: 0 } } as any, 'tok', 'u', item, 'trace')
    expect(r.status).toBe('failed')
    expect(r.error_code).toBe('INVENTORY_BUSY')
    expect(gateway.put).not.toHaveBeenCalled()
  })
  it('write success is NOT reported failed when the after re-read blips', async () => {
    let call = 0
    const { deps, gateway } = mkDeps({ '1650033': { fullday: 32 } })
    gateway.post = vi.fn(async () => { call++; if (call === 2) throw new Error('reread blip'); return { '1650033': { fullday: 32 } } })
    const r = await execInventory(deps, 'tok', 'u', item, 'trace')
    expect(r.status).toBe('done')
    expect(r.error_code).toBe('AFTER_READ_FAILED')
  })
})
