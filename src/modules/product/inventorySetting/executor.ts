import type { GatewayClient } from '../../../gateway/client.js'
import type { InventoryItem, ItemResult, ChangeSetRecord } from '../../../core/changeset/types.js'
import { readCurrentFullday } from '../../../tools/inventoryShape.js'
import type { ExecCtx } from '../../../core/changeset/module.js'

export interface InventoryExecDeps {
  gateway: GatewayClient
  sleep?: (ms: number) => Promise<void>
  poll?: { retries: number; delayMs: number }
}

// I-1 (Phase 3a): two different change-sets can target the same (item_oid, supplier_oid) near-
// simultaneously (two confirm tabs). Serialize the whole critical section per key with an in-
// process promise-chain mutex. PRODUCTION NOTE: in-process only — a multi-instance deploy needs
// a distributed lock (Redis) or two instances can still race the same item×supplier.
const inflight = new Map<string, Promise<unknown>>()

export async function execInventory(deps: InventoryExecDeps, at: string, modifyUser: string, it: InventoryItem, traceId: string): Promise<ItemResult> {
  const key = `${it.item_oid}:${it.supplier_oid}`
  const prev = inflight.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(() => doExec(deps, at, modifyUser, it, traceId))
  inflight.set(key, run)
  try { return await run } finally { if (inflight.get(key) === run) inflight.delete(key) }
}

async function doExec(deps: InventoryExecDeps, at: string, modifyUser: string, it: InventoryItem, traceId: string): Promise<ItemResult> {
  const gw = deps.gateway
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const poll = deps.poll ?? { retries: 5, delayMs: 2000 }
  const key = `${it.item_oid}:${it.supplier_oid}`
  const oid = encodeURIComponent(it.item_oid)
  const sup = encodeURIComponent(it.supplier_oid)

  // step 0: busy guard — never read a base while a prior write is still processing.
  let busy = true
  for (let i = 0; i <= poll.retries; i++) {
    const st = await gw.get(`/product/api/v1/items/${oid}/inventories/status`, at) as { is_processing?: boolean }
    if (!st?.is_processing) { busy = false; break }
    if (i < poll.retries) await sleep(poll.delayMs)
  }
  if (busy) return { item_key: key, status: 'failed', error_code: 'INVENTORY_BUSY', error_message: 'inventory is still processing a prior write; refusing to write on a stale base', trace_id: traceId }

  // read current fullday
  let current: number | undefined
  try {
    current = await readCurrentFullday(gw, at, it.item_oid, it.supplier_oid)
  } catch (e) {
    return { item_key: key, status: 'failed', error_code: 'READ_FAILED', error_message: (e as Error).message, trace_id: traceId }
  }
  const before: Record<string, number> = {}
  if (current !== undefined) before.fullday = current
  if (current === it.quantity) return { item_key: key, status: 'skipped_noop', before, after: { fullday: current }, trace_id: traceId }

  // write (SET = modify_type 1)
  try {
    await gw.put(`/product/api/v1/items/${oid}/inventories/${sup}/quantity`, at, {
      inventory_data: { remain_qty: { [it.item_oid]: { fullday: it.quantity } }, modify_type: 1 },
      modify_user: modifyUser,
    })
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { item_key: key, status: 'failed', before, error_code: err.code, error_message: err.message, trace_id: traceId }
  }
  // after re-read is isolated: a successful write must NEVER be reported 'failed' on a re-read blip.
  const after: Record<string, number> = {}
  let errCode: string | undefined, errMsg: string | undefined
  try {
    const rq = await readCurrentFullday(gw, at, it.item_oid, it.supplier_oid)
    if (rq !== undefined) after.fullday = rq
  } catch (e) {
    errCode = 'AFTER_READ_FAILED'; errMsg = `write succeeded but the after re-read failed: ${(e as Error).message}`
  }
  return { item_key: key, status: 'done', before, after, error_code: errCode, error_message: errMsg, trace_id: traceId }
}

export async function executeInventorySetting(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]> {
  const results: ItemResult[] = []
  for (const it of rec.items as InventoryItem[]) {
    const r = await ctx.span('changeset.execute/inventory_setting', tid =>
      execInventory({ gateway: ctx.gateway }, ctx.accessToken, ctx.modifyUser, it, tid)
    ).catch(e => ({
      item_key: `${it.item_oid}:${it.supplier_oid}`, status: 'failed' as const,
      error_code: 'EXEC_ERROR', error_message: (e as Error).message, trace_id: 'n/a',
    }))
    results.push(r)
  }
  return results
}
