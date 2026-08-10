// Single source of truth for the per-date quantities shape (spec §6.3): the L0 read tool's
// trim, the diff module, and the executor's read-merge-write all resolve rows/fields HERE.
// The real GET shape has never been observed live (every Phase 1a supplier read 403'd), so
// these are tolerant candidate lists. FINALIZE(Task 1): once tests/fixtures/inventory-quantities.json
// exists, tighten each list to the single observed key and add a fixture test.
export const ROWS_KEYS = ['itemInventory', 'item_inventory', 'inventories', 'quantities']
export const DATE_KEYS = ['date', 'inventory_date', 'sale_date']
export const QTY_KEYS = ['quantity', 'qty', 'inventory_qty', 'stock']

export interface ParsedQuantities { byDate: Record<string, number>; raw: unknown }

export function findRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>
  const r = raw as Record<string, unknown> | undefined
  for (const k of ROWS_KEYS) {
    const v = r?.[k]
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>
  }
  return []
}
export function rowDate(row: Record<string, unknown>): string | undefined {
  for (const k of DATE_KEYS) { const v = row[k]; if (typeof v === 'string') return v.slice(0, 10) }
  return undefined
}
export function rowQty(row: Record<string, unknown>): number | undefined {
  for (const k of QTY_KEYS) { const v = row[k]; if (typeof v === 'number') return v }
  return undefined
}
export function setRowQty(row: Record<string, unknown>, qty: number): void {
  for (const k of QTY_KEYS) { if (typeof row[k] === 'number') { row[k] = qty; return } }
  row[QTY_KEYS[0]] = qty
}
export function parseQuantities(raw: unknown): ParsedQuantities {
  const byDate: Record<string, number> = {}
  for (const row of findRows(raw)) {
    const d = rowDate(row); const q = rowQty(row)
    if (d !== undefined && q !== undefined) byDate[d] = q
  }
  return { byDate, raw }
}
export function groupDatesByMonth(dates: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const d of dates) { const ym = d.slice(0, 7); const g = m.get(ym) ?? []; g.push(d); m.set(ym, g) }
  return m
}
