import type { GatewayClient } from '../../../gateway/client.js'
import type { InventoryItem, ItemResult, ChangeSetRecord } from '../../../changeset/types.js'
import { DATE_KEYS, QTY_KEYS, ROWS_KEYS, findRows, groupDatesByMonth, parseQuantities, rowDate, setRowQty } from '../../../tools/inventoryShape.js'
import type { ExecCtx } from '../../../core/changeset/module.js'

export interface InventoryExecDeps {
  gateway: GatewayClient
  sleep?: (ms: number) => Promise<void>
  poll?: { retries: number; delayMs: number }
}
type DateStatus = 'done' | 'skipped_noop' | 'failed'

// I-1: two DIFFERENT change-sets can target the same (item_oid, supplier_oid) and be approved
// near-simultaneously (two confirm tabs). The busy guard above only protects against a prior
// WRITE still processing server-side — it does nothing to stop two concurrent executions of
// THIS process both reading the same stale base before either PUT lands (silent lost update:
// +50 and +30 against base 10 both report 'done' but the final quantity is 40, not 90).
// Serialize the entire critical section per (item_oid:supplier_oid) key with an in-process
// promise-chain mutex. Keys never queue behind unrelated keys (see tests/inventoryExecutor.test.ts).
//
// PRODUCTION NOTE: this mutex is in-process only — correct for the current single-process
// SQLite POC. A multi-process deployment (multiple be2-mcp instances) needs a distributed lock
// (e.g. Redis) instead, or two instances can still race the same item×supplier.
const inflight = new Map<string, Promise<unknown>>()

export async function execInventory(deps: InventoryExecDeps, at: string, modifyUser: string, it: InventoryItem, traceId: string): Promise<ItemResult> {
  const key = `${it.item_oid}:${it.supplier_oid}`
  const prev = inflight.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(() => doExecInventory(deps, at, modifyUser, it, traceId))
  inflight.set(key, run)
  try {
    return await run
  } finally {
    if (inflight.get(key) === run) inflight.delete(key)
  }
}

// spec §5. Per item: (0) busy guard — never read a base while a prior write is processing
// (merging from a stale base would overwrite the in-flight change); (1..4) one full
// read-merge-write cycle PER MONTH (GET is month-scoped; cross-month PUT unproven — Task 1);
// per-date: set==live => skipped_noop, adjust below 0 => failed WOULD_GO_NEGATIVE (never
// clamped, never blocks sibling dates). Aggregation NEVER collapses partial success to
// 'failed' — a re-issued adjust would double-apply on the succeeded dates (spec §4).
async function doExecInventory(deps: InventoryExecDeps, at: string, modifyUser: string, it: InventoryItem, traceId: string): Promise<ItemResult> {
  const gw = deps.gateway
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const poll = deps.poll ?? { retries: 5, delayMs: 2000 }
  const key = `${it.item_oid}:${it.supplier_oid}`
  const basePath = `/product/api/v1/items/${encodeURIComponent(it.item_oid)}/inventories`

  // step 0: busy guard
  let busy = true
  for (let i = 0; i <= poll.retries; i++) {
    const st = await gw.get(`${basePath}/status`, at) as { is_processing?: boolean }
    if (!st?.is_processing) { busy = false; break }
    if (i < poll.retries) await sleep(poll.delayMs)
  }
  if (busy) {
    return { item_key: key, status: 'failed', error_code: 'INVENTORY_BUSY',
      error_message: 'inventory is still processing a prior write; refusing to read a stale base', trace_id: traceId }
  }

  const before: Record<string, number> = {}
  const afterQty: Record<string, number> = {}
  const dateStatus: Record<string, DateStatus> = {}
  let firstError: { code?: string; message?: string } | undefined

  for (const [ym, dates] of groupDatesByMonth(it.dates)) {
    let raw: unknown
    try {
      raw = await gw.get(`${basePath}/${encodeURIComponent(it.supplier_oid)}`, at, { year_month: ym })
    } catch (e) {
      const err = e as { code?: string; message?: string }
      firstError ??= err
      for (const d of dates) dateStatus[d] = 'failed'
      continue
    }
    const byDate = parseQuantities(raw).byDate
    for (const d of dates) if (byDate[d] !== undefined) before[d] = byDate[d]

    // compute per-date targets from the EXECUTION-time live base (spec §4)
    const targets = new Map<string, number>()
    for (const d of dates) {
      const cur = byDate[d]
      if (it.op === 'set') {
        if (cur === it.quantity) { dateStatus[d] = 'skipped_noop'; afterQty[d] = cur; continue }
        targets.set(d, it.quantity)
      } else {
        if (cur === undefined) { dateStatus[d] = 'failed'; firstError ??= { code: 'NO_BASE', message: `no readable quantity for ${d}` }; continue }
        const t = cur + it.quantity
        if (t < 0) { dateStatus[d] = 'failed'; firstError ??= { code: 'WOULD_GO_NEGATIVE', message: `adjust would take ${d} below zero` }; continue }
        targets.set(d, t)
      }
    }
    if (targets.size === 0) continue

    // read-merge-write: clone the FULL month body, overwrite ONLY target dates' quantity.
    // FINALIZE(Task 1): if the probe proves per-date merge semantics, this stays correct;
    // if it proves replace, this is the ONLY safe shape. Never send a date subset before proof.
    const body = structuredClone(raw) as Record<string, unknown>
    let rows = findRows(body)
    if (rows.length === 0 && !Array.isArray(body)) { body[ROWS_KEYS[0]] = []; rows = findRows(body) }
    const covered = new Set<string>()
    for (const row of rows) {
      const d = rowDate(row)
      if (d && targets.has(d)) { setRowQty(row, targets.get(d)!); covered.add(d) }
    }
    // `set` may target a date with NO existing live row (diff allows current: undefined) — the
    // merge loop above only rewrites EXISTING rows, so missing dates must be INJECTED or the PUT
    // silently omits them and the write never lands (agy round-1). Row key names: the resolved
    // shape constants — FINALIZE(Task 1) alongside DATE_KEYS/QTY_KEYS.
    for (const [d, qty] of targets) {
      if (!covered.has(d)) rows.push({ [DATE_KEYS[0]]: d, [QTY_KEYS[0]]: qty })
    }
    // The PUT body MUST be a JSON object: a named property assigned onto a bare array survives
    // in memory but is STRIPPED by JSON.stringify, silently dropping modify_user (agy round-2).
    // If the GET returned a bare row array, wrap it under the canonical rows key.
    // FINALIZE(Task 1): confirm the accepted PUT envelope (rows key + modify_user placement).
    const putBody: Record<string, unknown> = Array.isArray(body) ? { [ROWS_KEYS[0]]: body } : body
    putBody.modify_user = modifyUser
    // PUT and the after-re-read are isolated: a successful write must NEVER be reported as
    // 'failed' just because the re-read blipped (agy round-1) — a 'failed' adjust invites the
    // user to re-issue the delta, double-applying it on the backend. Re-read failure keeps the
    // dates 'done' with an AFTER_READ_FAILED note and no after-quantity (honest, not corrupting).
    try {
      await gw.put(basePath, at, putBody)
    } catch (e) {
      const err = e as { code?: string; message?: string }
      firstError ??= err
      for (const d of targets.keys()) dateStatus[d] = 'failed'
      continue
    }
    for (const d of targets.keys()) dateStatus[d] = 'done'
    try {
      const reread = parseQuantities(await gw.get(`${basePath}/${encodeURIComponent(it.supplier_oid)}`, at, { year_month: ym })).byDate
      for (const d of targets.keys()) if (reread[d] !== undefined) afterQty[d] = reread[d]
    } catch (e) {
      firstError ??= { code: 'AFTER_READ_FAILED', message: `write succeeded but the after-state re-read failed: ${(e as Error).message}` }
    }
  }

  const statuses = new Set(Object.values(dateStatus))
  const status: ItemResult['status'] =
    statuses.size === 1 && statuses.has('skipped_noop') ? 'skipped_noop'
    : [...statuses].every(s => s === 'failed') ? 'failed'
    : statuses.has('failed') ? 'partial'
    : 'done'
  return {
    item_key: key, status, before,
    after: { quantities: afterQty, date_status: dateStatus },
    error_code: firstError?.code, error_message: firstError?.message, trace_id: traceId,
  }
}

export async function executeInventorySetting(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]> {
  const results: ItemResult[] = []
  for (const it of rec.items as InventoryItem[]) {
    const r = await ctx.span('changeset.execute/inventory_setting', tid => 
      execInventory({ gateway: ctx.gateway }, ctx.accessToken, ctx.modifyUser, it, tid)
    ).catch(e => ({
      item_key: `${it.item_oid}:${it.supplier_oid}`,
      status: 'failed' as const,
      error_code: 'EXEC_ERROR',
      error_message: (e as Error).message,
      trace_id: 'n/a'
    }))
    results.push(r)
  }
  return results
}
