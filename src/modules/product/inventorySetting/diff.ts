import type { ToolContext } from '../../../tools/types.js'
import { parseInventoryFullday, readItemMode, isItemByAmount } from '../../../tools/inventoryShape.js'
import { DiffError } from '../../../core/changeset/diff.js'
import type { InventoryDiffItem, InventoryItem } from '../../../core/changeset/types.js'

// spec §5.3. Fullday SET diff. Mode gate first (only item_by_amount 1/0); then POST search for
// current fullday. Any read failure or mode mismatch is fail-closed (嚴禁盲寫). current=undefined
// (未設) is legal for SET — it is still a fully-defined write.
export async function computeInventoryDiff(items: InventoryItem[], ctx: ToolContext): Promise<InventoryDiffItem[]> {
  const out: InventoryDiffItem[] = []
  for (const it of items) {
    const key = `${it.item_oid}:${it.supplier_oid}`
    let mode: { control_type?: number; inventory_type?: number | null }
    let current: number | undefined
    try {
      const basic = await ctx.gateway.get(`/product/api/v1/items/${encodeURIComponent(it.item_oid)}/basic-info`, ctx.accessToken)
      mode = readItemMode(basic)
      if (!isItemByAmount(mode)) {
        throw new DiffError([key], `此商品非「套餐總量限制」模式（control_type=${mode.control_type}, inventory_type=${mode.inventory_type}），即時庫存數量版僅支援套餐總量；SKU/依日期模式尚未支援`)
      }
      const raw = await ctx.gateway.post(`/product/api/v1/items/${encodeURIComponent(it.item_oid)}/inventories/search`, ctx.accessToken, { supplier_oid: it.supplier_oid, page: 1 })
      current = parseInventoryFullday(raw, it.item_oid)
    } catch (e) {
      if (e instanceof DiffError) throw e
      throw new DiffError([key], `讀取庫存現況失敗（${(e as Error).message}）；fail-closed 不建立`)
    }
    out.push({ item_oid: it.item_oid, supplier_oid: it.supplier_oid, current, target: it.quantity, no_op: current === it.quantity })
  }
  return out
}
