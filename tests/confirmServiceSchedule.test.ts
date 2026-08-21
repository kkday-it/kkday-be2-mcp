import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { approveAndExecute, type ConfirmServiceDeps } from '../src/core/changeset/confirmService.js'
import { executeChangeSet } from '../src/core/changeset/executor.js'
import { computeChangesetDiff } from '../src/core/changeset/diff.js'
import { getModule } from '../src/core/changeset/registry.js'
import '../src/modules/index.js'
import type { ChangeSetRecord } from '../src/core/changeset/types.js'
const WHO = { accessToken: 'tok', userLabel: 'owner@kkday.com', sessionId: 's1', identityId: 'id-test' }
let timeNow = 1000
function makeDeps(gateway: any): { store: ChangeSetStore; audit: AuditLog; deps: ConfirmServiceDeps } {
  const db = openDb(':memory:')
  const store = new ChangeSetStore(db, { now: () => timeNow })
  const audit = new AuditLog(db, () => timeNow)
  const deps: ConfirmServiceDeps = {
    changeSets: store, gateway, audit, now: () => timeNow,
    modifyUserFrom: (at: string) => 'U:' + at,
  }
  return { store, audit, deps }
}
function seedShelf(store: ChangeSetStore, id: string, schedule?: { executeAtUtc: number }): ChangeSetRecord {
  store.create({
    id, creatorLabel: WHO.userLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
    items: [{ prod_oid: 'p1', target_is_active: false }],
    diff: [], diffVersion: 'seed', status: 'pending_approval', createdAt: timeNow,
    schedule: schedule ? { executeAtUtc: schedule.executeAtUtc, wall: 'N/A', tz: 'UTC' } : undefined,
  })
  return store.get(id)!
}
function shelfGateway(live: { is_active: boolean } = { is_active: true }) {
  return {
    live,
    async get(path: string) {
      if (path.includes('/info')) return { name: 'Prod A' }
      return { is_active: live.is_active }
    },
    async put(_path: string, _at: string, body: Record<string, unknown>) {
      live.is_active = body.is_active as boolean
      return {}
    },
  }
}
async function realShelfDiffVersion(rec: ChangeSetRecord, gw: any): Promise<string> {
  const diff = await computeChangesetDiff(rec.actionType, rec.items, { gateway: gw, accessToken: WHO.accessToken, userLabel: rec.creatorLabel })
  return getModule(rec.actionType).diffVersion(diff)
}
describe('approveAndExecute - schedule branches', () => {
  it('1. 有 schedule + 回聲正確 → 回 { scheduled: true };store 內 status=scheduled、executorRef = who; execute 未被呼叫', async () => {
    timeNow = 1000
    const gw = shelfGateway()
    const putSpy = vi.spyOn(gw, 'put')
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-1', { executeAtUtc: 2000 })
    const version = await realShelfDiffVersion(rec, gw)
    const out = await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, channel: 'confirm_page', expectedExecuteAtUtc: 2000 })
    expect(out).toEqual({ scheduled: true })
    const updated = store.get('cs-1')!
    expect(updated.status).toBe('scheduled')
    expect(updated.executorRef).toEqual({ identityId: WHO.identityId, userLabel: WHO.userLabel, modifyUser: 'U:' + WHO.accessToken, sessionId: WHO.sessionId })
    expect(putSpy).not.toHaveBeenCalled()
  })
  it('2. 回聲不符(expectedExecuteAtUtc 差 1)→ throw SCHEDULE_ECHO_MISMATCH', async () => {
    timeNow = 1000
    const gw = shelfGateway()
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-2', { executeAtUtc: 2000 })
    const version = await realShelfDiffVersion(rec, gw)
    await expect(approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, channel: 'confirm_page', expectedExecuteAtUtc: 2001 }))
      .rejects.toMatchObject({ code: 'SCHEDULE_ECHO_MISMATCH', status: 409 })
  })
  it('3. 無 schedule 卻帶回聲 → 同 409;有 schedule 卻沒帶回聲 → 同 409', async () => {
    timeNow = 1000
    const gw = shelfGateway()
    const { store, deps } = makeDeps(gw)
    // 無 schedule 卻帶回聲
    const recNoSched = seedShelf(store, 'cs-3a')
    const ver1 = await realShelfDiffVersion(recNoSched, gw)
    await expect(approveAndExecute(deps, { rec: recNoSched, who: WHO, expectedDiffVersion: ver1, channel: 'confirm_page', expectedExecuteAtUtc: 2000 }))
      .rejects.toMatchObject({ code: 'SCHEDULE_ECHO_MISMATCH', status: 409 })
    // 有 schedule 卻沒帶回聲
    const recSched = seedShelf(store, 'cs-3b', { executeAtUtc: 2000 })
    const ver2 = await realShelfDiffVersion(recSched, gw)
    await expect(approveAndExecute(deps, { rec: recSched, who: WHO, expectedDiffVersion: ver2, channel: 'confirm_page', expectedExecuteAtUtc: undefined }))
      .rejects.toMatchObject({ code: 'SCHEDULE_ECHO_MISMATCH', status: 409 })
  })
  it('4. execute_at 已過(now > executeAtUtc)→ throw SCHEDULE_IN_PAST,status 仍 pending_approval', async () => {
    timeNow = 1000
    const gw = shelfGateway()
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-4', { executeAtUtc: 2000 })
    const version = await realShelfDiffVersion(rec, gw)
    timeNow = 2000 // now == executeAtUtc, still passed
    await expect(approveAndExecute(deps, { rec: store.get('cs-4')!, who: WHO, expectedDiffVersion: version, channel: 'confirm_page', expectedExecuteAtUtc: 2000 }))
      .rejects.toMatchObject({ code: 'SCHEDULE_IN_PAST', status: 409 })
    expect(store.get('cs-4')!.status).toBe('pending_approval')
  })
  it('5. 即時路徑(無 schedule)行為不變:回 {status, results}', async () => {
    timeNow = 1000
    const gw = shelfGateway()
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-5')
    const version = await realShelfDiffVersion(rec, gw)
    const out = await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, channel: 'confirm_page' })
    expect(out.status).toBeDefined()
    expect(out.results).toBeDefined()
    expect(out.scheduled).toBeUndefined()
    expect(store.get('cs-5')!.status).toBe('done')
  })
})
describe('executeChangeSet CAS 起點', () => {
  it('6. executor CAS 起點: status 不是 approved throw BAD_STATE; 併發 executeChangeSet CAS 輸的 null', async () => {
    timeNow = 1000
    const gw = shelfGateway()
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-6', { executeAtUtc: 2000 })
    const version = await realShelfDiffVersion(rec, gw)
    // 正常 schedule 批准
    await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, channel: 'confirm_page', expectedExecuteAtUtc: 2000 })
    expect(store.get('cs-6')!.status).toBe('scheduled')
    // 手動呼叫 executeChangeSet 因 status !== 'approved' throw BAD_STATE
    await expect(executeChangeSet(deps, 'cs-6', { ...WHO, modifyUser: 'U:'+WHO.accessToken, channel: 'scheduler' }))
      .rejects.toMatchObject({ code: 'BAD_STATE' })
    // 手動改為 approved
    store.setStatus('cs-6', 'approved', timeNow)
    
    // 兩個併發 executeChangeSet
    const p1 = executeChangeSet(deps, 'cs-6', { ...WHO, modifyUser: 'U:'+WHO.accessToken, channel: 'scheduler' })
    const p2 = executeChangeSet(deps, 'cs-6', { ...WHO, modifyUser: 'U:'+WHO.accessToken, channel: 'scheduler' })
    
    const [res1, res2] = await Promise.all([p1, p2])
    const results = [res1, res2]
    expect(results).toContain(null)
    const successResult = results.find(r => r !== null)
    expect(successResult).toBeDefined()
    expect(successResult!.status).toBeDefined()
  })
})
