import { describe, it, expect } from 'vitest'
import { computePlatformDiff, readSupplierInventorySetting } from '../src/changeset/platformDiff.js'
import { computeChangesetDiff, diffVersionHash, DiffError } from '../src/changeset/diff.js'
import type { InventoryPlatformItem } from '../src/changeset/types.js'

// Task 1 定案: GET /product/api/v1/items/{itemOid}/basic-info -> { data: { item_config: { supplier_configs: [{ supplier_oid, is_external_inventory, is_inventory_mgmt }] } } }
function gatewayWith(configsByItem: Record<string, unknown>) {
  return {
    calls: [] as string[],
    async get(path: string, _at: string) {
      this.calls.push(path)
      const m = /\/items\/([^/]+)\/basic-info$/.exec(path)
      return configsByItem[m ? m[1] : '']
    },
    async put() { throw new Error('diff must never write') },
  }
}
const ctxOf = (gw: unknown) => ({ gateway: gw as never, accessToken: 'at', userLabel: 'u' })
const item = (o: Partial<InventoryPlatformItem> = {}): InventoryPlatformItem =>
  ({ item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM', affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' }], ...o })

const configs = (rows: Array<{ supplier_oid: string | number; is_external_inventory?: boolean; is_inventory_mgmt?: boolean }>) =>
  ({ data: { item_config: { supplier_configs: rows } } })

describe('readSupplierInventorySetting', () => {
  it('reads the two booleans for the matching supplier_oid from supplier_configs[]', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: true }]) })
    const b = await readSupplierInventorySetting(gw as never, 'at', 'i1', 's1')
    expect(b).toEqual({ is_external_inventory: false, is_inventory_mgmt: true })
  })
  it('reads correctly when supplier_oid is a number in the response but string in the query', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 1234, is_external_inventory: true, is_inventory_mgmt: false }]) })
    const b = await readSupplierInventorySetting(gw as never, 'at', 'i1', '1234')
    expect(b).toEqual({ is_external_inventory: true, is_inventory_mgmt: false })
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
  // Final whole-branch review Important 3: the current/target platform read still goes through
  // the item-level endpoint ONLY — this pins that computePlatformDiff never substitutes the
  // packages endpoint for that read (it would be the wrong source of truth for the two
  // booleans). The affected_pkgs *display annotation* separately does read packages now (see the
  // "server-side affected_pkgs recompute" describe block below) — that is a deliberate addition,
  // not a violation of this invariant, so this test's gatewayWith stub (which only serves
  // /basic-info) intentionally leaves any packages call unanswered (undefined) rather than
  // asserting packages is never called at all.
  it('current/target platform is read via the item-level endpoint only', async () => {
    const gw = gatewayWith({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) })
    const [d] = await computePlatformDiff([item()], ctxOf(gw))
    expect(gw.calls).toContain('/product/api/v1/items/i1/basic-info')
    expect(gw.calls.some(c => c.includes('/configs'))).toBe(false)
    // packages 可能被 affected_pkgs 展示重算呼叫（Important 3）——布林讀取本身不經 packages 由上兩行釘住
    expect(d.current).toBe('BE2')
  })
  it('missing booleans -> DiffError', async () => {
    const gw = gatewayWith({ i1: { data: { item_config: { supplier_configs: [] } } } })
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

// Final whole-branch review Important 3: affected_pkgs on InventoryPlatformItem is entirely
// self-reported by whoever created the change-set (the wizard panel / a tool caller) — a
// low-balled list would let an approver believe the blast radius is smaller than it really is.
// computePlatformDiff must re-derive the list server-side from the packages endpoint (scoped to
// the prod_oids the creator claimed — a full reverse item_oid -> all products lookup is out of
// scope) rather than trusting the claim outright.
describe('computePlatformDiff — server-side affected_pkgs recompute (final whole-branch review Important 3)', () => {
  function gatewayWithPackages(configsByItem: Record<string, unknown>, packagesByProd: Record<string, unknown>) {
    return {
      calls: [] as string[],
      async get(path: string) {
        this.calls.push(path)
        const cfgM = /\/items\/([^/]+)\/basic-info$/.exec(path)
        if (cfgM) return configsByItem[cfgM[1]]
        const pkgM = /\/products\/([^/]+)\/packages$/.exec(path)
        if (pkgM) {
          const v = packagesByProd[pkgM[1]]
          if (v instanceof Error) throw v
          return v
        }
        return undefined
      },
      async put() { throw new Error('diff must never write') },
    }
  }

  it('fills in a package the self-report omitted for a claimed prod_oid (under-reported blast radius)', async () => {
    const gw = gatewayWithPackages(
      { i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) },
      { p1: [
        { pkg_oid: 'k1', pkg_name: 'A', item_oid: 'i1', supplier_mapping: [{ is_default: true, supplier_oid: 's1' }] },
        { pkg_oid: 'k2', pkg_name: 'B(未自報)', item_oid: 'i1', supplier_mapping: [{ is_default: true, supplier_oid: 's1' }] },
      ] },
    )
    const [d] = await computePlatformDiff([item({ affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' }] })], ctxOf(gw))
    expect(d.affected_pkgs).toEqual(expect.arrayContaining([
      { prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' },
      { prod_oid: 'p1', pkg_oid: 'k2', pkg_name: 'B(未自報)' },
    ]))
    expect(d.affected_pkgs).toHaveLength(2)
    expect(d.affected_pkgs_unverified).toBeUndefined()
  })

  it('packages read failure degrades to the self-reported list, flagged affected_pkgs_unverified', async () => {
    const gw = gatewayWithPackages(
      { i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) },
      { p1: Object.assign(new Error('boom'), { code: 'HTTP_500' }) },
    )
    const [d] = await computePlatformDiff([item({ affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' }] })], ctxOf(gw))
    expect(d.affected_pkgs).toEqual([{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' }])
    expect(d.affected_pkgs_unverified).toBe(true)
  })

  it('empty self-reported affected_pkgs -> nothing to verify against, flagged unverified', async () => {
    const gw = gatewayWithPackages({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) }, {})
    const [d] = await computePlatformDiff([item({ affected_pkgs: [] })], ctxOf(gw))
    expect(d.affected_pkgs).toEqual([])
    expect(d.affected_pkgs_unverified).toBe(true)
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
