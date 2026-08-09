import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { executeChangeSet, type ExecutorDeps } from '../src/changeset/executor.js'
import { AppError } from '../src/errors.js'

function deps(gwState: Record<string, any>, over: Partial<ExecutorDeps> = {}): { deps: ExecutorDeps; store: ChangeSetStore } {
  const db = openDb(':memory:')
  const store = new ChangeSetStore(db, { now: () => 1000 })
  const gateway = {
    get: async (p: string) => gwState[p.split('?')[0]],
    put: async (p: string, _t: string, body: any) => { gwState[p.split('?')[0]] = actApply(p, gwState[p.split('?')[0]], body); return { ok: true } },
  } as never
  const tokenManager = { getFreshByHash: vi.fn(async () => ({ accessToken: 'fake', userLabel: 'owner@kkday.com', businessList: [] })) } as never
  const d: ExecutorDeps = { changeSets: store, tokenManager, gateway, audit: new AuditLog(db, () => 1000), modifyUserFrom: () => 'UUID-1', now: () => 1000, ...over }
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
    diffVersion: 'v', status: 'approved', approvalTokenHash: 'h', createdAt: 1000 })
}
describe('executeChangeSet', () => {
  it('product toggle: writes, records before/after, status done', async () => {
    const { deps: d, store } = deps({ '/product/api/v1/product-configs/p1/switch': { is_active: true, is_locked_for_active: false } })
    seedProduct(store, false)
    const out = await executeChangeSet(d, 'cs1')
    expect(out.status).toBe('done')
    expect(out.results[0]).toMatchObject({ item_key: 'p1', status: 'done', before: { is_active: true }, after: { is_active: false } })
    expect(store.get('cs1')!.status).toBe('done')
  })
  it('no-op is skipped (no write) when already in target', async () => {
    const { deps: d, store } = deps({ '/product/api/v1/product-configs/p1/switch': { is_active: false } })
    seedProduct(store, false)
    const out = await executeChangeSet(d, 'cs1')
    expect(out.results[0].status).toBe('skipped_noop')
  })
  it('plan read-merge-write preserves other pkgs', async () => {
    const db = openDb(':memory:'); const store = new ChangeSetStore(db, { now: () => 1000 })
    const state: Record<string, any> = { '/product/api/v1/products/p1/package-configs': [{ pkg_oid: 'k1', is_active: true, name: 'A', updated_by: 'U-old', updated_at: '2026-01-01' }, { pkg_oid: 'k2', is_active: true, name: 'B', updated_by: 'U-old', updated_at: '2026-01-01' }] }
    let putBody: any
    const gateway = { get: async (p: string) => state[p.split('?')[0]], put: async (_p: string, _t: string, body: any) => { putBody = body; return { ok: true } } } as never
    const d: ExecutorDeps = { changeSets: store, tokenManager: { getFreshByHash: async () => ({ accessToken: 'f', userLabel: 'owner@kkday.com', businessList: [] }) } as never, gateway, audit: new AuditLog(db, () => 1000), modifyUserFrom: () => 'U', now: () => 1000 }
    store.create({ id: 'cs2', creatorLabel: 'owner@kkday.com', creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_plan',
      items: [{ prod_oid: 'p1', pkg_oid: 'k1', target_is_active: false }], diff: [{ prod_oid: 'p1', pkg_oid: 'k1', target_is_active: false, no_op: false }], diffVersion: 'v', status: 'approved', approvalTokenHash: 'h', createdAt: 1000 })
    await executeChangeSet(d, 'cs2')
    // read-merge-write: PUT config_data MUST include BOTH k1 (flipped) and k2 (preserved),
    // and MUST preserve each pkg's other fields (name), not strip to {is_active}.
    expect(putBody.config_data.k1).toEqual({ is_active: false, name: 'A' })
    expect(putBody.config_data.k2).toEqual({ is_active: true, name: 'B' })
    // server-set read-only fields (Task 1 SIT probe finding #2) must never be echoed back in the PUT.
    expect(putBody.config_data.k1).not.toHaveProperty('updated_by')
    expect(putBody.config_data.k1).not.toHaveProperty('updated_at')
    expect(putBody.config_data.k2).not.toHaveProperty('updated_by')
    expect(putBody.config_data.k2).not.toHaveProperty('updated_at')
    expect(putBody.modify_user).toBe('U')
  })
  it('refuses to execute a non-approved change-set', async () => {
    const { deps: d, store } = deps({ '/product/api/v1/product-configs/p1/switch': { is_active: true } })
    seedProduct(store, false); store.setStatus('cs1', 'pending_approval')
    await expect(executeChangeSet(d, 'cs1')).rejects.toThrow()
  })
  it('token-refresh failure -> change-set marked failed, NOT stuck in executing', async () => {
    const { deps: d, store } = deps({ '/product/api/v1/product-configs/p1/switch': { is_active: true } })
    seedProduct(store, false)
    ;(d.tokenManager.getFreshByHash as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('reauth'), { code: 'REAUTH_REQUIRED' }))
    await expect(executeChangeSet(d, 'cs1')).rejects.toThrow()
    expect(store.get('cs1')!.status).toBe('failed')
  })
  it('modifyUserFrom throw (Fix 4 guard tripped) -> change-set marked failed, NOT stuck in executing', async () => {
    // Same early-throw guard as the token-refresh case above: modifyUserFrom is called right
    // after getFreshByHash, inside the same try block. If the placeholder guard trips (env flag
    // unset), the executor must not strand the change-set in 'executing' forever.
    const { deps: d, store } = deps({ '/product/api/v1/product-configs/p1/switch': { is_active: true } },
      { modifyUserFrom: () => { throw new AppError('MODIFY_USER_UNRESOLVED', 'modify_user resolver not wired', 500) } })
    seedProduct(store, false)
    await expect(executeChangeSet(d, 'cs1')).rejects.toThrow('modify_user resolver not wired')
    expect(store.get('cs1')!.status).toBe('failed')
  })
})
