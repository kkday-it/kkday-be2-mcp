import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope, toEnvelopeError, type EnvelopeError } from './envelope.js'
import { parseInventoryFullday, readItemMode, inventorySearchPath } from './inventoryShape.js'

// spec §4: no raw dumps. Status shape verified live (product-service-direct):
// { is_processing, previous_status, previous_msg, previous_time }. Quantity read is the
// item_by_amount fullday (POST inventories/search); non-item_by_amount modes are read-only here
// and reported via inventory_mode (fullday left undefined).
export function trimInventory(itemOid: string, statusRaw: unknown, basicInfoRaw?: unknown, searchRaw?: unknown): Record<string, unknown> {
  const s = (statusRaw ?? {}) as Record<string, any>
  const out: Record<string, unknown> = {
    item_oid: itemOid,
    is_processing: s.is_processing,
    previous_status: s.previous_status,
    previous_msg: s.previous_msg,
    previous_time: s.previous_time,
  }
  if (basicInfoRaw !== undefined) out.inventory_mode = readItemMode(basicInfoRaw)
  if (searchRaw !== undefined) out.fullday = parseInventoryFullday(searchRaw, itemOid)
  return out
}

const inputShape = {
  item_oid: z.string().min(1).describe('be2 item oid (each plan/package has exactly one item; get item_oid from be2_get_product_plans)'),
  supplier_oid: z.string().min(1).optional().describe('supplier oid; provide to also read the item_by_amount fullday quantity for that supplier'),
}

export const inventorySettingsTool: ToolDef<typeof inputShape> = {
  name: 'be2_get_inventory_settings',
  description:
    'Read a be2 item\'s inventory status + mode, and (when supplier_oid is given) the套餐總量 (item_by_amount) fullday quantity for that supplier. ' +
    'Read-only, no side effects. item_oid comes from be2_get_product_plans (1 plan = 1 item).',
  inputShape,
  uiResourceUri: 'ui://be2/products-panel.html',
  annotations: { title: 'Get inventory settings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const oid = encodeURIComponent(args.item_oid)
    const calls: Promise<unknown>[] = [ctx.gateway.get(`/product/api/v1/items/${oid}/inventories/status`, ctx.accessToken)]
    if (args.supplier_oid) {
      calls.push(ctx.gateway.get(`/product/api/v1/items/${oid}/basic-info`, ctx.accessToken))
      calls.push(ctx.gateway.post(inventorySearchPath(args.item_oid), ctx.accessToken, { supplier_oid: args.supplier_oid, page: 1 }))
    }
    const [statusR, basicR, searchR] = await Promise.allSettled(calls)
    if (statusR!.status === 'rejected') return makeEnvelope([], [toEnvelopeError(args.item_oid, statusR!.reason)])
    const errors: EnvelopeError[] = []
    let basic: unknown, search: unknown
    if (basicR) { if (basicR.status === 'fulfilled') basic = basicR.value; else errors.push(toEnvelopeError(args.item_oid, basicR.reason)) }
    if (searchR) { if (searchR.status === 'fulfilled') search = searchR.value; else errors.push(toEnvelopeError(args.item_oid, searchR.reason)) }
    const item = trimInventory(args.item_oid, statusR!.value, args.supplier_oid ? basic : undefined, args.supplier_oid ? search : undefined)
    return makeEnvelope([item], errors, [args.item_oid])
  },
}
