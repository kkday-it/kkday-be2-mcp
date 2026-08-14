import type { GatewayClient } from '../gateway/client.js'
import type { ToolContext } from '../tools/types.js'
import { booleansToPlatform } from './batchValidate.js'
import { DiffError } from './diff.js'
import type { InventoryPlatformDiffItem, InventoryPlatformItem } from './types.js'

// Task 1 定案 (docs/be2-mcp/sit-write-contracts.md §inventory-platform read): the two booleans
// have NO mirror GET on the write endpoint — the real source of truth is the aggregate config
// endpoint `GET items/{itemOid}/configs`, whose `supplier_configs[]` carries per-supplier rows
// with `is_external_inventory`/`is_inventory_mgmt` (same wire field names as the PUT contract).
// 嚴禁盲寫: any failure to find a well-typed row for this supplier_oid throws DiffError — never
// default the booleans.
export async function readSupplierInventorySetting(
  gateway: GatewayClient, accessToken: string, itemOid: string, supplierOid: string,
): Promise<{ is_external_inventory: boolean; is_inventory_mgmt: boolean }> {
  const raw = await gateway.get(`/product/api/v1/items/${encodeURIComponent(itemOid)}/configs`, accessToken)
  const rows = (raw as { supplier_configs?: unknown[] })?.supplier_configs
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

// Per (item_oid, supplier_oid) live diff (design doc §4.1). One GET per item (item-level
// aggregate endpoint) — never calls the packages endpoint. affected_pkgs is carried through
// verbatim as a display annotation only (spec: the real write unit is item×supplier, not the
// packages that happen to reference it).
export async function computePlatformDiff(items: InventoryPlatformItem[], ctx: ToolContext): Promise<InventoryPlatformDiffItem[]> {
  const out: InventoryPlatformDiffItem[] = []
  for (const it of items) {
    const booleans = await readSupplierInventorySetting(ctx.gateway, ctx.accessToken, it.item_oid, it.supplier_oid)
    const current = booleansToPlatform(booleans)
    if (current === undefined) {
      throw new DiffError([`${it.item_oid}:${it.supplier_oid}`],
        `undefined inventory-platform combination (is_external_inventory+is_inventory_mgmt both true) for ${it.item_oid}:${it.supplier_oid}`)
    }
    out.push({ item_oid: it.item_oid, supplier_oid: it.supplier_oid, current, target: it.target,
      noop: current === it.target, affected_pkgs: it.affected_pkgs })
  }
  return out
}
