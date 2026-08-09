import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { createChangesetTool, businessListAllowsAction } from '../src/changeset/tools.js'
import type { L2ToolContext } from '../src/server/l2Context.js'
import { z } from 'zod'

function mkCtx(over: Partial<L2ToolContext> = {}): { ctx: L2ToolContext; store: ChangeSetStore; readOids: ReadOidStore } {
  const db = openDb(':memory:')
  const store = new ChangeSetStore(db, { now: () => 1000 })
  const readOids = new ReadOidStore(db, { now: () => 1000 })
  const rateBudget = new RateBudget(db, { now: () => 1000 })
  const gateway = { get: async (p: string) => {
    if (p.includes('/info')) return { name: 'Prod A', workflow_status: 'PUBLISHED' }
    if (p.includes('/switch')) return { is_active: true }
    throw new Error(`unexpected ${p}`)
  } } as never
  const ctx: L2ToolContext = {
    gateway, accessToken: 'fake', userLabel: 'p@kkday.com', sessionId: 's1', bearerHash: 'bh',
    businessList: [{ action: 'product_switch' }], readOids, changeSets: store, rateBudget,
    baseUrl: 'http://127.0.0.1:8787', genId: () => 'cs1', genToken: () => 'tok-123', now: () => 1000, ...over,
  }
  return { ctx, store, readOids }
}

describe('be2_create_changeset', () => {
  it('input schema rejects >20 items and empty', () => {
    const s = z.object(createChangesetTool.inputShape)
    expect(s.safeParse({ action_type: 'shelf_toggle_product', items: [] }).success).toBe(false)
    expect(s.safeParse({ action_type: 'shelf_toggle_product', items: Array.from({ length: 21 }, () => ({ prod_oid: 'x', target_is_active: false })) }).success).toBe(false)
  })
  it('rejects oids not in session_read_oids with SCOPE_NOT_READ', async () => {
    const { ctx } = mkCtx()   // nothing recorded as read
    const env = await createChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.errors[0]?.code).toBe('SCOPE_NOT_READ')
    expect(env.items).toEqual([])
  })
  it('builds a pending change-set with diff + confirm_url + diff_version when oid was read', async () => {
    const { ctx, store, readOids } = mkCtx()
    readOids.record('s1', ['p1'])
    const env = await createChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }], note: 'n' }, ctx)
    const item = env.items[0] as Record<string, unknown>
    expect(item.changeset_id).toBe('cs1')
    expect(item.confirm_url).toContain('http://127.0.0.1:8787/confirm/cs1?token=tok-123')
    expect(item.diff_version).toBeDefined()
    const diff = (item.diff as { items: Array<Record<string, unknown>> }).items[0]
    expect(diff).toMatchObject({ prod_oid: 'p1', name: 'Prod A', current_is_active: true, target_is_active: false, no_op: false })
    const rec = store.get('cs1')!
    expect(rec.status).toBe('pending_approval')
    expect(rec.creatorLabel).toBe('p@kkday.com')
    expect(rec.approvalTokenHash).toBe(ChangeSetStore.hashToken('tok-123'))   // raw token NOT stored
    expect(env.data_origin).toBe('be2_content')
  })
  it('businessList fail-fast blocks an action the user cannot do', async () => {
    const { ctx, readOids } = mkCtx({ businessList: [] })
    readOids.record('s1', ['p1'])
    const env = await createChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.errors[0]?.code).toBe('ACTION_NOT_ALLOWED')
  })
  it('enforces the daily change-set budget (consumeChangeset is actually called)', async () => {
    const { ctx, readOids } = mkCtx()
    readOids.record('s1', ['p1'])
    // default cap is 10/day; drive 10 successful creates then expect the 11th to be rate-limited
    for (let i = 0; i < 10; i++) await createChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    const env = await createChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.errors[0]?.code).toBe('RATE_CHANGESET_DAY')
  })
})
