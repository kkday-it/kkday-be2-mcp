import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope, toEnvelopeError, type EnvelopeError } from './envelope.js'
import { parseQuantities } from './inventoryShape.js'

// Trim to decision-relevant fields only (spec §4: no raw dumps).
// Status shape verified live against SIT be2-220 (product-service-direct):
//   { is_processing, previous_status, previous_msg, previous_time }.
// Quantities shape has not been observed live (every tested supplier returned 403 fail-closed),
// so field names below are best-effort/tolerant candidates, not confirmed — kept defensive.
export function trimInventory(itemOid: string, statusRaw: unknown, quantitiesRaw?: unknown): Record<string, unknown> {
  const s = (statusRaw ?? {}) as Record<string, any>
  const out: Record<string, unknown> = {
    item_oid: itemOid,
    is_processing: s.is_processing,
    previous_status: s.previous_status,
    previous_msg: s.previous_msg,
    previous_time: s.previous_time,
  }
  if (quantitiesRaw !== undefined) {
    const q = quantitiesRaw as Record<string, any>
    const pick = (...keys: string[]) => keys.map(k => q?.[k]).find(v => v !== undefined)
    out.inventory_setting = pick('inventorySetting', 'inventory_setting')
    out.inventories = parseQuantities(quantitiesRaw).byDate
    out.suppliers = (pick('itemSupplierMapping', 'item_supplier_mapping') as any[] | undefined)
      ?.map(x => ({ supplier_oid: x?.supplier_oid ?? x?.supplierOid, is_default: x?.is_default ?? x?.isDefault }))
  }
  return out
}

const inputShape = {
  item_oid: z.string().min(1).describe('be2 item oid (each plan/package has exactly one item; get item_oid from be2_get_product_plans)'),
  supplier_oid: z.string().min(1).optional().describe('supplier oid; provide to also read per-date quantities for that supplier'),
  year_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe('inventory month to read, YYYY-MM; only applies when supplier_oid is given; defaults to current month'),
}

export const inventorySettingsTool: ToolDef<typeof inputShape> = {
  name: 'be2_get_inventory_settings',
  description:
    'Read a be2 item\'s inventory status flags, and (when supplier_oid is given) per-date quantities for one month. ' +
    'Read-only, no side effects. item_oid comes from be2_get_product_plans (1 plan = 1 item).',
  inputShape,
  uiResourceUri: 'ui://be2/products-panel.html',
  async handler(args, ctx) {
    const oid = encodeURIComponent(args.item_oid)
    const calls: Promise<unknown>[] = [ctx.gateway.get(`/product/api/v1/items/${oid}/inventories/status`, ctx.accessToken)]
    if (args.supplier_oid) {
      const query: Record<string, string> = {}
      if (args.year_month) query.year_month = args.year_month
      const supplierOid = encodeURIComponent(args.supplier_oid)
      calls.push(ctx.gateway.get(`/product/api/v1/items/${oid}/inventories/${supplierOid}`, ctx.accessToken, query))
    }
    const [statusResult, qtyResult] = await Promise.allSettled(calls)
    if (statusResult!.status === 'rejected') {
      return makeEnvelope([], [toEnvelopeError(args.item_oid, statusResult!.reason)])
    }
    const errors: EnvelopeError[] = []
    let quantities: unknown
    if (qtyResult) {
      if (qtyResult.status === 'fulfilled') quantities = qtyResult.value
      else errors.push(toEnvelopeError(args.item_oid, qtyResult.reason))
    }
    const item = trimInventory(args.item_oid, statusResult!.value, quantities)
    return makeEnvelope([item], errors, [args.item_oid])
  },
}
