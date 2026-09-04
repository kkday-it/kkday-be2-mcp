import type { GatewayClient } from '../../../gateway/client.js'
import { sanitizeQueue } from './validate.js'
import { queuesEqual, sortQueue } from './diff.js'
import type { ChangeSetRecord, ScheduleEntry, ShelfScheduleItem, ItemResult } from '../../../core/changeset/types.js'
import type { ExecCtx } from '../../../core/changeset/module.js'

// Same batch-executor shape as executorPlatform.ts's ExecutorContext (Task 3) — no per-item
// busy-guard/serialization concern for a package-config reserve-queue write, so prod_oid groups
// are independent and safe to run concurrently.
export interface ExecutorContext {
  gateway: GatewayClient
  accessToken: string
  modifyUser: string
  traceId: string
}

// Task 4 定案 write endpoint (design doc §4.1, probe + BAA 警語雙證):
// PUT /product/api/v1/products/{prodOid}/package-configs/reserve-active
//   body { config_data: { [pkgOid]: { reserve_date: null, reserve_status: null, reserve_queue: [{reserve_date, reserve_status}] } }, modify_user }
// reserve_queue is a FULL REPLACE (never merged) — the wire field is `reserve_date`, NOT
// `reserve_date_utc` (that rename only exists on our internal ScheduleEntry shape). The endpoint
// natively supports multiple pkg_oids per PUT (config_data multi-key), so one PUT is issued per
// prod_oid group, covering every non-noop package in that group.
async function execOneProdGroup(ctx: ExecutorContext, prodOid: string, group: ShelfScheduleItem[]): Promise<ItemResult[]> {
  const path = `/product/api/v1/products/${encodeURIComponent(prodOid)}/package-configs`
  let rows: Array<Record<string, unknown>>
  try {
    const raw = await ctx.gateway.get(path, ctx.accessToken)
    rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return group.map(it => ({
      item_key: `${it.prod_oid}:${it.pkg_oid}`, status: 'failed' as const,
      error_code: err.code ?? 'DIFF_READ_FAILED', error_message: err.message, trace_id: ctx.traceId,
    }))
  }
  const byPkg = new Map(rows.map(r => [String(r.pkg_oid), r]))
  const before = new Map<string, ScheduleEntry[]>()
  const target = new Map<string, ScheduleEntry[]>()
  const noopKeys = new Set<string>()
  const configData: Record<string, { reserve_date: null; reserve_status: null; reserve_queue: Array<{ reserve_date: string; reserve_status: boolean }> }> = {}

  for (const it of group) {
    const row = byPkg.get(it.pkg_oid)
    const currentQueue = sanitizeQueue((row?.reserve_queue as Array<{ reserve_date?: unknown; reserve_status?: unknown }>) ?? [])
    const targetQueue = sortQueue(it.queue)
    before.set(it.pkg_oid, currentQueue)
    target.set(it.pkg_oid, targetQueue)
    if (queuesEqual(currentQueue, targetQueue)) {
      noopKeys.add(it.pkg_oid)
      continue
    }
    configData[it.pkg_oid] = {
      reserve_date: null,
      reserve_status: null,
      reserve_queue: targetQueue.map(e => ({ reserve_date: e.reserve_date_utc, reserve_status: e.reserve_status })),
    }
  }

  const results: ItemResult[] = []
  const buildResult = (it: ShelfScheduleItem, ok: boolean, err?: { code?: string; message?: string }): ItemResult => {
    const key = `${it.prod_oid}:${it.pkg_oid}`
    if (noopKeys.has(it.pkg_oid)) {
      const q = before.get(it.pkg_oid)
      return { item_key: key, status: 'skipped_noop', before: q, after: q, trace_id: ctx.traceId }
    }
    if (ok) return { item_key: key, status: 'done', before: before.get(it.pkg_oid), after: target.get(it.pkg_oid), trace_id: ctx.traceId }
    return { item_key: key, status: 'failed', before: before.get(it.pkg_oid), error_code: err?.code, error_message: err?.message, trace_id: ctx.traceId }
  }

  if (Object.keys(configData).length === 0) {
    for (const it of group) results.push(buildResult(it, true))
    return results
  }

  try {
    await ctx.gateway.put(`${path}/reserve-active`, ctx.accessToken, { config_data: configData, modify_user: ctx.modifyUser })
    for (const it of group) results.push(buildResult(it, true))
  } catch (e) {
    const err = e as { code?: string; message?: string }
    for (const it of group) results.push(buildResult(it, false, err))
  }
  return results
}

// Items are independent per prod_oid group — Promise.allSettled so one prod's PUT/read failure
// never aborts a sibling prod group's write (spec §4/§7 per-item failure isolation, same rule as
// execInventoryPlatform).
export async function execShelfSchedule(rec: ChangeSetRecord, ctx: ExecutorContext): Promise<ItemResult[]> {
  const items = rec.items as ShelfScheduleItem[]
  const byProd = new Map<string, ShelfScheduleItem[]>()
  for (const it of items) {
    const g = byProd.get(it.prod_oid) ?? []
    g.push(it)
    byProd.set(it.prod_oid, g)
  }
  const groups = [...byProd.entries()]
  const settled = await Promise.allSettled(groups.map(([prodOid, group]) => execOneProdGroup(ctx, prodOid, group)))
  const results: ItemResult[] = []
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      results.push(...s.value)
      return
    }
    const [, group] = groups[i]
    for (const it of group) {
      results.push({
        item_key: `${it.prod_oid}:${it.pkg_oid}`, status: 'failed',
        error_code: 'EXEC_ERROR', error_message: (s.reason as Error)?.message ?? String(s.reason), trace_id: ctx.traceId,
      })
    }
  })
  return results
}

export async function executeShelfSchedule(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]> {
  return await ctx.span('changeset.execute/shelf_schedule', async (traceId) => {
    return await execShelfSchedule(rec, {
      gateway: ctx.gateway,
      accessToken: ctx.accessToken,
      modifyUser: ctx.modifyUser,
      traceId
    })
  }).catch(e => (rec.items as ShelfScheduleItem[]).map(it => ({
    item_key: `${it.prod_oid}:${it.pkg_oid}`, status: 'failed' as const,
    error_code: 'EXEC_ERROR', error_message: (e as Error).message, trace_id: ctx.traceId,
  })))
}
