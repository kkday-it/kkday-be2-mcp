// Single source of truth for the per-date quantities shape (spec §6.3): the L0 read tool's
// trim, the diff module, and the executor's read-merge-write all resolve rows/fields HERE.
// The real GET shape has never been observed live (every Phase 1a supplier read 403'd), so
// these are tolerant candidate lists. FINALIZE(Task 1): once tests/fixtures/inventory-quantities.json
// exists, tighten each list to the single observed key and add a fixture test.

// FINALIZE (塊 A): 真實形狀 = data[itemOid|skuOid].fullday（number|null）。本版只用 item_by_amount
// 的 {itemOid:{fullday}}。主解析為快樂路徑，保留 defensive 降級（不鎖死原則）。
export function parseInventoryFullday(raw: unknown, l1Key: string): number | undefined {
  const root = raw as { data?: unknown } | undefined
  const data = (root && typeof root === 'object' && 'data' in root ? root.data : raw) as Record<string, unknown> | undefined
  const entry = data && typeof data === 'object' ? (data as Record<string, unknown>)[l1Key] : undefined
  if (!entry || typeof entry !== 'object') return undefined
  const fd = (entry as Record<string, unknown>).fullday
  if (typeof fd === 'number') return Number.isNaN(fd) ? undefined : fd
  if (typeof fd === 'string' && fd.trim() !== '') { const n = Number(fd); return Number.isNaN(n) ? undefined : n }
  return undefined
}

export function readItemMode(basicInfoRaw: unknown): { control_type?: number; inventory_type?: number | null } {
  const cfg = (basicInfoRaw as any)?.item_config?.inventory_setting ?? {}
  const ct = typeof cfg.control_type === 'number' ? cfg.control_type : undefined
  const it = cfg.inventory_type === null ? null : (typeof cfg.inventory_type === 'number' ? cfg.inventory_type : undefined)
  return { control_type: ct, inventory_type: it }
}

export function isItemByAmount(mode: { control_type?: number; inventory_type?: number | null }): boolean {
  return mode.control_type === 1 && mode.inventory_type === 0
}
