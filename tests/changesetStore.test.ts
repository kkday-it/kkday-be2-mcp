import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import type { ChangeSetRecord, DiffItem } from '../src/changeset/types.js'

function rec(over: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  return {
    id: 'cs1', creatorLabel: 'p@kkday.com', creatorBearerHash: 'bh', sessionId: 's1',
    actionType: 'shelf_toggle_product', items: [{ prod_oid: '1', target_is_active: false }],
    diff: [{ prod_oid: '1', target_is_active: false, no_op: false, current_is_active: true }],
    diffVersion: 'v1', status: 'pending_approval',
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
    expect((got.diff[0] as DiffItem).current_is_active).toBe(true)
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
  // Final whole-branch review Important 2: app_get_changeset_view always returned the diff/
  // diff_version stored at CREATION time — the panel's DIFF_STALE recovery path had no way to ever
  // converge, because nothing ever wrote a fresher diff back to the store. updateDiff is that
  // write-back primitive: confirmService.approveAndExecute calls it when it detects staleness, so
  // the next view/approval attempt reads the recomputed diff instead of the stale original.
  it('updateDiff overwrites diff/diff_version while still pending_approval', () => {
    const s = new ChangeSetStore(openDb(':memory:'), { now: () => 1000 })
    s.create(rec())
    const newDiff: DiffItem[] = [{ prod_oid: '1', target_is_active: false, no_op: true, current_is_active: false }]
    const won = s.updateDiff('cs1', newDiff, 'v2')
    expect(won).toBe(true)
    const got = s.get('cs1')!
    expect(got.diffVersion).toBe('v2')
    expect(got.diff).toEqual(newDiff)
  })
  it('updateDiff is a no-op (returns false) once the change-set has left pending_approval', () => {
    const s = new ChangeSetStore(openDb(':memory:'), { now: () => 1000 })
    s.create(rec({ status: 'approved' }))
    const won = s.updateDiff('cs1', [], 'v2')
    expect(won).toBe(false)
    const got = s.get('cs1')!
    expect(got.diffVersion).toBe('v1')   // untouched — approved change-set's diff must not be rewritten
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
