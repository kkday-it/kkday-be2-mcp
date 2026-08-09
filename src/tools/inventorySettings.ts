import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope, toEnvelopeError } from './envelope.js'

// Trim to decision-relevant fields only (spec §4: no raw dumps). Adjust key names
// against tests/fixtures/inventory.json (Task 4) — be2-api may return camelCase.
export function trimInventory(itemOid: string, invRaw: unknown, statusRaw: unknown): Record<string, unknown> {
  const r = invRaw as Record<string, any>
  const pick = (...keys: string[]) => keys.map(k => r?.[k]).find(v => v !== undefined)
  return {
    item_oid: itemOid,
    supplier_oid: pick('supplierOid', 'supplier_oid'),
    inventory_setting: pick('inventorySetting', 'inventory_setting', 'itemConfig', 'item_config'),
    suppliers: (pick('itemSupplierMapping', 'item_supplier_mapping') as any[] | undefined)
      ?.map(s => ({ supplier_oid: s?.supplier_oid ?? s?.supplierOid, is_default: s?.is_default ?? s?.isDefault })),
    inventories: pick('itemInventory', 'item_inventory', 'inventories'),
    inventory_status: statusRaw,
  }
}

const inputShape = {
  item_oid: z.string().min(1).describe('be2 item oid (each plan/package has exactly one item; get item_oid from be2_get_product_plans)'),
  supplier_oid: z.string().min(1).optional().describe('supplier oid; omit to use the item\'s default supplier'),
  year_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe('inventory month to read, YYYY-MM; defaults to current month'),
}

export const inventorySettingsTool: ToolDef<typeof inputShape> = {
  name: 'be2_get_inventory_settings',
  description:
    'Read a be2 item\'s inventory settings and quantities for one month: inventory mode, supplier mapping, ' +
    'per-date quantities, and inventory status flags. Read-only, no side effects. ' +
    'item_oid comes from be2_get_product_plans (1 plan = 1 item).',
  inputShape,
  async handler(args, ctx) {
    const oid = encodeURIComponent(args.item_oid)
    const query: Record<string, string> = {}
    if (args.supplier_oid) query.supplier_oid = args.supplier_oid
    if (args.year_month) query.year_month = args.year_month
    const [invResult, statusResult] = await Promise.allSettled([
      ctx.gateway.get(`/be2/api/v1/product/item/${oid}/inventory`, ctx.accessToken, query),
      ctx.gateway.get(`/be2/api/v1/product/item/${oid}/inventory/status`, ctx.accessToken),
    ])
    if (invResult.status === 'rejected') {
      return makeEnvelope([], [toEnvelopeError(args.item_oid, invResult.reason)])
    }
    const status = statusResult.status === 'fulfilled' ? statusResult.value : undefined
    const item = trimInventory(args.item_oid, invResult.value, status)
    const errors = statusResult.status === 'rejected' ? [toEnvelopeError(args.item_oid, statusResult.reason)] : []
    return makeEnvelope([item], errors, [args.item_oid])
  },
}
