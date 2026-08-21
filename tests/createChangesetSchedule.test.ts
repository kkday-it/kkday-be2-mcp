import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { createChangesetCore } from '../src/core/changeset/tools.js'
import type { L2ToolContext } from '../src/server/l2Context.js'
import { APP_TOOLS } from '../src/tools/appTools.js'
import { ApprovalNonceStore } from '../src/core/changeset/approvalNonce.js'

const T0 = Date.UTC(2026, 8, 1, 0, 0)   // 2026-09-01T00:00Z
const ITEM = { item_oid: 'i1', supplier_oid: '0', quantity: 5 }

function mkCtx(over: Partial<L2ToolContext> = {}) {
  const db = openDb(':memory:')
  const store = new ChangeSetStore(db, { now: () => T0 })
  const readOids = new ReadOidStore(db, { now: () => T0 })
  const rateBudget = new RateBudget(db, { now: () => T0 })
  // inventory_setting 的 computeDiff 走真 module:GET basic-info(mode gate 需 item_by_amount
  // 1/0)+ POST inventories/search(主形狀 data[itemOid].fullday)。
  const gateway = {
    get: async (p: string) => {
      if (p.includes('/basic-info')) return { item_config: { inventory_setting: { control_type: 1, inventory_type: 0 } } }
      return { no_op: false, current: 0, target: 5 }
    },
    post: async () => ({ data: { i1: { fullday: 0 } } }),
  } as never
  const emitConfirmUrl = vi.fn()
  const ctx: L2ToolContext = {
    gateway, accessToken: 'fake', userLabel: 'p@kkday.com', sessionId: 's1', bearerHash: 'bh',
    businessList: ['product.product-inventory.update', 'product.product-sale-status.update'], readOids, changeSets: store, rateBudget,
    baseUrl: 'http://127.0.0.1:8787', genId: () => 'cs1', now: () => T0,
    emitConfirmUrl, scheduleTz: 'Asia/Taipei', ...over,
  }
  readOids.record('s1', ['i1', 'p', 'k'])   // shelf_toggle 的 scopeOids 含 pkg_oid,'k' 也要登記
  return { ctx, store, readOids, emitConfirmUrl }
}

describe('createChangesetSchedule', () => {
  it('schedule on a schedulable module: converts wall→UTC and persists ScheduleInfo', async () => {
    const { ctx } = mkCtx()
    // wall 2026-09-01T09:00 Asia/Taipei = T0+1h;now=T0 → lead 1h > minLead ✓
    const env = await createChangesetCore({ action_type: 'inventory_setting', items: [ITEM],
      schedule: { wall: '2026-09-01T09:00' } }, ctx)
    const rec = ctx.changeSets.get((env.items[0] as { changeset_id: string }).changeset_id)!
    expect(rec.schedule).toEqual({ executeAtUtc: T0 + 3600_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' })
  })

  it('rejects schedule for non-schedulable module (SCHEDULE_NOT_SUPPORTED)', async () => {
    const { ctx } = mkCtx()
    const env = await createChangesetCore({ action_type: 'shelf_toggle_plan',
      items: [{ prod_oid: 'p', pkg_oid: 'k', target_is_active: false }],
      schedule: { wall: '2026-09-01T09:00' } }, ctx)
    expect(env.errors[0]?.code).toBe('SCHEDULE_NOT_SUPPORTED')
  })

  it('rejects lead < minLead and beyond horizon (SCHEDULE_OUT_OF_RANGE)', async () => {
    const { ctx } = mkCtx()
    const tooSoon = await createChangesetCore({ action_type: 'inventory_setting', items: [ITEM],
      schedule: { wall: '2026-09-01T08:03' } }, ctx)   // Asia/Taipei 08:03 = T0+3min < 5min lead
    expect(tooSoon.errors[0]?.code).toBe('SCHEDULE_OUT_OF_RANGE')
    const tooFar = await createChangesetCore({ action_type: 'inventory_setting', items: [ITEM],
      schedule: { wall: '2026-10-15T09:00' } }, ctx)   // > 30d
    expect(tooFar.errors[0]?.code).toBe('SCHEDULE_OUT_OF_RANGE')
  })

  it('invalid wall bubbles as INVALID_WALL error envelope', async () => {
    const { ctx } = mkCtx()
    const env = await createChangesetCore({ action_type: 'inventory_setting', items: [ITEM],
      schedule: { wall: 'not-a-time' } }, ctx)
    expect(env.errors[0]?.code).toBe('INVALID_WALL')
  })

  it('works via app_create_changeset tool (AppToolContext)', async () => {
    const { ctx } = mkCtx()
    const appCtx = {
      ...ctx,
      nonces: new ApprovalNonceStore(),
      approveAndExecute: vi.fn(),
    }
    const tool = APP_TOOLS.find(t => t.name === 'app_create_changeset')!
    const env = await tool.handler({ action_type: 'inventory_setting', items: [ITEM], schedule: { wall: '2026-09-01T09:00' } }, appCtx as never)
    expect(env.items.length).toBe(1)
    const rec = appCtx.changeSets.get((env.items[0] as { changeset_id: string }).changeset_id)!
    expect(rec.schedule).toEqual({ executeAtUtc: T0 + 3600_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' })
  })
})
