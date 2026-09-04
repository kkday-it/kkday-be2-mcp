import { describe, it, expect, vi } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { ApprovalNonceStore } from '../src/core/changeset/approvalNonce.js'
import { appCreateChangesetTool } from '../src/tools/appTools.js'
import type { AppToolContext } from '../src/server/appPipeline.js'

// Task 6: app_create_changeset must walk the EXACT SAME path as be2_create_changeset
// (tests/createChangeset.test.ts) — same scope-gate, same validation, same store writes — via
// the shared src/changeset/tools.ts#createChangesetCore. This test file mirrors
// createChangeset.test.ts's fixture shape (real in-memory store/readOids/rateBudget), adapted to
// AppToolContext (which additionally carries nonces/approveAndExecute, unused here).
async function mkCtx(over: Partial<AppToolContext> = {}): Promise<{ ctx: AppToolContext; store: ChangeSetStore; readOids: ReadOidStore; emitConfirmUrl: ReturnType<typeof vi.fn> }> {
  const db = await openTestDb()
  const store = new ChangeSetStore(db, { now: () => 1000 })
  const readOids = new ReadOidStore(db, { now: () => 1000 })
  const rateBudget = new RateBudget(db, { now: () => 1000 })
  const gateway = { get: async (p: string) => {
    if (p.includes('/info')) return { name: 'Prod A', workflow_status: 'PUBLISHED' }
    if (p.includes('/switch')) return { is_active: true }
    throw new Error(`unexpected ${p}`)
  } } as never
  const emitConfirmUrl = vi.fn()
  const ctx: AppToolContext = {
    gateway, accessToken: 'fake', userLabel: 'p@kkday.com', sessionId: 's1', bearerHash: 'bh', traceId: 't'.repeat(32),
    businessList: ['product.product-sale-status.update'], readOids, changeSets: store, rateBudget,
    nonces: new ApprovalNonceStore(), baseUrl: 'http://127.0.0.1:8787', genId: () => 'cs1', now: () => 1000, scheduleTz: 'Asia/Taipei',
    emitConfirmUrl, approveAndExecute: vi.fn() as never,
    ...over,
  }
  return { ctx, store, readOids, emitConfirmUrl }
}

describe('app_create_changeset', () => {
  it('合法建立：回傳只有 changeset_id（不含 status/diff），record 確實存進 store', async () => {
    const { ctx, store, emitConfirmUrl } = await mkCtx()
    await ctx.readOids.record('s1', ['p1'])
    const env = await appCreateChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.errors).toEqual([])
    expect(env.items).toEqual([{ changeset_id: 'cs1' }])
    expect(env.items[0]).not.toHaveProperty('status')
    expect(env.items[0]).not.toHaveProperty('diff')
    const rec = (await store.get('cs1'))!
    expect(rec.status).toBe('pending_approval')
    expect(rec.creatorLabel).toBe('p@kkday.com')
    // Same out-of-band delivery contract as be2_create_changeset — never in the response.
    expect(emitConfirmUrl).toHaveBeenCalledTimes(1)
    expect(emitConfirmUrl).toHaveBeenCalledWith('cs1', 'http://127.0.0.1:8787/confirm/cs1')
  })

  it('scope 未讀（readOidStore 空）→ SCOPE_NOT_READ 拒絕，且無 record 被建立（閘門生效）', async () => {
    const { ctx, store } = await mkCtx()   // nothing recorded as read
    const env = await appCreateChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.errors[0]?.code).toBe('SCOPE_NOT_READ')
    expect(env.items).toEqual([])
    expect(await store.get('cs1')).toBeUndefined()
  })

  it('items 驗證錯（action_type 與 item 形狀不符）→ INVALID_ITEMS 拒絕', async () => {
    const { ctx, store } = await mkCtx()
    await ctx.readOids.record('s1', ['p1'])
    const env = await appCreateChangesetTool.handler({ action_type: 'inventory_setting', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.errors[0]?.code).toBe('INVALID_ITEMS')
    expect(env.items).toEqual([])
    expect(await store.get('cs1')).toBeUndefined()
  })

  it('businessList fail-fast 一樣生效（同 be2_create_changeset）', async () => {
    const { ctx } = await mkCtx({ businessList: [] })
    await ctx.readOids.record('s1', ['p1'])
    const env = await appCreateChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.errors[0]?.code).toBe('ACTION_NOT_ALLOWED')
  })

  it('每日 change-set budget 一樣生效（同一顆 RateBudget.consumeChangeset，不是另一份計數）', async () => {
    const { ctx } = await mkCtx()
    await ctx.readOids.record('s1', ['p1'])
    for (let i = 0; i < 10; i++) await appCreateChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    const env = await appCreateChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.errors[0]?.code).toBe('RATE_CHANGESET_DAY')
  })
})
