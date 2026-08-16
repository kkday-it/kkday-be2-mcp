import type { GatewayClient } from '../../../gateway/client.js'
import { DiffError } from '../shelfToggle/diff.js'

// Task 1 定案 (docs/be2-mcp/sit-write-contracts.md §inventory-platform read):
// GET items/{itemOid}/basic-info -> data.item_config.supplier_configs[]
// carries {supplier_oid, is_external_inventory, is_inventory_mgmt} per supplier.
// 嚴禁盲寫: any failure to find a well-typed row for this supplier_oid throws DiffError — never
// default the booleans.
export async function readSupplierInventorySetting(
  gateway: GatewayClient, accessToken: string, itemOid: string, supplierOid: string,
  cachedRaw?: unknown
): Promise<{ is_external_inventory: boolean; is_inventory_mgmt: boolean }> {
  const raw = cachedRaw !== undefined ? cachedRaw : await gateway.get(`/product/api/v1/items/${encodeURIComponent(itemOid)}/basic-info`, accessToken)
  const data = (raw as any)?.data ?? raw
  const rows = data?.item_config?.supplier_configs
  const row = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown>>).find(r => String(r?.supplier_oid) === String(supplierOid))
    : undefined
  const isExternal = row?.is_external_inventory
  const isMgmt = row?.is_inventory_mgmt
  if (typeof isExternal !== 'boolean' || typeof isMgmt !== 'boolean') {
    throw new DiffError([`${itemOid}:${supplierOid}`],
      `no readable inventory-platform config (is_external_inventory/is_inventory_mgmt) for ${itemOid}:${supplierOid}`)
  }
  return { is_external_inventory: isExternal, is_inventory_mgmt: isMgmt }
}

export function parseInventoryMode(raw: unknown): string | undefined {
  const data = (raw as any)?.data ?? raw
  const setting = data?.item_config?.inventory_setting
  if (!setting) return undefined
  const control = setting.control_type
  if (control == null) return undefined
  const inv = setting.inventory_type ?? 0
  const code = control * 10 + inv
  switch (code) {
    case 0: return '無限量'
    case 10: return '方案總量'
    case 11: return '方案依日期'
    case 20: return 'SKU總量'
    case 21: return 'SKU依日期'
    default: return undefined
  }
}
