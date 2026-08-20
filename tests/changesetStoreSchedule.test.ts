import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/store/db.js'
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
  beforeEach(() => { t = 1000; store = new ChangeSetStore(openDb(':memory:'), { now: () => t }) })

  it('roundtrips schedule fields through create/get', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 99_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' } }))
    const r = store.get('c1')!
    expect(r.schedule).toEqual({ executeAtUtc: 99_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' })
    expect(r.executorRef).toBeUndefined()
  })

  it('setScheduled: CAS pending_approval→scheduled + persists executorRef; loses when already decided', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 99_000, wall: 'w', tz: 'z' } }))
    expect(store.setScheduled('c1', EXEC, 2000)).toBe(true)
    const r = store.get('c1')!
    expect(r.status).toBe('scheduled')
    expect(r.executorRef).toEqual(EXEC)
    expect(store.setScheduled('c1', EXEC, 2000)).toBe(false)   // 已離開 pending_approval
  })

  it('scheduled is NOT lazily TTL-expired (expiry only applies to pending_approval)', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 99_000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c1', EXEC, 2000)
    t = 1000 + 25 * 3600_000   // 超過預設 24h TTL
    expect(store.get('c1')!.status).toBe('scheduled')
  })

  it('listDueScheduled / claimScheduled: claim is CAS (double claim loses) and stamps claimed_at', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c1', EXEC, 2000)
    expect(store.listDueScheduled(4999)).toEqual([])
    expect(store.listDueScheduled(5000)).toEqual(['c1'])
    expect(store.claimScheduled('c1', 5000)).toBe(true)
    expect(store.claimScheduled('c1', 5000)).toBe(false)
    expect(store.get('c1')!.status).toBe('approved')
    expect(store.get('c1')!.scheduleClaimedAt).toBe(5000)
  })

  it('releaseClaim puts an approved schedule back; listStrandedApproved finds stale claims only', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c1', EXEC, 2000); store.claimScheduled('c1', 5000)
    // 即時批准路徑的 approved(無 schedule)不得被撈到
    store.create(rec('c2')); store.casStatus('c2', 'pending_approval', 'approved')
    expect(store.listStrandedApproved(5000 + 599_000, 600_000)).toEqual([])
    expect(store.listStrandedApproved(5000 + 600_001, 600_000)).toEqual(['c1'])
    expect(store.releaseClaim('c1')).toBe(true)
    expect(store.get('c1')!.status).toBe('scheduled')
  })

  it('listScheduledIdentityIds returns distinct executor identities of scheduled sets only', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c1', EXEC, 2000)
    store.create(rec('c2', { schedule: { executeAtUtc: 6000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c2', EXEC, 2000)
    expect(store.listScheduledIdentityIds()).toEqual(['id-1'])
    
    // Test listScheduledIdsByIdentity too
    expect(store.listScheduledIdsByIdentity('id-1')).toEqual(['c1', 'c2'])
    expect(store.listScheduledIdsByIdentity('id-none')).toEqual([])
  })
})

describe('IdentityStore.claimKeepalive', () => {
  it('first claim wins, second within TTL loses, after TTL wins again', () => {
    const db = openDb(':memory:')
    const ids = new IdentityStore(db)
    ids.upsert({ identityId: 'id-1', userLabel: 'u', accessToken: 'a', refreshToken: 'r', businessList: [], accessExpiresAt: 0, updatedAt: 0 })
    expect(ids.claimKeepalive('id-1', 10_000, 30_000)).toBe(true)
    expect(ids.claimKeepalive('id-1', 20_000, 30_000)).toBe(false)
    expect(ids.claimKeepalive('id-1', 40_001, 30_000)).toBe(true)
    expect(ids.claimKeepalive('nope', 10_000, 30_000)).toBe(false)
  })
})
