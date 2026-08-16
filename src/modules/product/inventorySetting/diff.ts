import type { ToolContext } from '../../../tools/types.js'
import { parseQuantities, groupDatesByMonth } from '../../../tools/inventoryShape.js'
import { DiffError } from '../../../core/changeset/diff.js'
import type { InventoryDateDiff, InventoryDiffItem, InventoryItem } from '../../../core/changeset/types.js'

// Per-date live diff (spec §4). One GET per (item, supplier, month) — the quantities endpoint
// is month-scoped. adjust needs a numeric base for every date (嚴禁盲寫: a delta on an unknown
// base is undefined); set may target an unknown base (it's still a fully-defined write).
export async function computeInventoryDiff(items: InventoryItem[], ctx: ToolContext): Promise<InventoryDiffItem[]> {
  const out: InventoryDiffItem[] = []
  for (const it of items) {
    const byDate: Record<string, number> = {}
    for (const [ym] of groupDatesByMonth(it.dates)) {
      const raw = await ctx.gateway.get(
        `/product/api/v1/items/${encodeURIComponent(it.item_oid)}/inventories/${encodeURIComponent(it.supplier_oid)}`,
        ctx.accessToken, { year_month: ym })
      Object.assign(byDate, parseQuantities(raw).byDate)
    }
    const noBase = it.op === 'adjust' ? it.dates.filter(d => byDate[d] === undefined) : []
    if (noBase.length) {
      throw new DiffError(noBase.map(d => `${it.item_oid}:${it.supplier_oid}:${d}`),
        `adjust needs a readable current quantity; none for: ${noBase.join(', ')}`)
    }
    const dates: InventoryDateDiff[] = it.dates.map(d => {
      const current = byDate[d]
      const target = it.op === 'set' ? it.quantity : (current as number) + it.quantity
      return { date: d, current, target, no_op: it.op === 'set' && current === it.quantity, would_go_negative: target < 0 }
    })
    out.push({ item_oid: it.item_oid, supplier_oid: it.supplier_oid, op: it.op, quantity: it.quantity, dates })
  }
  return out
}
