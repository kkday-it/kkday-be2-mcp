import type { InventoryItem } from './types.js'

// Semantic rules zod can't express per-field (spec §3): op/quantity coupling, past dates,
// and (item, supplier, date) uniqueness across the WHOLE change-set — two ops on the same
// date would make execution order ambiguous. Date compare is on the UTC calendar date; SIT
// operates UTC+8 so this is the conservative side (never rejects a date that is still
// "today" anywhere the operator sits).
export function validateInventoryItems(items: InventoryItem[], nowMs: number): { key: string; message: string } | undefined {
  const today = new Date(nowMs).toISOString().slice(0, 10)
  const seen = new Set<string>()
  for (const it of items) {
    if (!Number.isInteger(it.quantity)) return { key: `${it.item_oid}:${it.supplier_oid}`, message: 'quantity must be an integer' }
    if (it.op === 'adjust' && it.quantity === 0) return { key: `${it.item_oid}:${it.supplier_oid}`, message: 'adjust requires a non-zero delta' }
    if (it.op === 'set' && it.quantity < 0) return { key: `${it.item_oid}:${it.supplier_oid}`, message: 'set requires a target >= 0' }
    for (const d of it.dates) {
      if (d < today) return { key: `${it.item_oid}:${it.supplier_oid}:${d}`, message: `date ${d} is in the past` }
      const k = `${it.item_oid}:${it.supplier_oid}:${d}`
      if (seen.has(k)) return { key: k, message: `duplicate (item, supplier, date): ${k}` }
      seen.add(k)
    }
  }
  return undefined
}
