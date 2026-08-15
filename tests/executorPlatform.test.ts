import { describe, it, expect } from 'vitest'
import { execInventoryPlatform, type ExecutorContext } from '../src/changeset/executorPlatform.js'
import { approveAndExecute, type ConfirmServiceDeps } from '../src/changeset/confirmService.js'
import { computeChangesetDiff, diffVersionHash } from '../src/changeset/diff.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { openDb } from '../src/store/db.js'
import type { ChangeSetRecord, InventoryPlatformItem } from '../src/changeset/types.js'

const pkgs = [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'A' }]
const configs = (rows: Array<{ supplier_oid: string; is_external_inventory?: boolean; is_inventory_mgmt?: boolean }>) =>
  ({ data: { item_config: { supplier_configs: rows } } })

// Task 1 定案 read endpoint + Task 3 定案 write endpoint (design doc §4.1):
// GET  /product/api/v1/items/{itemOid}/basic-info -> data.item_config.supplier_configs[]
// PUT  /product/api/v1/items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting
function fakeGw(configsByItem: Record<string, unknown>, opts: { putShouldFail?: Set<string> } = {}) {
  const calls: Array<{ m: string; path: string; body?: unknown }> = []
  return {
    calls,
    async get(path: string) {
      calls.push({ m: 'GET', path })
      const m = /\/items\/([^/]+)\/basic-info$/.exec(path)!
      return configsByItem[m[1]]
    },
    async put(path: string, _at: string, body: unknown) {
      calls.push({ m: 'PUT', path, body })
      const m = /\/items\/([^/]+)\/supplier-configs\/([^/]+)\/inventory-setting$/.exec(path)!
      const key = `${decodeURIComponent(m[1])}:${decodeURIComponent(m[2])}`
      if (opts.putShouldFail?.has(key)) throw Object.assign(new Error('boom'), { code: 'GW_500' })
    },
  }
}
const ctxOf = (gw: unknown): ExecutorContext => ({ gateway: gw as never, accessToken: 'at', modifyUser: 'MU', traceId: 't1' })
function recOf(items: InventoryPlatformItem[]): ChangeSetRecord {
  return {
    id: 'cs1', creatorLabel: 'u@kkday.com', creatorBearerHash: 'bh', sessionId: 's1', actionType: 'inventory_platform',
    items, diff: [], diffVersion: 'v', status: 'approved', createdAt: 1000,
  }
}

describe('execInventoryPlatform', () => {
  it('two items, one PUT succeeds one PUT rejects -> allSettled: one done, one failed', async () => {
    const items: InventoryPlatformItem[] = [
      { item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM', affected_pkgs: pkgs },
      { item_oid: 'i2', supplier_oid: 's2', target: 'EXTERNAL', affected_pkgs: pkgs },
    ]
    const gw = fakeGw({
      i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]),
      i2: configs([{ supplier_oid: 's2', is_external_inventory: false, is_inventory_mgmt: false }]),
    }, { putShouldFail: new Set(['i2:s2']) })
    const results = await execInventoryPlatform(recOf(items), ctxOf(gw))
    expect(results.find(r => r.item_key === 'i1:s1')?.status).toBe('done')
    const failed = results.find(r => r.item_key === 'i2:s2')!
    expect(failed.status).toBe('failed')
    expect(failed.error_code).toBe('GW_500')
  })

  it('PUT body is exactly {is_external_inventory, is_inventory_mgmt, modify_user}', async () => {
    const items: InventoryPlatformItem[] = [{ item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM', affected_pkgs: pkgs }]
    const gw = fakeGw({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) })
    await execInventoryPlatform(recOf(items), ctxOf(gw))
    const put = gw.calls.find(c => c.m === 'PUT')!
    expect(put.path).toBe('/product/api/v1/items/i1/supplier-configs/s1/inventory-setting')
    expect(put.body).toEqual({ is_external_inventory: false, is_inventory_mgmt: true, modify_user: 'MU' })
  })

  it('noop item (current already == target) -> skipped_noop, no PUT issued', async () => {
    const items: InventoryPlatformItem[] = [{ item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM', affected_pkgs: pkgs }]
    const gw = fakeGw({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: true }]) })
    const results = await execInventoryPlatform(recOf(items), ctxOf(gw))
    expect(results[0].status).toBe('skipped_noop')
    expect(gw.calls.some(c => c.m === 'PUT')).toBe(false)
  })
})

// --- itemKey / itemKeysOf regression pin (Task 3 review): InventoryPlatformItem's key must be
// `${item_oid}:${supplier_oid}` — the pre-fix duck-typed itemKey() read prod_oid/pkg_oid (both
// undefined on InventoryPlatformItem) and would make itemKeysOf() always produce [undefined,...],
// permanently mismatching any real confirmedKeys and locking the panel approval path.
describe('itemKeysOf — inventory_platform key rule (Task 3 review pin)', () => {
  const WHO = { accessToken: 'tok', userLabel: 'owner@kkday.com', sessionId: 's1' }

  function makeDeps(gateway: { get: Function; put: Function }): { store: ChangeSetStore; deps: ConfirmServiceDeps } {
    const db = openDb(':memory:')
    const store = new ChangeSetStore(db, { now: () => 1000 })
    const audit = new AuditLog(db, () => 1000)
    const deps: ConfirmServiceDeps = {
      changeSets: store, gateway: gateway as never, audit, now: () => 1000,
      modifyUserFrom: (at: string) => 'U:' + at,
    }
    return { store, deps }
  }
  function seedPlatform(store: ChangeSetStore, id: string, items: InventoryPlatformItem[]): ChangeSetRecord {
    store.create({
      id, creatorLabel: WHO.userLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'inventory_platform',
      items, diff: [], diffVersion: 'seed', status: 'pending_approval', createdAt: 1000,
    })
    return store.get(id)!
  }
  async function realVersion(rec: ChangeSetRecord, gw: { get: Function; put: Function }): Promise<string> {
    const diff = await computeChangesetDiff(rec.actionType, rec.items, { gateway: gw as never, accessToken: WHO.accessToken, userLabel: rec.creatorLabel })
    return diffVersionHash(diff)
  }

  it('confirmedKeys = ["item_oid:supplier_oid"] passes the gate (reaches execution)', async () => {
    const items: InventoryPlatformItem[] = [{ item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM', affected_pkgs: pkgs }]
    const gw = fakeGw({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) })
    const { store, deps } = makeDeps(gw)
    const rec = seedPlatform(store, 'cs-p1', items)
    const version = await realVersion(rec, gw)
    const out = await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['i1:s1'], channel: 'panel' })
    expect(out.stale).toBeUndefined()
    expect(out.casFailed).toBeUndefined()
    expect(out.status).toBeDefined()
  })

  it('confirmedKeys missing the key throws CONFIRMED_KEYS_MISMATCH, never executes', async () => {
    const items: InventoryPlatformItem[] = [{ item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM', affected_pkgs: pkgs }]
    const gw = fakeGw({ i1: configs([{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }]) })
    const { store, deps } = makeDeps(gw)
    const rec = seedPlatform(store, 'cs-p2', items)
    const version = await realVersion(rec, gw)
    await expect(approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: [], channel: 'panel' }))
      .rejects.toMatchObject({ code: 'CONFIRMED_KEYS_MISMATCH' })
    expect(store.get('cs-p2')!.status).toBe('pending_approval')
  })
})
