// Single source of truth for the inventory fullday read contract (spec §6): the L0 read tool,
// the diff module, the executor, and batchView all read current quantity THROUGH here so the
// endpoint + response shape can't drift between call sites. Real shape (2026-08-19/20 live):
// {data:{[itemOid|skuOid]:{fullday:number|null}}}. 本版只用 item_by_amount 的 {itemOid:{fullday}}；
// 主解析為快樂路徑，保留 defensive 降級（不鎖死原則）。

// Structural gateway type — avoids importing GatewayClient so this file stays import-light.
interface InvGateway { post(path: string, accessToken: string, body: unknown): Promise<unknown> }

export function inventorySearchPath(itemOid: string): string {
  return `/product/api/v1/items/${encodeURIComponent(itemOid)}/inventories/search`
}

// The one place the read-current-fullday call lives: POST inventories/search + parse.
export async function readCurrentFullday(gw: InvGateway, accessToken: string, itemOid: string, supplierOid: string): Promise<number | undefined> {
  const raw = await gw.post(inventorySearchPath(itemOid), accessToken, { supplier_oid: supplierOid, page: 1 })
  return parseInventoryFullday(raw, itemOid)
}

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

// control_type:inventory_type 的 1/0 編碼 → 人話標籤。與 readItemMode/isItemByAmount 同擁一組 1/0 語義，
// 故 label 版也放這裡當單一事實來源（原本 batchView.ts 另編一份 MODE_LABEL，code-review Standards 軸
// Duplicated domain knowledge）。control_type 未讀到 → undefined；已知但非四種組合 → 'unsupported'。
const MODE_LABEL: Record<string, string> = { '1:0': 'item_by_amount', '2:0': 'sku_by_amount', '1:1': 'item_by_date', '2:1': 'sku_by_date' }
export function modeLabel(mode: { control_type?: number; inventory_type?: number | null }): string | undefined {
  return mode.control_type === undefined ? undefined : (MODE_LABEL[`${mode.control_type}:${mode.inventory_type}`] ?? 'unsupported')
}
