import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { createChangesetTool, INVENTORY_ACTION_CODES } from '../src/core/changeset/tools.js'
import type { L2ToolContext } from '../src/server/l2Context.js'
import { validateInventoryItems } from '../src/modules/product/inventorySetting/validate.js'
import type { InventoryItem } from '../src/core/changeset/types.js'

const NOW = Date.parse('2026-08-10T00:00:00Z')
const base: InventoryItem = { item_oid: 'i1', supplier_oid: 's1', quantity: 50 }

describe('validateInventoryItems', () => {
  it('accepts a valid set item', () => {
    expect(validateInventoryItems([base], NOW)).toBeUndefined()
  })
  it('rejects set with negative quantity', () => {
    expect(validateInventoryItems([{ ...base, quantity: -1 }], NOW)?.message).toMatch(/>= 0/)
  })
  it('rejects non-integer quantity', () => {
    expect(validateInventoryItems([{ ...base, quantity: 1.5 }], NOW)?.message).toMatch(/integer/)
  })
  it('rejects a duplicate (item, supplier) across the whole change-set', () => {
    const dup = validateInventoryItems([base, { ...base, quantity: 9 }], NOW)
    expect(dup?.message).toMatch(/duplicate/)
    expect(dup?.key).toBe('i1:s1')
  })
  it('allows the same item on a different supplier', () => {
    expect(validateInventoryItems([base, { ...base, supplier_oid: 's2' }], NOW)).toBeUndefined()
  })
})

function makeCtx(over: Partial<L2ToolContext> = {}): { ctx: L2ToolContext; store: ChangeSetStore; readOids: ReadOidStore; urls: string[] } {
  const db = openDb(':memory:')
  const store = new ChangeSetStore(db, { now: () => 1000 })
  const readOids = new ReadOidStore(db, { now: () => 1000 })
  const rateBudget = new RateBudget(db, { now: () => 1000 })
  readOids.record('s1', ['i1'])
  const gateway = {
    get: vi.fn(async () => ({ item_config: { inventory_setting: { control_type: 1, inventory_type: 0 } } })),
    post: vi.fn(async () => ({ 'i1': { fullday: 10 } })),
  } as never
  const urls: string[] = []
  const emitConfirmUrl = vi.fn((_id: string, url: string) => { urls.push(url) })
  const ctx: L2ToolContext = {
    gateway, accessToken: 'fake', userLabel: 'p@kkday.com', sessionId: 's1', bearerHash: 'bh',
    businessList: INVENTORY_ACTION_CODES, readOids, changeSets: store, rateBudget,
    baseUrl: 'http://127.0.0.1:8787', genId: () => 'cs1', now: () => 1000,
    emitConfirmUrl, ...over,
  }
  return { ctx, store, readOids, urls }
}

const invArgs = {
  action_type: 'inventory_setting',
  items: [{ item_oid: 'i1', supplier_oid: 's1', quantity: 50 }],
}

describe('be2_create_changeset (inventory_setting)', () => {
  it('creates an inventory change-set with fullday diff and emits confirm url', async () => {
    const { ctx, urls, store } = makeCtx()
    const env = await createChangesetTool.handler(invArgs, ctx)
    expect(env.errors).toEqual([])
    const out = env.items[0] as { changeset_id: string; diff: { items: Array<{ current: number; target: number }> } }
    expect(out.diff.items[0].current).toBe(10)
    expect(out.diff.items[0].target).toBe(50)
    expect(urls).toHaveLength(1)
    expect(store.get(out.changeset_id)?.status).toBe('pending_approval')
  })
  it('rejects an unqueried item_oid with SCOPE_NOT_READ', async () => {
    const { ctx } = makeCtx()
    const env = await createChangesetTool.handler(
      { ...invArgs, items: [{ ...invArgs.items[0], item_oid: 'i-not-read' }] }, ctx)
    expect(env.errors[0].code).toBe('SCOPE_NOT_READ')
  })
  it('rejects when businessList lacks the inventory action code', async () => {
    const { ctx } = makeCtx({ businessList: ['product.product-sale-status.update'] })
    const env = await createChangesetTool.handler(invArgs, ctx)
    expect(env.errors[0].code).toBe('ACTION_NOT_ALLOWED')
  })
  it('rejects mixed shelf/inventory item shapes for this action_type', async () => {
    const { ctx } = makeCtx()
    const env = await createChangesetTool.handler(
      { ...invArgs, items: [{ prod_oid: 'p1', target_is_active: false }] }, ctx)
    expect(env.errors[0].code).toBe('INVALID_ITEMS')
  })
})
