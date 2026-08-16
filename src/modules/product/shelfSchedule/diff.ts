import type { GatewayClient } from '../../../gateway/client.js'
import type { ToolContext } from '../../../tools/types.js'
import { sanitizeQueue } from './validate.js'
import { DiffError } from '../../../core/changeset/diff.js'
import type { ScheduleEntry, ShelfScheduleDiffItem, ShelfScheduleItem } from '../../../core/changeset/types.js'

// Task 4 定案 (docs/superpowers/specs/2026-08-14-be2-mcp-baa-wizard-design.md §4.1/§4.2, probe +
// BAA 警語雙證): GET /product/api/v1/products/{prodOid}/package-configs -> array (GatewayClient.get
// already unwraps the `.data` envelope), each element carrying pkg_oid,name,is_active,is_bundle,
// reserve_date,reserve_status,reserve_queue[]. reserve_queue entries carry server-only fields
// (created_at/created_by) that sanitizeQueue() strips — never diff/hash the raw wire shape.
async function readPackageConfigs(gateway: GatewayClient, accessToken: string, prodOid: string): Promise<Array<Record<string, unknown>>> {
  const raw = await gateway.get(`/product/api/v1/products/${encodeURIComponent(prodOid)}/package-configs`, accessToken)
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

// Sorted ascending by date — same canonical order sanitizeQueue() produces for the live-read
// side, so noop/hash comparisons are insensitive to the ORDER the caller happened to list items
// in (spec §4.2: avoid a false stale/noop mismatch from incidental ordering).
export function sortQueue(q: ScheduleEntry[]): ScheduleEntry[] {
  return [...q].sort((a, b) => (a.reserve_date_utc < b.reserve_date_utc ? -1 : a.reserve_date_utc > b.reserve_date_utc ? 1 : 0))
}

export function queuesEqual(a: ScheduleEntry[], b: ScheduleEntry[]): boolean {
  return a.length === b.length && a.every((x, i) => x.reserve_date_utc === b[i].reserve_date_utc && x.reserve_status === b[i].reserve_status)
}

// Per (prod_oid, pkg_oid) live diff (design doc §4.2). Items are grouped by prod_oid so a
// change-set touching multiple packages of the same product issues one GET, not one per item —
// same batching shape as computeShelfDiff's shelf_toggle_plan branch (diff.ts).
// is_bundle:true packages are rejected outright: the bundle variant of this endpoint
// (`bundle-package-config/{oid}/reserve-active`) is explicitly out of scope for v1 (design doc
// §4.1) — writing bundle packages through this path would hit the wrong/unsupported endpoint.
export async function computeScheduleDiff(items: ShelfScheduleItem[], ctx: ToolContext): Promise<ShelfScheduleDiffItem[]> {
  const byProd = new Map<string, ShelfScheduleItem[]>()
  for (const it of items) {
    const g = byProd.get(it.prod_oid) ?? []
    g.push(it)
    byProd.set(it.prod_oid, g)
  }
  const out: ShelfScheduleDiffItem[] = []
  for (const [prodOid, group] of byProd) {
    const rows = await readPackageConfigs(ctx.gateway, ctx.accessToken, prodOid)
    const byPkg = new Map(rows.map(r => [String(r.pkg_oid), r]))
    for (const it of group) {
      const row = byPkg.get(it.pkg_oid)
      if (!row) {
        throw new DiffError([`${it.prod_oid}:${it.pkg_oid}`], `package ${it.pkg_oid} not found under product ${it.prod_oid}`)
      }
      if (row.is_bundle === true) {
        throw new DiffError([`${it.prod_oid}:${it.pkg_oid}`],
          `pkg_oid=${it.pkg_oid} is_bundle=true — bundle packages are not supported by shelf_schedule (v1)`)
      }
      const currentQueue = sanitizeQueue((row.reserve_queue as Array<{ reserve_date?: unknown; reserve_status?: unknown }>) ?? [])
      const newQueue = sortQueue(it.queue)
      // be2 規則 131105（2026-08-16 彩排 SIT 實測）：reserve_queue 排序後第一筆的 reserve_status
      // 必須與方案當前 is_active 不同（對已上架方案排「上架」= 無意義排程，be2 執行時 422）。
      // 在 diff 就 fail-fast——create 與批准前 live-diff 都走本函式，擋得早也擋得住 stale。
      // row.is_active 非 boolean（容錯路徑）時跳過檢查；清空排程（queue=[]）不受影響。
      if (newQueue.length > 0 && typeof row.is_active === 'boolean' && newQueue[0].reserve_status === row.is_active) {
        throw new DiffError([`${it.prod_oid}:${it.pkg_oid}`],
          `pkg_oid=${it.pkg_oid} 第一筆排程狀態（${newQueue[0].reserve_status ? '上架' : '下架'}）與方案現況相同，be2 會拒絕（131105）——請改排相反狀態或先確認現況`)
      }
      out.push({
        prod_oid: it.prod_oid,
        pkg_oid: it.pkg_oid,
        pkg_name: String(row.name ?? ''),
        current_queue: currentQueue,
        new_queue: newQueue,
        noop: queuesEqual(currentQueue, newQueue),
      })
    }
  }
  return out
}
