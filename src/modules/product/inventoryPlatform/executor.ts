import type { GatewayClient } from '../../../gateway/client.js'
import { platformToBooleans, booleansToPlatform } from './validate.js'
import { readSupplierInventorySetting } from './diff.js'
import type { ChangeSetRecord, InventoryPlatformItem, ItemResult } from '../../../core/changeset/types.js'
import type { ExecCtx } from '../../../core/changeset/module.js'

// Shared executor context for the Phase 4a batch-shaped executors (inventory_platform here;
// shelf_schedule in Task 4 reuses this same shape). Unlike execInventory (per-item, invoked in a
// loop by executor.ts), these executors take the whole ChangeSetRecord and hand back the FULL
// ItemResult[] for the batch themselves — there is no busy-guard/serialization concern for a
// platform-flag write, so items are independent and safe to run concurrently.
export interface ExecutorContext {
  gateway: GatewayClient
  accessToken: string
  modifyUser: string
  traceId: string
}

async function execOnePlatformItem(ctx: ExecutorContext, it: InventoryPlatformItem): Promise<ItemResult> {
  const key = `${it.item_oid}:${it.supplier_oid}`
  let before: { is_external_inventory: boolean; is_inventory_mgmt: boolean }
  try {
    before = await readSupplierInventorySetting(ctx.gateway, ctx.accessToken, it.item_oid, it.supplier_oid)
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { item_key: key, status: 'failed', error_code: err.code ?? 'DIFF_READ_FAILED', error_message: err.message, trace_id: ctx.traceId }
  }
  const currentPlatform = booleansToPlatform(before)
  if (currentPlatform === undefined) {
    return { item_key: key, status: 'failed', before,
      error_code: 'UNDEFINED_PLATFORM_COMBO', error_message: `undefined inventory-platform combination for ${key}`, trace_id: ctx.traceId }
  }
  if (currentPlatform === it.target) {
    return { item_key: key, status: 'skipped_noop', before, after: before, trace_id: ctx.traceId }
  }
  const target = platformToBooleans(it.target)
  const path = `/product/api/v1/items/${encodeURIComponent(it.item_oid)}/supplier-configs/${encodeURIComponent(it.supplier_oid)}/inventory-setting`
  try {
    await ctx.gateway.put(path, ctx.accessToken, { ...target, modify_user: ctx.modifyUser })
    return { item_key: key, status: 'done', before, after: target, trace_id: ctx.traceId }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { item_key: key, status: 'failed', before, error_code: err.code, error_message: err.message, trace_id: ctx.traceId }
  }
}

// Items are independent (item×supplier granularity, no shared server-side resource like the
// per-item busy inventory-quantity lock) — Promise.allSettled so one item's PUT failure never
// aborts the sibling items' writes (spec §4/§7 per-item failure isolation).
export async function execInventoryPlatform(rec: ChangeSetRecord, ctx: ExecutorContext): Promise<ItemResult[]> {
  const items = rec.items as InventoryPlatformItem[]
  const settled = await Promise.allSettled(items.map(it => execOnePlatformItem(ctx, it)))
  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value
    const it = items[i]
    return {
      item_key: `${it.item_oid}:${it.supplier_oid}`, status: 'failed' as const,
      error_code: 'EXEC_ERROR', error_message: (s.reason as Error)?.message ?? String(s.reason), trace_id: ctx.traceId,
    }
  })
}

export async function executeInventoryPlatform(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]> {
  return await ctx.span('changeset.execute/inventory_platform', async (traceId) => {
    return await execInventoryPlatform(rec, {
      gateway: ctx.gateway,
      accessToken: ctx.accessToken,
      modifyUser: ctx.modifyUser,
      traceId
    })
  }).catch(e => (rec.items as InventoryPlatformItem[]).map(it => ({
    item_key: `${it.item_oid}:${it.supplier_oid}`, status: 'failed' as const,
    error_code: 'EXEC_ERROR', error_message: (e as Error).message, trace_id: ctx.traceId,
  })))
}
