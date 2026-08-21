import type { InventoryItem } from '../../../core/changeset/types.js'

// spec §5.2: fullday SET. quantity integer >= 0; (item, supplier) unique across the whole
// change-set (two SETs on the same target are ambiguous).
export function validateInventoryItems(items: InventoryItem[], _nowMs: number): { key: string; message: string } | undefined {
  const seen = new Set<string>()
  for (const it of items) {
    const key = `${it.item_oid}:${it.supplier_oid}`
    if (!Number.isInteger(it.quantity)) return { key, message: 'quantity must be an integer' }
    if (it.quantity < 0) return { key, message: 'quantity (SET target) must be >= 0' }
    if (seen.has(key)) return { key, message: `duplicate (item, supplier): ${key}` }
    seen.add(key)
  }
  return undefined
}
