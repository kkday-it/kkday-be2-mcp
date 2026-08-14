import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { createChangesetTool } from '../src/changeset/tools.js'
import type { L2ToolContext } from '../src/server/l2Context.js'

// Spec §4.3 businessList degrade gate for the two NEW action_types. Diff wiring for these
// types is Task 3's scope — mock it out so this suite isolates the gate decision itself
// (block vs warn-and-proceed), not the diff computation.
vi.mock('../src/changeset/diff.js', async importOriginal => {
  const orig = await importOriginal<typeof import('../src/changeset/diff.js')>()
  return { ...orig, computeChangesetDiff: vi.fn(async () => []), diffVersionHash: () => 'dv1' }
})

function makeCtx(over: Partial<L2ToolContext> = {}): { ctx: L2ToolContext; store: ChangeSetStore } {
  const db = openDb(':memory:')
  const store = new ChangeSetStore(db, { now: () => 1000 })
  const readOids = new ReadOidStore(db, { now: () => 1000 })
  const rateBudget = new RateBudget(db, { now: () => 1000 })
  readOids.record('s1', ['i1', 'p1', 'pkg1'])
  const ctx: L2ToolContext = {
    gateway: {} as never, accessToken: 'fake', userLabel: 'p@kkday.com', sessionId: 's1', bearerHash: 'bh',
    businessList: [], readOids, changeSets: store, rateBudget,
    baseUrl: 'http://127.0.0.1:8787', genId: () => 'cs1', now: () => 1000,
    emitConfirmUrl: vi.fn(), ...over,
  }
  return { ctx, store }
}

const platArgs = {
  action_type: 'inventory_platform',
  items: [{ item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM', affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'pkg1', pkg_name: 'A' }] }],
}
const schedArgs = {
  action_type: 'shelf_schedule',
  items: [{ prod_oid: 'p1', pkg_oid: 'pkg1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] }],
}

describe('businessList gate degrade (spec §4.3) — new action_types warn, old ones still block', () => {
  it('inventory_platform: missing action code does NOT block creation; envelope carries a warning', async () => {
    const { ctx, store } = makeCtx({ businessList: [] })
    const env = await createChangesetTool.handler(platArgs, ctx)
    const out = env.items[0] as { changeset_id: string }
    expect(out.changeset_id).toBe('cs1')
    expect(store.get('cs1')?.status).toBe('pending_approval')
    const warn = env.errors.find(e => e.code === 'ACTION_CODE_UNVERIFIED')
    expect(warn).toBeDefined()
    expect(warn!.key).toBe('inventory_platform')
  })
  it('shelf_schedule: missing action code does NOT block creation; envelope carries a warning', async () => {
    const { ctx, store } = makeCtx({ businessList: [] })
    const env = await createChangesetTool.handler(schedArgs, ctx)
    expect((env.items[0] as { changeset_id: string }).changeset_id).toBe('cs1')
    expect(store.get('cs1')?.status).toBe('pending_approval')
    expect(env.errors.find(e => e.code === 'ACTION_CODE_UNVERIFIED')).toBeDefined()
  })
  it('inventory_platform: with the action code present there is no warning', async () => {
    const { ctx } = makeCtx({ businessList: ['product.product-inventory.update'] })
    const env = await createChangesetTool.handler(platArgs, ctx)
    expect(env.errors).toEqual([])
    expect((env.items[0] as { changeset_id: string }).changeset_id).toBe('cs1')
  })
  // Task 3 review carry-forward: readOidsOut used to cast items to ChangeSetItem[] for every
  // non-inventory_setting action_type, so inventory_platform items (which have no prod_oid/
  // pkg_oid) always produced an EMPTY read_oids array — silently under-registering scope-read
  // state for this session. Must collect item_oid like inventory_setting does.
  it('inventory_platform: read_oids carries the item_oid(s), not an empty array', async () => {
    const { ctx } = makeCtx({ businessList: ['product.product-inventory.update'] })
    const env = await createChangesetTool.handler(platArgs, ctx)
    expect(env.read_oids).toEqual(['i1'])
  })
  it('existing action_types keep the HARD block (no degrade)', async () => {
    const { ctx, store } = makeCtx({ businessList: [] })
    const env = await createChangesetTool.handler(
      { action_type: 'shelf_toggle_product', items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.items).toEqual([])
    expect(env.errors[0].code).toBe('ACTION_NOT_ALLOWED')
    expect(store.get('cs1')).toBeUndefined()
  })
})
