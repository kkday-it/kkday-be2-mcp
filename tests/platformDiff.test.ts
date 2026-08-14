import { describe, it, expect } from 'vitest'
import { computePlatformDiff, readSupplierInventorySetting } from '../src/changeset/platformDiff.js'
import { computeChangesetDiff, diffVersionHash, DiffError } from '../src/changeset/diff.js'
import type { InventoryPlatformItem } from '../src/changeset/types.js'

// Task 1 定案: GET /product/api/v1/items/{itemOid}/configs -> { supplier_configs: [{ supplier_oid, is_external_inventory, is_inventory_mgmt }] }
function gatewayWith(configsByItem: Record<string, unknown>) {
  return {
    calls: [] as string[],
    async get(path: string, _at: string) {
      this.calls.push(path)
      const m = /\/items\/([^/]+)\/configs$/.exec(path)
      return configsByItem[m ? m[1] : '']
    },
    async put() { throw new Error('diff must never write') },
  }
}
const ctxOf = (gw: unknown) => ({ gateway: gw as never, accessToken: 'at', userLabel: 'u' })
const item = (o: Partial<InventoryPlatformItem> = {}): InventoryPlatformItem =>
  ({ item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM', affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' }], ...o })

const configs = (rows: Array<{ supplier_oid: string; is_external_inventory?: boolean; is_inventory_mgmt?: boolean }>) =>
  ({ supplier_configs: rows })

describe('readSupplierInventorySetting', () => {
  it('reads the two booleans for the matching supplier_oid from supplier_configs[]', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: true }]) })
    const b = await readSupplierInventorySetting(gw as never, 'at', 'i1', 's1')
    expect(b).toEqual({ is_external_inventory: false, is_inventory_mgmt: true })
  })
  it('throws DiffError when supplier_oid is absent from supplier_configs[]', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's-other', is_external_inventory: false, is_inventory_mgmt: false }]) })
    await expect(readSupplierInventorySetting(gw as never, 'at', 'i1', 's1')).rejects.toBeInstanceOf(DiffError)
  })
  it('throws DiffError when either boolean is missing/malformed', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false }]) })
    await expect(readSupplierInventorySetting(gw as never, 'at', 'i1', 's1')).rejects.toBeInstanceOf(DiffError)
  })
})

describe('computePlatformDiff', () => {
  it('current BE2, target BE2_SCM -> one non-noop diff item', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) })
    const [d] = await computePlatformDiff([item({ target: 'BE2_SCM' })], ctxOf(gw))
    expect(d).toMatchObject({ item_oid: 'i1', supplier_oid: 's1', current: 'BE2', target: 'BE2_SCM', noop: false })
  })
  it('current == target -> noop:true', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: true }]) })
    const [d] = await computePlatformDiff([item({ target: 'BE2_SCM' })], ctxOf(gw))
    expect(d).toMatchObject({ current: 'BE2_SCM', target: 'BE2_SCM', noop: true })
  })
  it('reads via the item-level endpoint only — never calls packages', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) })
    await computePlatformDiff([item()], ctxOf(gw))
    expect(gw.calls).toEqual(['/product/api/v1/items/i1/configs'])
    expect(gw.calls.some(c => c.includes('packages'))).toBe(false)
  })
  it('missing booleans -> DiffError', async () => {
    const gw = gatewayWith({ i1: { supplier_configs: [] } })
    await expect(computePlatformDiff([item()], ctxOf(gw))).rejects.toBeInstanceOf(DiffError)
  })
  it('undefined combination (external+mgmt both true, "11") -> DiffError', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: true, is_inventory_mgmt: true }]) })
    await expect(computePlatformDiff([item()], ctxOf(gw))).rejects.toBeInstanceOf(DiffError)
  })
  it('preserves affected_pkgs on the diff item (display annotation)', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) })
    const [d] = await computePlatformDiff([item()], ctxOf(gw))
    expect(d.affected_pkgs).toEqual([{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' }])
  })
})

describe('computeChangesetDiff dispatcher routes inventory_platform', () => {
  it('routes inventory_platform to computePlatformDiff', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) })
    const diff = await computeChangesetDiff('inventory_platform', [item()], ctxOf(gw))
    expect((diff[0] as { item_oid: string }).item_oid).toBe('i1')
  })
  // Task 4 wired shelf_schedule to computeScheduleDiff (was a stub DiffError placeholder in
  // Task 3) — this only pins that the dispatcher does NOT fall through to computeShelfDiff (which
  // reads target_is_active — absent on ShelfScheduleItem — and would misread/crash on real data).
  // Full shelf_schedule diff behavior is covered in tests/scheduleDiff.test.ts.
  it('shelf_schedule does not fall through to computeShelfDiff (empty items -> empty diff, not a crash)', async () => {
    const gw = gatewayWith({})
    await expect(computeChangesetDiff('shelf_schedule', [], ctxOf(gw))).resolves.toEqual([])
  })
})

describe('diffVersionHash — InventoryPlatformDiffItem explicit branch (Task 3 review)', () => {
  const mk = (current: 'BE2' | 'BE2_SCM' | 'EXTERNAL', target: 'BE2' | 'BE2_SCM' | 'EXTERNAL') => ([{
    item_oid: 'i1', supplier_oid: 's1', current, target, noop: current === target,
    affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' }],
  }])
  it('computes without throwing (does not crash reading .dates off a platform diff item)', () => {
    expect(() => diffVersionHash(mk('BE2', 'BE2_SCM'))).not.toThrow()
  })
  it('same content -> stable hash', () => {
    expect(diffVersionHash(mk('BE2', 'BE2_SCM'))).toBe(diffVersionHash(mk('BE2', 'BE2_SCM')))
  })
  it('boolean/current change -> hash changes', () => {
    expect(diffVersionHash(mk('BE2', 'BE2_SCM'))).not.toBe(diffVersionHash(mk('EXTERNAL', 'BE2_SCM')))
  })
})
