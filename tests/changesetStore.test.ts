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
  it('hashToken is sha256 hex and stable', () => {
    expect(ChangeSetStore.hashToken('x')).toMatch(/^[0-9a-f]{64}$/)
    expect(ChangeSetStore.hashToken('x')).toBe(ChangeSetStore.hashToken('x'))
  })
})
