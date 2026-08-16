import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import type { ShelfScheduleItem, ShelfScheduleDiffItem } from '../../../core/changeset/types.js'
import { computeScheduleDiff } from './diff.js'
import { executeShelfSchedule } from './executor.js'
import { validateShelfScheduleItems } from './validate.js'
import { itemKey } from './keys.js'
import { renderConfirm } from './renderer.js'

const shelfScheduleItemShape = z.object({
  prod_oid: z.string().min(1),
  pkg_oid: z.string().min(1),
  queue: z.array(z.object({ reserve_date_utc: z.string(), reserve_status: z.boolean() })),  // empty = clear schedule
})

function isShelfScheduleItem(i: unknown): i is ShelfScheduleItem {
  return typeof (i as ShelfScheduleItem).prod_oid === 'string' &&
    typeof (i as ShelfScheduleItem).pkg_oid === 'string' &&
    Array.isArray((i as ShelfScheduleItem).queue)
}

export const shelfScheduleModule: ActionModule<ShelfScheduleItem, ShelfScheduleDiffItem> = {
  actionType: 'shelf_schedule',
  itemSchema: shelfScheduleItemShape,
  authz: {
    // §4.3: no dedicated action code confirmed yet for the native-reserve endpoint — reuses the
    // shelf_toggle_plan package-config codes verbatim (spec: "沿用 Phase 2a shelf_toggle 實查的
    // package-config 類 code"). If this later proves not to be the verify-side gate, spec §4.3
    // calls for degrading this check to an audit warning instead of a hard block — not yet wired
    // here; that's an executor-level concern for a later task.
    codes: ['product.product-sale-status.update', 'product.bundle-package-sale-status.update'],
    onMissing: 'warn'
  },
  invalidItemsMessage: 'shelf_schedule items need {prod_oid, pkg_oid, queue}.',
  scopeNotReadMessage: 'These oids were not looked up in this session; query them first (be2_get_product_plans) before staging a change.',
  isItem: isShelfScheduleItem,
  scopeOids: (item: ShelfScheduleItem) => [item.prod_oid, item.pkg_oid],
  scopeErrorKey: (item: ShelfScheduleItem) => item.pkg_oid,
  validate: (items: ShelfScheduleItem[], nowMs: number) => {
    const bad = validateShelfScheduleItems(items, () => nowMs)
    return bad ? { key: 'shelf_schedule', message: bad } : null
  },
  computeDiff: (ctx: DiffCtx, items: ShelfScheduleItem[]) => computeScheduleDiff(items, ctx),
  diffVersion: (diff: ShelfScheduleDiffItem[]) => {
    // Task 4 explicit branch: a ShelfScheduleDiffItem also has prod_oid/pkg_oid (same field names
    // as DiffItem) but NO current_is_active — falling through to the DiffItem branch below would
    // read `.current_is_active` as undefined for every item, producing a constant hash regardless
    // of queue content and silently disabling the stale-drift guard entirely. `current_queue` is
    // unique to this shape. Only current_queue (the live-read state) is hashed — new_queue is
    // invariant per the change-set's own items, same rule as the other branches here.
    const canon = diff.map(sc => {
      const q = sc.current_queue.map(e => `${e.reserve_date_utc}:${e.reserve_status}`).sort().join(',')
      return `sched:${sc.prod_oid}:${sc.pkg_oid}=${q}`
    }).sort().join('|')
    return createHash('sha256').update(canon).digest('hex')
  },
  itemKey,
  execute: executeShelfSchedule,
  renderConfirm
}
