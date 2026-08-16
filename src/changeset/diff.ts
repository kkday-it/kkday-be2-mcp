import { createHash } from 'node:crypto'
import type { ToolContext } from '../tools/types.js'
import { findProductsTool } from '../tools/findProducts.js'
import { productPlansTool } from '../tools/productPlans.js'
import type { ActionType, AnyChangeSetItem, AnyDiffItem, ChangeSetItem, DiffItem } from './types.js'
import type { InventoryDiffItem, InventoryItem, InventoryPlatformDiffItem, InventoryPlatformItem } from './types.js'
import type { ShelfScheduleDiffItem, ShelfScheduleItem } from './types.js'
import { computeInventoryDiff } from './inventoryDiff.js'
import { computePlatformDiff } from './platformDiff.js'
import { computeScheduleDiff } from './scheduleDiff.js'

// Version hash binds ONLY what the approver is approving against (spec §4):
//  shelf + inventory `set`: the live base (drift => stale 409);
//  inventory `adjust`: the OPERATION (item, supplier, sorted dates, delta) — the user approves
//  "+50", not an absolute number, so live drift must NOT invalidate the approval.
export function diffVersionHash(diff: AnyDiffItem[]): string {
  const canon = diff.map(d => {
    // Explicit branch (Task 3 review): InventoryPlatformDiffItem also has `item_oid`, so it MUST
    // be distinguished from InventoryDiffItem BEFORE the duck-typed `'item_oid' in d` check below
    // — reading `.dates` off a platform diff item would crash. `target`/`affected_pkgs` are
    // unique to this shape (DiffItem has `target_is_active`, InventoryDiffItem has no top-level
    // `target`). Only `current` (the live-read state) is hashed — `target` is invariant per the
    // change-set's own items and drift there is not what staleness is guarding against (same
    // rule as the shelf/`set` branches below).
    if ('target' in d && 'affected_pkgs' in d) {
      const p = d as InventoryPlatformDiffItem
      return `invplat:${p.item_oid}:${p.supplier_oid}=${p.current}`
    }
    // Task 4 explicit branch: a ShelfScheduleDiffItem also has prod_oid/pkg_oid (same field names
    // as DiffItem) but NO current_is_active — falling through to the DiffItem branch below would
    // read `.current_is_active` as undefined for every item, producing a constant hash regardless
    // of queue content and silently disabling the stale-drift guard entirely. `current_queue` is
    // unique to this shape. Only current_queue (the live-read state) is hashed — new_queue is
    // invariant per the change-set's own items, same rule as the other branches here.
    if ('current_queue' in d) {
      const sc = d as ShelfScheduleDiffItem
      const q = sc.current_queue.map(e => `${e.reserve_date_utc}:${e.reserve_status}`).sort().join(',')
      return `sched:${sc.prod_oid}:${sc.pkg_oid}=${q}`
    }
    if ('item_oid' in d) {
      const inv = d as InventoryDiffItem
      if (inv.op === 'adjust') {
        return `invadj:${inv.item_oid}:${inv.supplier_oid}:${inv.dates.map(x => x.date).sort().join(',')}=${inv.quantity}`
      }
      return inv.dates.map(x => `inv:${inv.item_oid}:${inv.supplier_oid}:${x.date}=${x.current ?? 'null'}`).sort().join('|')
    }
    const s = d as DiffItem
    return `${s.prod_oid}:${s.pkg_oid ?? ''}=${s.current_is_active ?? 'null'}`
  }).sort().join('|')
  return createHash('sha256').update(canon).digest('hex')
}

// Throws DiffError if any requested oid could not be read (403/500/invalid) or resolved no
// current state — we must NOT silently stage a change with current_is_active: undefined.
export class DiffError extends Error {
  // Machine-readable code so toEnvelopeError (src/tools/envelope.ts) surfaces something other
  // than `undefined` for `code` on the resulting envelope error.
  public code = 'DIFF_READ_FAILED'
  constructor(public keys: string[], message: string) {
    super(message)
  }
}

export async function computeChangesetDiff(actionType: ActionType, items: AnyChangeSetItem[], ctx: ToolContext): Promise<AnyDiffItem[]> {
  if (actionType === 'inventory_setting') return computeInventoryDiff(items as InventoryItem[], ctx)
  if (actionType === 'inventory_platform') return computePlatformDiff(items as InventoryPlatformItem[], ctx)
  // shelf_schedule must NOT fall through to computeShelfDiff below (a ShelfScheduleItem has no
  // target_is_active; that would misread/crash on real data).
  if (actionType === 'shelf_schedule') return computeScheduleDiff(items as ShelfScheduleItem[], ctx)
  return computeShelfDiff(actionType, items as ChangeSetItem[], ctx)
}

export async function computeShelfDiff(actionType: Exclude<ActionType, 'inventory_setting'>, items: ChangeSetItem[], ctx: ToolContext): Promise<DiffItem[]> {
  if (actionType === 'shelf_toggle_product') {
    const oids = [...new Set(items.map(i => i.prod_oid))]
    const env = await findProductsTool.handler({ prod_oids: oids }, ctx)
    if (env.errors.length) throw new DiffError(env.errors.map(e => e.key), `could not read products: ${env.errors.map(e => `${e.key}(${e.code ?? e.status ?? 'err'})`).join(', ')}`)
    const byOid = new Map((env.items as Array<{ prod_oid: string; name?: string; is_active?: boolean }>).map(p => [p.prod_oid, p]))
    const unresolved = items.filter(i => byOid.get(i.prod_oid)?.is_active === undefined).map(i => i.prod_oid)
    if (unresolved.length) throw new DiffError(unresolved, `no current shelf state for: ${unresolved.join(', ')}`)
    return items.map(i => {
      const cur = byOid.get(i.prod_oid)!
      return { prod_oid: i.prod_oid, name: cur.name, current_is_active: cur.is_active,
        target_is_active: i.target_is_active, no_op: cur.is_active === i.target_is_active }
    })
  }
  // shelf_toggle_plan: group by prod_oid, one productPlansTool call each
  const out: DiffItem[] = []
  for (const oid of [...new Set(items.map(i => i.prod_oid))]) {
    const env = await productPlansTool.handler({ prod_oid: oid }, ctx)
    if (env.errors.length) throw new DiffError(env.errors.map(e => e.key), `could not read plans for ${oid}: ${env.errors.map(e => e.code ?? e.status ?? 'err').join(', ')}`)
    const byPkg = new Map((env.items as Array<{ pkg_oid: string; name?: string; is_active?: boolean }>).map(p => [p.pkg_oid, p]))
    for (const i of items.filter(x => x.prod_oid === oid)) {
      const cur = byPkg.get(i.pkg_oid!)
      if (!cur || cur.is_active === undefined) throw new DiffError([`${oid}:${i.pkg_oid}`], `plan ${i.pkg_oid} not found under product ${oid}`)
      out.push({ prod_oid: oid, pkg_oid: i.pkg_oid, name: cur.name, current_is_active: cur.is_active,
        target_is_active: i.target_is_active, no_op: cur.is_active === i.target_is_active })
    }
  }
  return out
}
