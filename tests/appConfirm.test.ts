import { describe, it, expect } from 'vitest'
import { appConfirmChangesetTool } from '../src/tools/appTools.js'

// 用假 changeSets/nonces/executor 組 ctx；重點驗「沒有正確 nonce 一律拒、不執行」。
function ctx(over: any = {}) {
  const executed: string[] = []
  return {
    _executed: executed,
    userLabel: 'alice', sessionId: 's1',
    now: () => 0,   // AppToolContext.now is required (real wrapAppTool always supplies it) — the
                     // reject branch's setStatus(..., ctx.now()) call needs a callable here.
    changeSets: {
      get: (id: string) => id === 'cs1' ? { id, creatorLabel: 'alice', status: 'pending_approval', diffVersion: 'v1', actionType: 'shelf_toggle_product', items: [], diff: [] } : undefined,
      // Finding 2 fix: reject 改用 casStatus。預設假 store 的 change-set 一律「仍是 pending」,
      // 故 CAS 一律成功——除非個別測試覆寫（見下方 ALREADY_PROCESSED 測試）。
      casStatus: () => true,
    },
    nonces: { verifyAndConsume: (n: string) => n === 'good' },
    approveAndExecute: async () => { executed.push('cs1'); return { status: 'done', results: [] } },
    ...over,
  } as any
}

it('無 nonce / 錯 nonce → 拒、不執行（自我批准防線）', async () => {
  const c = ctx()
  const env = await appConfirmChangesetTool.handler({ changeset_id: 'cs1', decision: 'approve', nonce: 'bad', diff_version: 'v1', confirmed_keys: [] }, c)
  expect(env.errors[0].code).toBe('NONCE_INVALID')
  expect(c._executed).toEqual([])
})
it('正確 nonce + approve → 執行', async () => {
  const c = ctx()
  const env = await appConfirmChangesetTool.handler({ changeset_id: 'cs1', decision: 'approve', nonce: 'good', diff_version: 'v1', confirmed_keys: [] }, c)
  expect(env.items[0]).toMatchObject({ status: 'done' })
  expect(c._executed).toEqual(['cs1'])
})
it('他人 changeset → NOT_FOUND、不執行', async () => {
  const c = ctx({ userLabel: 'bob' })
  const env = await appConfirmChangesetTool.handler({ changeset_id: 'cs1', decision: 'approve', nonce: 'good', diff_version: 'v1', confirmed_keys: [] }, c)
  expect(env.errors[0].code).toBe('NOT_FOUND')
  expect(c._executed).toEqual([])
})
it('confirmed_keys 與 items 不一致 → 拒、不執行（取消勾選不得後端全量執行）', async () => {
  const c = ctx({ approveAndExecute: async ({ confirmedKeys }: any) => {
    // 模擬 service：keys 不吻合就 throw（真實 service 用 AppError CONFIRMED_KEYS_MISMATCH）
    if ((confirmedKeys ?? []).length === 0) { throw Object.assign(new Error('mismatch'), { code: 'CONFIRMED_KEYS_MISMATCH' }) }
    return { status: 'done', results: [] }
  } })
  const env = await appConfirmChangesetTool.handler({ changeset_id: 'cs1', decision: 'approve', nonce: 'good', diff_version: 'v1', confirmed_keys: [] }, c)
  expect(env.errors[0].code).toBe('CONFIRMED_KEYS_MISMATCH')
  expect(c._executed).toEqual([])
})
it('CAS 失敗（已被確認頁批准）→ ALREADY_PROCESSED、不重複執行', async () => {
  const c = ctx({ approveAndExecute: async () => ({ casFailed: true }) })
  const env = await appConfirmChangesetTool.handler({ changeset_id: 'cs1', decision: 'approve', nonce: 'good', diff_version: 'v1', confirmed_keys: [] }, c)
  expect(env.errors[0].code).toBe('ALREADY_PROCESSED')
})
it('reject → 設 rejected、不執行', async () => {
  const casCalls: unknown[] = []
  const c = ctx({ changeSets: {
    get: () => ({ id: 'cs1', creatorLabel: 'alice', status: 'pending_approval', diffVersion: 'v1', items: [], diff: [] }),
    casStatus: (id: string, from: string, to: string) => { casCalls.push([id, from, to]); return true },
  } })
  const env = await appConfirmChangesetTool.handler({ changeset_id: 'cs1', decision: 'reject', nonce: 'good', diff_version: 'v1', confirmed_keys: [] }, c)
  expect(env.items[0]).toMatchObject({ status: 'rejected' })
  expect(c._executed).toEqual([])
  expect(casCalls).toEqual([['cs1', 'pending_approval', 'rejected']])
})
it('reject 在非 pending 的 change-set（如已 done）→ ALREADY_PROCESSED、不覆寫狀態（Finding 2：面板拒絕需 CAS 守門）', async () => {
  // 模擬「已透過確認頁批准並執行完畢」的 change-set：面板仍握有一枚未過期的 nonce（例如
  // 使用者開著兩個分頁），按下拒絕不得把已執行結果覆寫成 rejected。
  const c = ctx({ changeSets: {
    get: () => ({ id: 'cs1', creatorLabel: 'alice', status: 'done', diffVersion: 'v1', items: [], diff: [] }),
    casStatus: () => false,   // CAS 輸——已不是 pending_approval
  } })
  const env = await appConfirmChangesetTool.handler({ changeset_id: 'cs1', decision: 'reject', nonce: 'good', diff_version: 'v1', confirmed_keys: [] }, c)
  expect(env.errors[0].code).toBe('ALREADY_PROCESSED')
  expect(c._executed).toEqual([])
})
