import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { createChangesetTool, businessListAllowsAction } from '../src/changeset/tools.js'
import type { L2ToolContext } from '../src/server/l2Context.js'
import { z } from 'zod'

function mkCtx(over: Partial<L2ToolContext> = {}): { ctx: L2ToolContext; store: ChangeSetStore; readOids: ReadOidStore; emitConfirmUrl: ReturnType<typeof vi.fn> } {
  const db = openDb(':memory:')
  const store = new ChangeSetStore(db, { now: () => 1000 })
  const readOids = new ReadOidStore(db, { now: () => 1000 })
  const rateBudget = new RateBudget(db, { now: () => 1000 })
  const gateway = { get: async (p: string) => {
    if (p.includes('/info')) return { name: 'Prod A', workflow_status: 'PUBLISHED' }
    if (p.includes('/switch')) return { is_active: true }
    throw new Error(`unexpected ${p}`)
  } } as never
  const emitConfirmUrl = vi.fn()
  const ctx: L2ToolContext = {
    gateway, accessToken: 'fake', userLabel: 'p@kkday.com', sessionId: 's1', bearerHash: 'bh',
    businessList: ['product.product-sale-status.update'], readOids, changeSets: store, rateBudget,
    baseUrl: 'http://127.0.0.1:8787', genId: () => 'cs1', now: () => 1000,
    emitConfirmUrl, ...over,
  }
  return { ctx, store, readOids, emitConfirmUrl }
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
  it('builds a pending change-set with diff, WITHOUT confirm_url/diff_version in the tool response (Fix 1: confirm_url out-of-band; Phase 2b: no capability token at all)', async () => {
    const { ctx, store, readOids, emitConfirmUrl } = mkCtx()
    readOids.record('s1', ['p1'])
    const env = await createChangesetTool.handler({ action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }], note: 'n' }, ctx)
    const item = env.items[0] as Record<string, unknown>
    expect(item.changeset_id).toBe('cs1')
    expect(item.status).toBe('pending_approval')
    // The confirm_url must never reach the model's context (agent has Bash/curl on loopback and
    // could try to hit the confirm route itself) — assert it is absent in every shape it could
    // leak as.
    expect(item).not.toHaveProperty('confirm_url')
    expect(item).not.toHaveProperty('diff_version')
    expect(item).not.toHaveProperty('token')
    const diff = (item.diff as { items: Array<Record<string, unknown>> }).items[0]
    expect(diff).toMatchObject({ prod_oid: 'p1', name: 'Prod A', current_is_active: true, target_is_active: false, no_op: false })
    const rec = store.get('cs1')!
    expect(rec.status).toBe('pending_approval')
    expect(rec.creatorLabel).toBe('p@kkday.com')
    expect(env.data_origin).toBe('be2_content')
    // The confirm_url is delivered out-of-band to the human via the injected emitConfirmUrl (wired
    // to server stdout in app.ts) — never through the tool response the agent reads. Phase 2b: the
    // URL carries no capability token — approval is gated by a be2-auth SSO session cookie on the
    // confirm page itself (see confirmRoutes.ts), not a secret in the URL.
    expect(emitConfirmUrl).toHaveBeenCalledTimes(1)
    expect(emitConfirmUrl).toHaveBeenCalledWith('cs1', 'http://127.0.0.1:8787/confirm/cs1')
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
