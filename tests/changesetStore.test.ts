import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import type { ChangeSetRecord, DiffItem } from '../src/core/changeset/types.js'

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
  // Task 5 precedent (webSessionStore.test.ts)：原本這裡有一條「openDb 對 legacy on-disk
  // change_sets（含 approval_token_hash NOT NULL）自動移除該欄」的回歸測試，測的是舊
  // src/store/db.ts（better-sqlite3 開檔時偵測到舊 schema 就地 ALTER）這個 SQLite-only 行為。
  // PG 版沒有「開檔時發現欄位對不上就重建/改欄」這回事——schema 一律由 db/migrations/ 的
  // forward-only migrations 定義（baseline 早已不含 approval_token_hash）。在 Db 抽象下這條
  // 測試沒有對應語意，移除；不構成 ChangeSetStore 本身覆蓋率的弱化。
  it('round-trips a record', async () => {
    const s = new ChangeSetStore(await openTestDb(), { now: () => 1000 })
    await s.create(rec())
    const got = (await s.get('cs1'))!
    expect(got).toMatchObject({ id: 'cs1', creatorLabel: 'p@kkday.com', actionType: 'shelf_toggle_product', status: 'pending_approval' })
    expect(got.items).toEqual([{ prod_oid: '1', target_is_active: false }])
    expect((got.diff[0] as DiffItem).current_is_active).toBe(true)
  })
  it('lazily expires a pending change-set past ttl', async () => {
    let t = 1000
    const s = new ChangeSetStore(await openTestDb(), { now: () => t, ttlMs: 100 })
    await s.create(rec())
    t = 1000 + 200
    expect((await s.get('cs1'))!.status).toBe('expired')
  })
  // lazy expiry 改成單條條件式 UPDATE 先行（spec §3.3）——這條 pin 住「UPDATE 真的把
  // status 持久化進 DB，不只是 get() 回傳值裡臨時覆寫」：直接開第二個 store 實例（獨立
  // now()，但共用同一個底層 PGlite db 需要同一個 Db 物件；PGlite 是 in-process，故改用
  // 同一個 db 實例、第二個 store 指標）重新 get 一次，驗證仍讀到 'expired'。
  it('get() 過期後 status=expired 且已持久化進 DB（非僅回傳值覆寫）', async () => {
    const db = await openTestDb()
    let t = 1000
    const s = new ChangeSetStore(db, { now: () => t, ttlMs: 100 })
    await s.create(rec())
    t = 1000 + 200
    expect((await s.get('cs1'))!.status).toBe('expired')
    // 換一個完全獨立的 store 實例（now() 卡在過期前）重讀同一顆 db：若過期只發生在
    // 回傳值層面而未寫回 DB，這裡會讀到 'pending_approval'。
    const reread = new ChangeSetStore(db, { now: () => 1000 })
    expect((await reread.get('cs1'))!.status).toBe('expired')
  })
  it('does NOT expire an already-approved change-set', async () => {
    let t = 1000
    const s = new ChangeSetStore(await openTestDb(), { now: () => t, ttlMs: 100 })
    await s.create(rec({ status: 'approved' }))
    t = 1000 + 200
    expect((await s.get('cs1'))!.status).toBe('approved')
  })
  it('setStatus + records/getResults round-trip', async () => {
    const s = new ChangeSetStore(await openTestDb(), { now: () => 1000 })
    await s.create(rec())
    await s.setStatus('cs1', 'done', 2000)
    expect((await s.get('cs1'))!.status).toBe('done')
    await s.recordResults('cs1', [{ item_key: '1', status: 'done', before: { is_active: true }, after: { is_active: false }, trace_id: 'tr' }])
    expect(await s.getResults('cs1')).toEqual([{ item_key: '1', status: 'done', before: { is_active: true }, after: { is_active: false }, trace_id: 'tr', error_code: undefined, error_message: undefined }])
  })
  it('getResults returns rows ordered by item_key regardless of insert order', async () => {
    const s = new ChangeSetStore(await openTestDb(), { now: () => 1000 })
    await s.create(rec())
    await s.recordResults('cs1', [
      { item_key: 'z-last', status: 'done', trace_id: 'tr' },
      { item_key: 'a-first', status: 'done', trace_id: 'tr' },
      { item_key: 'm-mid', status: 'done', trace_id: 'tr' },
    ])
    expect((await s.getResults('cs1')).map(r => r.item_key)).toEqual(['a-first', 'm-mid', 'z-last'])
  })
  // recordResults 的 ON CONFLICT ... DO UPDATE：同一 (changeset_id, item_key) 二度寫入應覆蓋、
  // 不應報錯或殘留舊值——pin 住 upsert 語意（brief 明文要求覆蓋測試）。
  it('recordResults upserts: second call for the same item_key overwrites, not duplicates', async () => {
    const s = new ChangeSetStore(await openTestDb(), { now: () => 1000 })
    await s.create(rec())
    await s.recordResults('cs1', [{ item_key: '1', status: 'failed', error_code: 'E1', error_message: 'boom', trace_id: 'tr1' }])
    await s.recordResults('cs1', [{ item_key: '1', status: 'done', before: { a: 1 }, after: { a: 2 }, trace_id: 'tr2' }])
    const results = await s.getResults('cs1')
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ item_key: '1', status: 'done', before: { a: 1 }, after: { a: 2 }, error_code: undefined, error_message: undefined, trace_id: 'tr2' })
  })
  // Final whole-branch review Important 2: app_get_changeset_view always returned the diff/
  // diff_version stored at CREATION time — the panel's DIFF_STALE recovery path had no way to ever
  // converge, because nothing ever wrote a fresher diff back to the store. updateDiff is that
  // write-back primitive: confirmService.approveAndExecute calls it when it detects staleness, so
  // the next view/approval attempt reads the recomputed diff instead of the stale original.
  it('updateDiff overwrites diff/diff_version while still pending_approval', async () => {
    const s = new ChangeSetStore(await openTestDb(), { now: () => 1000 })
    await s.create(rec())
    const newDiff: DiffItem[] = [{ prod_oid: '1', target_is_active: false, no_op: true, current_is_active: false }]
    const won = await s.updateDiff('cs1', newDiff, 'v2')
    expect(won).toBe(true)
    const got = (await s.get('cs1'))!
    expect(got.diffVersion).toBe('v2')
    expect(got.diff).toEqual(newDiff)
  })
  it('updateDiff is a no-op (returns false) once the change-set has left pending_approval', async () => {
    const s = new ChangeSetStore(await openTestDb(), { now: () => 1000 })
    await s.create(rec({ status: 'approved' }))
    const won = await s.updateDiff('cs1', [], 'v2')
    expect(won).toBe(false)
    const got = (await s.get('cs1'))!
    expect(got.diffVersion).toBe('v1')   // untouched — approved change-set's diff must not be rewritten
  })

  it('casStatus transitions only when current status matches `from`, and reports who won', async () => {
    const s = new ChangeSetStore(await openTestDb(), { now: () => 1000 })
    await s.create(rec({ status: 'pending_approval' }))
    // wrong `from` (already 'approved', not 'pending_approval') -> no-op, returns false
    expect(await s.casStatus('cs1', 'approved', 'executing')).toBe(false)
    expect((await s.get('cs1'))!.status).toBe('pending_approval')
    // correct `from` -> transitions, returns true
    expect(await s.casStatus('cs1', 'pending_approval', 'approved', 2000)).toBe(true)
    expect((await s.get('cs1'))!.status).toBe('approved')
    expect((await s.get('cs1'))!.decidedAt).toBe(2000)
    // second call with the same `from` no longer matches (status is now 'approved') -> false,
    // simulating the loser of a concurrent CAS race
    expect(await s.casStatus('cs1', 'pending_approval', 'approved', 3000)).toBe(false)
    expect((await s.get('cs1'))!.status).toBe('approved')
    expect((await s.get('cs1'))!.decidedAt).toBe(2000)
  })
})
