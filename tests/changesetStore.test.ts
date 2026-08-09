import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import type { ChangeSetRecord } from '../src/changeset/types.js'

function rec(over: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  return {
    id: 'cs1', creatorLabel: 'p@kkday.com', creatorBearerHash: 'bh', sessionId: 's1',
    actionType: 'shelf_toggle_product', items: [{ prod_oid: '1', target_is_active: false }],
    diff: [{ prod_oid: '1', target_is_active: false, no_op: false, current_is_active: true }],
    diffVersion: 'v1', status: 'pending_approval', approvalTokenHash: ChangeSetStore.hashToken('tok'),
    createdAt: 1000, ...over,
  }
}
describe('ChangeSetStore', () => {
  it('round-trips a record', () => {
    const s = new ChangeSetStore(openDb(':memory:'), { now: () => 1000 })
    s.create(rec())
    const got = s.get('cs1')!
    expect(got).toMatchObject({ id: 'cs1', creatorLabel: 'p@kkday.com', actionType: 'shelf_toggle_product', status: 'pending_approval' })
    expect(got.items).toEqual([{ prod_oid: '1', target_is_active: false }])
    expect(got.diff[0].current_is_active).toBe(true)
  })
  it('lazily expires a pending change-set past ttl', () => {
    let t = 1000
    const s = new ChangeSetStore(openDb(':memory:'), { now: () => t, ttlMs: 100 })
    s.create(rec())
    t = 1000 + 200
    expect(s.get('cs1')!.status).toBe('expired')
  })
  it('does NOT expire an already-approved change-set', () => {
    let t = 1000
    const s = new ChangeSetStore(openDb(':memory:'), { now: () => t, ttlMs: 100 })
    s.create(rec({ status: 'approved' }))
    t = 1000 + 200
    expect(s.get('cs1')!.status).toBe('approved')
  })
  it('setStatus + records/getResults round-trip', () => {
    const s = new ChangeSetStore(openDb(':memory:'), { now: () => 1000 })
    s.create(rec())
    s.setStatus('cs1', 'done', 2000)
    expect(s.get('cs1')!.status).toBe('done')
    s.recordResults('cs1', [{ item_key: '1', status: 'done', before: { is_active: true }, after: { is_active: false }, trace_id: 'tr' }])
    expect(s.getResults('cs1')).toEqual([{ item_key: '1', status: 'done', before: { is_active: true }, after: { is_active: false }, trace_id: 'tr', error_code: undefined, error_message: undefined }])
  })
  it('getResults returns rows ordered by item_key regardless of insert order', () => {
    const s = new ChangeSetStore(openDb(':memory:'), { now: () => 1000 })
    s.create(rec())
    s.recordResults('cs1', [
      { item_key: 'z-last', status: 'done', trace_id: 'tr' },
      { item_key: 'a-first', status: 'done', trace_id: 'tr' },
      { item_key: 'm-mid', status: 'done', trace_id: 'tr' },
    ])
    expect(s.getResults('cs1').map(r => r.item_key)).toEqual(['a-first', 'm-mid', 'z-last'])
  })
  it('hashToken is sha256 hex and stable', () => {
    expect(ChangeSetStore.hashToken('x')).toMatch(/^[0-9a-f]{64}$/)
    expect(ChangeSetStore.hashToken('x')).toBe(ChangeSetStore.hashToken('x'))
  })
  it('casStatus transitions only when current status matches `from`, and reports who won', () => {
    const s = new ChangeSetStore(openDb(':memory:'), { now: () => 1000 })
    s.create(rec({ status: 'pending_approval' }))
    // wrong `from` (already 'approved', not 'pending_approval') -> no-op, returns false
    expect(s.casStatus('cs1', 'approved', 'executing')).toBe(false)
    expect(s.get('cs1')!.status).toBe('pending_approval')
    // correct `from` -> transitions, returns true
    expect(s.casStatus('cs1', 'pending_approval', 'approved', 2000)).toBe(true)
    expect(s.get('cs1')!.status).toBe('approved')
    expect(s.get('cs1')!.decidedAt).toBe(2000)
    // second call with the same `from` no longer matches (status is now 'approved') -> false,
    // simulating the loser of a concurrent CAS race
    expect(s.casStatus('cs1', 'pending_approval', 'approved', 3000)).toBe(false)
    expect(s.get('cs1')!.status).toBe('approved')
    expect(s.get('cs1')!.decidedAt).toBe(2000)
  })
})
