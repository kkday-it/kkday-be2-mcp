import { describe, it, expect } from 'vitest'
import { execShelfSchedule, type ExecutorContext } from '../src/modules/product/shelfSchedule/executor.js'
import { approveAndExecute, type ConfirmServiceDeps } from '../src/core/changeset/confirmService.js'
import { computeChangesetDiff } from '../src/core/changeset/diff.js'
import { shelfScheduleModule } from '../src/modules/product/shelfSchedule/module.js'
const diffVersionHash = shelfScheduleModule.diffVersion as (d: unknown[]) => string
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { openTestDb } from './support/testDb.js'
import type { ChangeSetRecord, ShelfScheduleItem } from '../src/core/changeset/types.js'

// Task 4 定案 read/write endpoints (design doc §4.1):
// GET /product/api/v1/products/{prodOid}/package-configs -> array of pkg rows
// PUT /product/api/v1/products/{prodOid}/package-configs/reserve-active
//   body { config_data: { [pkgOid]: { reserve_date: null, reserve_status: null, reserve_queue: [...] } }, modify_user }
function fakeGw(rowsByProd: Record<string, Array<Record<string, unknown>>>, opts: { putShouldFail?: Set<string> } = {}) {
  const calls: Array<{ m: string; path: string; body?: unknown }> = []
  return {
    calls,
    rowsByProd,
    async get(path: string) {
      calls.push({ m: 'GET', path })
      const m = /\/products\/([^/]+)\/package-configs$/.exec(path)!
      return rowsByProd[m[1]] ?? []
    },
    async put(path: string, _at: string, body: unknown) {
      calls.push({ m: 'PUT', path, body })
      const m = /\/products\/([^/]+)\/package-configs\/reserve-active$/.exec(path)!
      const prodOid = m[1]
      if (opts.putShouldFail?.has(prodOid)) throw Object.assign(new Error('boom'), { code: 'GW_500' })
    },
  }
}
const ctxOf = (gw: unknown): ExecutorContext => ({ gateway: gw as never, accessToken: 'at', modifyUser: 'MU', traceId: 't1' })
function recOf(items: ShelfScheduleItem[]): ChangeSetRecord {
  return {
    id: 'cs1', creatorLabel: 'u@kkday.com', creatorBearerHash: 'bh', sessionId: 's1', actionType: 'shelf_schedule',
    items, diff: [], diffVersion: 'v', status: 'approved', createdAt: 1000,
  }
}
const row = (pkg_oid: string, reserve_queue: Array<{ reserve_date: string; reserve_status: boolean }> = []) =>
  ({ pkg_oid, name: `Plan ${pkg_oid}`, is_bundle: false, reserve_queue })

describe('execShelfSchedule', () => {
  it('3 items across 2 prod_oids -> exactly 2 PUTs, grouped with multi-pkg config_data', async () => {
    const items: ShelfScheduleItem[] = [
      { prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] },
      { prod_oid: 'p1', pkg_oid: 'k2', queue: [{ reserve_date_utc: '2027-01-02 00:00:00', reserve_status: true }] },
      { prod_oid: 'p2', pkg_oid: 'k3', queue: [{ reserve_date_utc: '2027-01-03 00:00:00', reserve_status: true }] },
    ]
    const gw = fakeGw({ p1: [row('k1'), row('k2')], p2: [row('k3')] })
    const results = await execShelfSchedule(recOf(items), ctxOf(gw))
    const puts = gw.calls.filter(c => c.m === 'PUT')
    expect(puts).toHaveLength(2)
    const p1Put = puts.find(p => p.path === '/product/api/v1/products/p1/package-configs/reserve-active')!
    expect(Object.keys((p1Put.body as { config_data: object }).config_data)).toEqual(['k1', 'k2'])
    expect(results).toHaveLength(3)
    expect(results.every(r => r.status === 'done')).toBe(true)
  })

  it('one prod PUT fails -> the other prod group still succeeds (failure isolation)', async () => {
    const items: ShelfScheduleItem[] = [
      { prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] },
      { prod_oid: 'p2', pkg_oid: 'k2', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] },
    ]
    const gw = fakeGw({ p1: [row('k1')], p2: [row('k2')] }, { putShouldFail: new Set(['p1']) })
    const results = await execShelfSchedule(recOf(items), ctxOf(gw))
    const r1 = results.find(r => r.item_key === 'p1:k1')!
    const r2 = results.find(r => r.item_key === 'p2:k2')!
    expect(r1.status).toBe('failed')
    expect(r1.error_code).toBe('GW_500')
    expect(r2.status).toBe('done')
  })

  it('empty queue (clear schedule) sends reserve_queue: [] in the PUT body', async () => {
    const items: ShelfScheduleItem[] = [{ prod_oid: 'p1', pkg_oid: 'k1', queue: [] }]
    const gw = fakeGw({ p1: [row('k1', [{ reserve_date: '2027-01-01 00:00:00', reserve_status: true }])] })
    const results = await execShelfSchedule(recOf(items), ctxOf(gw))
    const put = gw.calls.find(c => c.m === 'PUT')!
    const body = put.body as { config_data: Record<string, { reserve_date: null; reserve_status: null; reserve_queue: unknown[] }>; modify_user: string }
    expect(body.config_data.k1).toEqual({ reserve_date: null, reserve_status: null, reserve_queue: [] })
    expect(body.modify_user).toBe('MU')
    expect(results[0].status).toBe('done')
  })

  it('noop item (current queue already equals target) -> skipped_noop, no PUT for a fully-noop group', async () => {
    const items: ShelfScheduleItem[] = [{ prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] }]
    const gw = fakeGw({ p1: [row('k1', [{ reserve_date: '2027-01-01 00:00:00', reserve_status: true }])] })
    const results = await execShelfSchedule(recOf(items), ctxOf(gw))
    expect(results[0].status).toBe('skipped_noop')
    expect(gw.calls.some(c => c.m === 'PUT')).toBe(false)
  })

  it('mixed group (one noop pkg, one real change) -> PUT issued, only the changed pkg in config_data, both results recorded per-pkg', async () => {
    const items: ShelfScheduleItem[] = [
      { prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] }, // noop
      { prod_oid: 'p1', pkg_oid: 'k2', queue: [{ reserve_date_utc: '2027-02-01 00:00:00', reserve_status: true }] }, // real change
    ]
    const gw = fakeGw({
      p1: [row('k1', [{ reserve_date: '2027-01-01 00:00:00', reserve_status: true }]), row('k2')],
    })
    const results = await execShelfSchedule(recOf(items), ctxOf(gw))
    const put = gw.calls.find(c => c.m === 'PUT')!
    expect(Object.keys((put.body as { config_data: object }).config_data)).toEqual(['k2'])
    expect(results.find(r => r.item_key === 'p1:k1')?.status).toBe('skipped_noop')
    expect(results.find(r => r.item_key === 'p1:k2')?.status).toBe('done')
  })
})

// --- itemKeysOf pin (mirrors the Task 3 review pin in tests/executorPlatform.test.ts): even
// though ShelfScheduleItem happens to have {prod_oid, pkg_oid} field names identical to the
// generic shelf ChangeSetItem (so the duck-typed itemKey() cast would coincidentally produce the
// right key), Task 4 adds an EXPLICIT branch in itemKeysOf — this test locks that branch so a
// future refactor can't silently regress it back to relying on the coincidence.
describe('itemKeysOf — shelf_schedule key rule (Task 4)', () => {
  const WHO = { accessToken: 'tok', userLabel: 'owner@kkday.com', sessionId: 's1', identityId: 'id-test' }

  async function makeDeps(gateway: { get: Function; put: Function }): Promise<{ store: ChangeSetStore; deps: ConfirmServiceDeps }> {
    const db = await openTestDb()
    const store = new ChangeSetStore(db, { now: () => 1000 })
    const audit = new AuditLog(db, () => 1000)
    const deps: ConfirmServiceDeps = {
      changeSets: store, gateway: Object.assign(Object.create(gateway), { withTrace() { return this } }) as never, audit, now: () => 1000,
      modifyUserFrom: (at: string) => 'U:' + at,
    }
    return { store, deps }
  }
  async function seedSchedule(store: ChangeSetStore, id: string, items: ShelfScheduleItem[]): Promise<ChangeSetRecord> {
    await store.create({
      id, creatorLabel: WHO.userLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_schedule',
      items, diff: [], diffVersion: 'seed', status: 'pending_approval', createdAt: 1000,
    })
    return (await store.get(id))!
  }
  async function realVersion(rec: ChangeSetRecord, gw: { get: Function; put: Function }): Promise<string> {
    const diff = await computeChangesetDiff(rec.actionType, rec.items, { gateway: gw as never, accessToken: WHO.accessToken, userLabel: rec.creatorLabel, traceId: 't'.repeat(32) })
    return diffVersionHash(diff)
  }

  it('confirmedKeys = ["prod_oid:pkg_oid"] passes the gate (reaches execution)', async () => {
    const items: ShelfScheduleItem[] = [{ prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] }]
    const gw = fakeGw({ p1: [row('k1')] })
    const { store, deps } = await makeDeps(gw)
    const rec = await seedSchedule(store, 'cs-s1', items)
    const version = await realVersion(rec, gw)
    const out = await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['p1:k1'], channel: 'panel' })
    expect(out.stale).toBeUndefined()
    expect(out.casFailed).toBeUndefined()
    expect(out.status).toBeDefined()
  })

  it('confirmedKeys missing the key throws CONFIRMED_KEYS_MISMATCH, never executes', async () => {
    const items: ShelfScheduleItem[] = [{ prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] }]
    const gw = fakeGw({ p1: [row('k1')] })
    const { store, deps } = await makeDeps(gw)
    const rec = await seedSchedule(store, 'cs-s2', items)
    const version = await realVersion(rec, gw)
    await expect(approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: [], channel: 'panel' }))
      .rejects.toMatchObject({ code: 'CONFIRMED_KEYS_MISMATCH' })
    expect((await store.get('cs-s2'))!.status).toBe('pending_approval')
  })
})
