import { describe, it, expect } from 'vitest'
import { appGetChangesetViewTool, appGetConfirmLinkTool, appGetBatchViewTool, appGetAnnouncementViewTool } from '../src/tools/appTools.js'
import { ApprovalNonceStore } from '../src/core/changeset/approvalNonce.js'
import { z } from 'zod'

function ctx(over: Partial<any> = {}) {
  return {
    userLabel: 'alice', baseUrl: 'http://127.0.0.1:8787', sessionId: 's1',
    accessToken: 'fake-jwt',
    scheduleTz: 'Asia/Taipei',
    rateBudget: { consume: () => {} },   // 新測試呼叫 handler 需要;既有 zod-only 測試不受影響
    changeSets: {
      get: (id: string) => {
        if (id === 'cs1') return { id: 'cs1', creatorLabel: 'alice', status: 'pending_approval', actionType: 'shelf_toggle_product', note: undefined, diff: [{ a: 1 }], diffVersion: 'v1' }
        if (id === 'cs2') return { id: 'cs2', creatorLabel: 'alice', status: 'approved', actionType: 'shelf_toggle_product', note: undefined, diff: [{ a: 1 }], diffVersion: 'v2' }
        return undefined
      },
      getResults: () => [],
    },
    nonces: new ApprovalNonceStore(),
    ...over,   // gateway 由各測試自帶 mock 路由 override
  } as any
}

it('view: creator 本人拿得到 diff', async () => {
  const env = await appGetChangesetViewTool.handler({ changeset_id: 'cs1' }, ctx())
  expect(env.items[0]).toMatchObject({ changeset_id: 'cs1', status: 'pending_approval' })
})
it('view: 他人 → NOT_FOUND（無 existence leak）', async () => {
  const env = await appGetChangesetViewTool.handler({ changeset_id: 'cs1' }, ctx({ userLabel: 'bob' }))
  expect(env.errors[0].code).toBe('NOT_FOUND')
})
it('view: pending_approval 附上 diff_version 與 nonce（面板批准用）', async () => {
  const env = await appGetChangesetViewTool.handler({ changeset_id: 'cs1' }, ctx())
  const item = env.items[0] as Record<string, unknown>
  expect(item.diff_version).toBe('v1')
  expect(typeof item.nonce).toBe('string')
  expect((item.nonce as string).length).toBeGreaterThan(0)
})
it('view: 非 pending_approval 不附 nonce / diff_version', async () => {
  const env = await appGetChangesetViewTool.handler({ changeset_id: 'cs2' }, ctx())
  const item = env.items[0] as Record<string, unknown>
  expect(item.nonce).toBeUndefined()
  expect(item.diff_version).toBeUndefined()
})
it('confirm-link: creator 本人拿得到 url', async () => {
  const env = await appGetConfirmLinkTool.handler({ changeset_id: 'cs1' }, ctx())
  expect(env.items[0]).toMatchObject({ confirm_url: 'http://127.0.0.1:8787/confirm/cs1' })
})
it('confirm-link: 他人 → NOT_FOUND', async () => {
  const env = await appGetConfirmLinkTool.handler({ changeset_id: 'cs1' }, ctx({ userLabel: 'bob' }))
  expect(env.errors[0].code).toBe('NOT_FOUND')
})

describe('appGetBatchViewTool zod', () => {
  it('接受 shelf_toggle_product', () => {
    const schema = z.object(appGetBatchViewTool.inputShape as never)
    expect(schema.safeParse({ action_type: 'shelf_toggle_product', prod_oids: ['1'] }).success).toBe(true)
  })
  it('接受 shelf_toggle_bundle', () => {
    const schema = z.object(appGetBatchViewTool.inputShape as never)
    expect(schema.safeParse({ action_type: 'shelf_toggle_bundle', prod_oids: ['1'] }).success).toBe(true)
  })
})

it('app_get_batch_view: prod_mids 解析成 canonical oid 後進 buildBatchView,resolved_ids 帶出', async () => {
  const env = await appGetBatchViewTool.handler(
    { action_type: 'shelf_schedule', prod_mids: ['10759'], prod_oids: [] } as never,
    ctx({ gateway: { get: async (p: string) =>
      p.includes('mid-10759') ? { prod_oid: '38352' } : { /* buildBatchView 下游最小回應 */ } } }))
  expect(env.resolved_ids).toEqual([{ mid: '10759', oid: '38352' }])
  expect(env.read_oids).toContain('38352')
})

it('app_get_batch_view: 兩陣列皆空 → MISSING_ID', async () => {
  const env = await appGetBatchViewTool.handler(
    { action_type: 'shelf_schedule', prod_mids: [], prod_oids: [] } as never, ctx({}))
  expect(env.errors[0].code).toBe('MISSING_ID')
})

it('app_get_announcement_view: prod_mids 解析後迴圈用 canonical oid,resolved_ids 帶出', async () => {
  const env = await appGetAnnouncementViewTool.handler(
    { prod_mids: ['2247'], prod_oids: [] } as never,
    ctx({ gateway: { get: async (p: string) =>
      p.includes('mid-2247') ? { prod_oid: '35992' } : { name: 'X' } } }))
  expect(env.resolved_ids).toEqual([{ mid: '2247', oid: '35992' }])
  expect(env.read_oids).toContain('35992')
})

it('app_get_announcement_view: 讀取失敗的 oid 不進 read_oids(只登記成功讀到的,防跨-user cache scope 繞過)', async () => {
  const env = await appGetAnnouncementViewTool.handler(
    { prod_oids: ['good1', 'bad1'] } as never,
    ctx({ gateway: { get: async (p: string) => {
      if (p.includes('/drafts/products/bad1/info')) throw Object.assign(new Error('403 no permission'), { status: 403 })
      if (p.includes('/drafts/products/good1/info')) return { name: 'Good' }
      throw Object.assign(new Error('404'), { status: 404 })
    } } }))
  expect(env.read_oids).toContain('good1')          // 本 user 實際讀到 → 登記
  expect(env.read_oids).not.toContain('bad1')        // 讀取失敗(403)→ 不得進 scope substrate
  expect(env.errors.some(e => e.key === 'bad1')).toBe(true)
})

it('app_get_batch_view: 合併總量 > 10 → TOO_MANY_IDS(不 burst gateway)', async () => {
  let called = false
  const env = await appGetBatchViewTool.handler(
    { action_type: 'shelf_schedule',
      prod_mids: Array.from({ length: 6 }, (_, i) => `m${i}`),
      prod_oids: Array.from({ length: 5 }, (_, i) => `o${i}`) } as never,
    ctx({ gateway: { get: async () => { called = true; return {} } } }))
  expect(env.errors[0].code).toBe('TOO_MANY_IDS')
  expect(called).toBe(false)
})

it('app_get_announcement_view: 合併總量 > 10 → TOO_MANY_IDS(不 burst gateway)', async () => {
  let called = false
  const env = await appGetAnnouncementViewTool.handler(
    { prod_mids: Array.from({ length: 6 }, (_, i) => `m${i}`),
      prod_oids: Array.from({ length: 5 }, (_, i) => `o${i}`) } as never,
    ctx({ gateway: { get: async () => { called = true; return {} } } }))
  expect(env.errors[0].code).toBe('TOO_MANY_IDS')
  expect(called).toBe(false)
})
