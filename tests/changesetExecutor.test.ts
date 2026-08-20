import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { executeChangeSet, type ExecutorDeps, type ExecutorIdentity } from '../src/core/changeset/executor.js'
import type { InventoryItem } from '../src/core/changeset/types.js'

const WHO: ExecutorIdentity = { accessToken: 'sess-token', userLabel: 'approver@kkday.com', modifyUser: 'UUID-1', sessionId: 'websess-1' }

function deps(gwState: Record<string, any>, over: Partial<ExecutorDeps> = {}): { deps: ExecutorDeps; store: ChangeSetStore } {
  const db = openDb(':memory:')
  const store = new ChangeSetStore(db, { now: () => 1000 })
  const gateway = {
    get: async (p: string) => gwState[p.split('?')[0]],
    put: async (p: string, _t: string, body: any) => { gwState[p.split('?')[0]] = actApply(p, gwState[p.split('?')[0]], body); return { ok: true } },
  } as never
  const d: ExecutorDeps = { changeSets: store, gateway, audit: new AuditLog(db, () => 1000), now: () => 1000, ...over }
  return { deps: d, store }
}
// helper: reflect the PUT into the read state so re-read shows "after"
function actApply(path: string, before: any, body: any) {
  if (path.includes('/switch')) return { ...before, is_active: body.is_active }
  if (path.includes('/package-configs')) return Object.entries(body.config_data).map(([pkg_oid, v]: any) => ({ pkg_oid, is_active: v.is_active, name: (before.find?.((x: any) => String(x.pkg_oid) === pkg_oid)?.name) }))
  return before
}
function seedProduct(store: ChangeSetStore, target: boolean) {
  store.create({ id: 'cs1', creatorLabel: 'owner@kkday.com', creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
    items: [{ prod_oid: 'p1', target_is_active: target }], diff: [{ prod_oid: 'p1', target_is_active: target, no_op: false }],
    diffVersion: 'v', status: 'approved', createdAt: 1000 })
}
describe('executeChangeSet', () => {
  it('product toggle: writes, records before/after, status done', async () => {
    const { deps: d, store } = deps({ '/product/api/v1/product-configs/p1/switch': { is_active: true, is_locked_for_active: false } })
    seedProduct(store, false)
    const out = (await executeChangeSet(d, 'cs1', WHO))!
    expect(out.status).toBe('done')
    expect(out.results[0]).toMatchObject({ item_key: 'p1', status: 'done', before: { is_active: true }, after: { is_active: false } })
    expect(store.get('cs1')!.status).toBe('done')
  })
  it('uses the injected identity: gateway PUT with who.accessToken, body carries who.modifyUser, audit rows carry who.sessionId/userLabel', async () => {
    const gwState: Record<string, any> = { '/product/api/v1/product-configs/p1/switch': { is_active: true, is_locked_for_active: false } }
    let putToken: string | undefined
    const db = openDb(':memory:'); const store = new ChangeSetStore(db, { now: () => 1000 })
    const gateway = {
      get: async (p: string) => gwState[p.split('?')[0]],
      put: async (p: string, t: string, body: any) => { putToken = t; gwState[p.split('?')[0]] = actApply(p, gwState[p.split('?')[0]], body); return { ok: true } },
    } as never
    const audit = new AuditLog(db, () => 1000)
    const d: ExecutorDeps = { changeSets: store, gateway, audit, now: () => 1000 }
    seedProduct(store, false)
    const out = (await executeChangeSet(d, 'cs1', WHO))!
    expect(out.status).toBe('done')
    expect(putToken).toBe('sess-token')
    const rows = audit.recent()
    const row = rows.find(r => r.tool === 'changeset.execute')
    expect(row).toMatchObject({ sessionId: 'websess-1', userLabel: 'approver@kkday.com' })
  })
  it('no-op is skipped (no write) when already in target', async () => {
    const { deps: d, store } = deps({ '/product/api/v1/product-configs/p1/switch': { is_active: false } })
    seedProduct(store, false)
    const out = (await executeChangeSet(d, 'cs1', WHO))!
    expect(out.results[0].status).toBe('skipped_noop')
  })
  it('plan read-merge-write preserves other pkgs', async () => {
    const db = openDb(':memory:'); const store = new ChangeSetStore(db, { now: () => 1000 })
    const state: Record<string, any> = { '/product/api/v1/products/p1/package-configs': [{ pkg_oid: 'k1', is_active: true, name: 'A', updated_by: 'U-old', updated_at: '2026-01-01' }, { pkg_oid: 'k2', is_active: true, name: 'B', updated_by: 'U-old', updated_at: '2026-01-01' }] }
    let putBody: any
    const gateway = { get: async (p: string) => state[p.split('?')[0]], put: async (_p: string, _t: string, body: any) => { putBody = body; return { ok: true } } } as never
    const d: ExecutorDeps = { changeSets: store, gateway, audit: new AuditLog(db, () => 1000), now: () => 1000 }
    store.create({ id: 'cs2', creatorLabel: 'owner@kkday.com', creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_plan',
      items: [{ prod_oid: 'p1', pkg_oid: 'k1', target_is_active: false }], diff: [{ prod_oid: 'p1', pkg_oid: 'k1', target_is_active: false, no_op: false }], diffVersion: 'v', status: 'approved', createdAt: 1000 })
    await executeChangeSet(d, 'cs2', WHO)
    // read-merge-write: PUT config_data MUST include BOTH k1 (flipped) and k2 (preserved),
    // and MUST preserve each pkg's other fields (name), not strip to {is_active}.
    expect(putBody.config_data.k1).toEqual({ is_active: false, name: 'A' })
    expect(putBody.config_data.k2).toEqual({ is_active: true, name: 'B' })
    // server-set read-only fields (Task 1 SIT probe finding #2) must never be echoed back in the PUT.
    expect(putBody.config_data.k1).not.toHaveProperty('updated_by')
    expect(putBody.config_data.k1).not.toHaveProperty('updated_at')
    expect(putBody.config_data.k2).not.toHaveProperty('updated_by')
    expect(putBody.config_data.k2).not.toHaveProperty('updated_at')
    expect(putBody.modify_user).toBe('UUID-1')
  })
  it('refuses to execute a non-approved change-set', async () => {
    const { deps: d, store } = deps({ '/product/api/v1/product-configs/p1/switch': { is_active: true } })
    seedProduct(store, false); store.setStatus('cs1', 'pending_approval')
    await expect(executeChangeSet(d, 'cs1', WHO)).rejects.toThrow()
  })
  it('serializes writes across prod_oid groups (no burst): max 1 concurrent PUT, and a failing group does not abort the rest', async () => {
    // Spec §6.3/§7: groups run one prod_oid at a time. p2's read is made to throw (unhandled
    // inside execProduct — the same kind of failure a real gateway outage would produce) to prove
    // per-group failure isolation still holds under the sequential loop: p2 is recorded failed but
    // p1 and p3 still execute. Concurrency is asserted via the PUT call, which the OLD
    // Promise.allSettled(groups.map(...)) implementation would fire for p1 and p3 in the same tick
    // (both groups' async work starts before either awaits its artificial 15ms PUT delay) — so this
    // test fails (maxInFlight === 2) against the pre-fix concurrent executor and passes (=== 1)
    // against the sequential one.
    const db = openDb(':memory:'); const store = new ChangeSetStore(db, { now: () => 1000 })
    const state: Record<string, any> = {
      '/product/api/v1/product-configs/p1/switch': { is_active: true },
      '/product/api/v1/product-configs/p3/switch': { is_active: true },
    }
    let inFlight = 0, maxInFlight = 0
    const gateway = {
      get: async (p: string) => {
        const path = p.split('?')[0]
        if (path.includes('/p2/')) throw new Error('p2 read failed')
        return state[path]
      },
      put: async (p: string, _t: string, body: any) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 15))
        state[p.split('?')[0]] = { ...state[p.split('?')[0]], is_active: body.is_active }
        inFlight--
        return { ok: true }
      },
    } as never
    const d: ExecutorDeps = { changeSets: store, gateway, audit: new AuditLog(db, () => 1000), now: () => 1000 }
    store.create({
      id: 'cs-multi', creatorLabel: 'owner@kkday.com', creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
      items: [
        { prod_oid: 'p1', target_is_active: false },
        { prod_oid: 'p2', target_is_active: false },
        { prod_oid: 'p3', target_is_active: false },
      ],
      diff: [], diffVersion: 'v', status: 'approved', createdAt: 1000,
    })
    const out = (await executeChangeSet(d, 'cs-multi', WHO))!
    expect(maxInFlight).toBe(1)
    expect(out.status).toBe('partial')
    const byKey = Object.fromEntries(out.results.map(r => [r.item_key, r.status]))
    expect(byKey.p1).toBe('done')
    expect(byKey.p2).toBe('failed')
    expect(byKey.p3).toBe('done')
  })

  it('I-2: a failed inventory item (quantity PUT rejected) audits as status "error" (not "ok")', async () => {
    // fullday SET (塊A): no more per-date "partial" — a single value either writes or fails. When
    // the quantity PUT is rejected (e.g. AU9403), the item is 'failed'; its audit row MUST be
    // 'error' so audit scans filtering on error do not miss it.
    const db = openDb(':memory:'); const store = new ChangeSetStore(db, { now: () => 1000 })
    const gateway = {
      get: async (p: string) => p.endsWith('/inventories/status') ? { is_processing: false } : {},
      post: async () => ({ i1: { fullday: 10 } }),
      put: async () => { throw Object.assign(new Error('403'), { code: 'AU9403' }) },
    } as never
    const audit = new AuditLog(db, () => 1000)
    const d: ExecutorDeps = { changeSets: store, gateway, audit, now: () => 1000 }
    const item: InventoryItem = { item_oid: 'i1', supplier_oid: 's1', quantity: 50 }
    store.create({
      id: 'cs-inv-fail', creatorLabel: 'owner@kkday.com', creatorBearerHash: 'bh', sessionId: 's', actionType: 'inventory_setting',
      items: [item], diff: [], diffVersion: 'v', status: 'approved', createdAt: 1000,
    })
    const out = (await executeChangeSet(d, 'cs-inv-fail', WHO))!
    expect(out.results[0].status).toBe('failed')
    const row = audit.recent().find(r => r.tool === 'changeset.execute' && (r.params as { item?: string }).item === 'i1:s1')
    expect(row?.status).toBe('error')
  })
})
