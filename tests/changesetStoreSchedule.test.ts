import { describe, it, expect, beforeEach } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { IdentityStore } from '../src/store/identityStore.js'
import type { ChangeSetRecord } from '../src/core/changeset/types.js'

const EXEC = { identityId: 'id-1', userLabel: 'u@kkday.com', modifyUser: 'u', sessionId: 'sess-hash' }
function rec(id: string, over: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  return {
    id, creatorLabel: 'u@kkday.com', creatorBearerHash: 'h', sessionId: 's',
    actionType: 'inventory_setting', items: [{ item_oid: 'i1', supplier_oid: '0', quantity: 5 }],
    diff: [], diffVersion: 'v1', status: 'pending_approval', createdAt: 1000, ...over,
  }
}

describe('ChangeSetStore schedule fields + transitions', () => {
  let t = 1000
  let store: ChangeSetStore
  beforeEach(async () => { t = 1000; store = new ChangeSetStore(await openTestDb(), { now: () => t }) })

  it('roundtrips schedule fields through create/get', async () => {
    await store.create(rec('c1', { schedule: { executeAtUtc: 99_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' } }))
    const r = (await store.get('c1'))!
    expect(r.schedule).toEqual({ executeAtUtc: 99_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' })
    expect(r.executorRef).toBeUndefined()
  })

  it('setScheduled: CAS pending_approval→scheduled + persists executorRef; loses when already decided', async () => {
    await store.create(rec('c1', { schedule: { executeAtUtc: 99_000, wall: 'w', tz: 'z' } }))
    expect(await store.setScheduled('c1', EXEC, 2000)).toBe(true)
    const r = (await store.get('c1'))!
    expect(r.status).toBe('scheduled')
    expect(r.executorRef).toEqual(EXEC)
    expect(await store.setScheduled('c1', EXEC, 2000)).toBe(false)   // 已離開 pending_approval
  })

  it('scheduled is NOT lazily TTL-expired (expiry only applies to pending_approval)', async () => {
    await store.create(rec('c1', { schedule: { executeAtUtc: 99_000, wall: 'w', tz: 'z' } }))
    await store.setScheduled('c1', EXEC, 2000)
    t = 1000 + 25 * 3600_000   // 超過預設 24h TTL
    expect((await store.get('c1'))!.status).toBe('scheduled')
  })

  it('listDueScheduled / claimScheduled: claim is CAS (double claim loses) and stamps claimed_at', async () => {
    await store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' } }))
    await store.setScheduled('c1', EXEC, 2000)
    expect(await store.listDueScheduled(4999)).toEqual([])
    expect(await store.listDueScheduled(5000)).toEqual(['c1'])
    expect(await store.claimScheduled('c1', 5000)).toBe(true)
    expect(await store.claimScheduled('c1', 5000)).toBe(false)
    expect((await store.get('c1'))!.status).toBe('approved')
    expect((await store.get('c1'))!.scheduleClaimedAt).toBe(5000)
  })

  it('releaseClaim puts an approved schedule back; listStrandedApproved finds stale claims only', async () => {
    await store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' } }))
    await store.setScheduled('c1', EXEC, 2000); await store.claimScheduled('c1', 5000)
    // 即時批准路徑的 approved(無 schedule)不得被撈到
    await store.create(rec('c2')); await store.casStatus('c2', 'pending_approval', 'approved')
    expect(await store.listStrandedApproved(5000 + 599_000, 600_000)).toEqual([])
    expect(await store.listStrandedApproved(5000 + 600_001, 600_000)).toEqual(['c1'])
    expect(await store.releaseClaim('c1')).toBe(true)
    expect((await store.get('c1'))!.status).toBe('scheduled')
  })

  it('listScheduledIdentityIds returns distinct executor identities of scheduled sets only', async () => {
    await store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' } }))
    await store.setScheduled('c1', EXEC, 2000)
    await store.create(rec('c2', { schedule: { executeAtUtc: 6000, wall: 'w', tz: 'z' } }))
    await store.setScheduled('c2', EXEC, 2000)
    expect(await store.listScheduledIdentityIds()).toEqual(['id-1'])

    // Test listScheduledIdsByIdentity too
    expect(await store.listScheduledIdsByIdentity('id-1')).toEqual(['c1', 'c2'])
    expect(await store.listScheduledIdsByIdentity('id-none')).toEqual([])
  })

  // listExecutingScheduled：啟動時 stranded-executing 掃描用（scheduler.ts auditStranded）。
  // 舊測試檔沒有這條 pin（Task 6 才補上，因 §6 CAS 系列 brief 明文要求覆蓋 claim 系列全貌）。
  it('listExecutingScheduled returns only status=executing rows with a schedule', async () => {
    await store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' }, status: 'executing' }))
    await store.create(rec('c2', { status: 'executing' })) // no schedule -> not a scheduled-executing row
    await store.create(rec('c3', { schedule: { executeAtUtc: 6000, wall: 'w', tz: 'z' }, status: 'scheduled' }))
    expect(await store.listExecutingScheduled()).toEqual(['c1'])
  })
})

describe('IdentityStore.claimKeepalive', () => {
  it('first claim wins, second within TTL loses, after TTL wins again', async () => {
    const db = await openTestDb()
    const ids = new IdentityStore(db)
    await ids.upsert({ identityId: 'id-1', userLabel: 'u', accessToken: 'a', refreshToken: 'r', businessList: [], accessExpiresAt: 0, updatedAt: 0 })
    expect(await ids.claimKeepalive('id-1', 10_000, 30_000)).toBe(true)
    expect(await ids.claimKeepalive('id-1', 20_000, 30_000)).toBe(false)
    expect(await ids.claimKeepalive('id-1', 40_001, 30_000)).toBe(true)
    expect(await ids.claimKeepalive('nope', 10_000, 30_000)).toBe(false)
  })
})
