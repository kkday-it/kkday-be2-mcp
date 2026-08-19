import type { ChangeSetRecord, ItemResult } from '../../../core/changeset/types.js'
import type { ExecCtx } from '../../../core/changeset/module.js'
import type { BundleItem } from './types.js'
import { itemKey } from './keys.js'

// READ-ONLY fields on each bundle-package-configs row that the write endpoint rejects — server-set
// (stage 商品 19513 實測 row 有 updated_by/updated_at；比照 shelfToggle plan 的 PLAN_PKG_READONLY)。
const BUNDLE_READONLY = ['updated_by', 'updated_at']

interface BundleExecDeps { gateway: import('../../../gateway/client.js').GatewayClient }

// PUT /products/{prodOid}/bundle-package-configs：read-merge-write。config_data 以 bundle_pkg_oid
// 為 key、保留整列可寫欄位、只 flip 目標的 is_active、剔除 server-set 唯讀欄、帶 modify_user。
// NOTE(PENDING)：PUT body 形狀（config_data keyed by bundle_pkg_oid）比照 package-configs plan 寫法，
// 尚未對 stage 實測真 200——同 shelfToggle 的 SIT 403 先例，live 寫入標 PENDING，讀取/diff 面已驗。
function bundleEntries(raw: unknown): Array<[string, Record<string, unknown>]> {
  // 雙形狀容錯（比照 shelfToggle configEntries）：array 或 {config_data:{...}} 物件皆認。
  const r = raw as Record<string, any>
  const cd = r?.config_data ?? r
  if (Array.isArray(cd)) {
    return (cd as Array<Record<string, unknown>>).filter(x => x?.bundle_pkg_oid != null).map(x => [String(x.bundle_pkg_oid), x])
  }
  if (cd && typeof cd === 'object') return Object.entries(cd) as Array<[string, Record<string, unknown>]>
  return []
}

async function execBundleGroup(deps: BundleExecDeps, at: string, modifyUser: string, prodOid: string, items: BundleItem[], traceId: string): Promise<ItemResult[]> {
  const path = `/product/api/v1/products/${encodeURIComponent(prodOid)}/bundle-package-configs`
  const raw = await deps.gateway.get(path, at)
  const entries = bundleEntries(raw)
  const currentActive = new Map(entries.map(([k, o]) => [k, !!o.is_active]))
  const targets = new Map(items.map(i => [i.bundle_pkg_oid, i.target_is_active]))
  const before = Object.fromEntries(currentActive)
  const allNoop = items.every(i => currentActive.get(i.bundle_pkg_oid) === i.target_is_active)
  if (allNoop) return items.map(i => ({ item_key: `${prodOid}:${i.bundle_pkg_oid}`, status: 'skipped_noop' as const, before, after: before, trace_id: traceId }))
  const config_data: Record<string, Record<string, unknown>> = {}
  for (const [bpk, obj] of entries) {
    const full = { ...obj }
    delete full.bundle_pkg_oid
    for (const k of BUNDLE_READONLY) delete full[k]
    if (targets.has(bpk)) full.is_active = targets.get(bpk)!  // flip ONLY the target; preserve rest
    config_data[bpk] = full
  }
  try {
    await deps.gateway.put(path, at, { config_data, modify_user: modifyUser })
    const after = Object.fromEntries(bundleEntries(await deps.gateway.get(path, at)).map(([k, o]) => [k, !!o.is_active]))
    return items.map(i => ({ item_key: `${prodOid}:${i.bundle_pkg_oid}`, status: 'done' as const, before, after, trace_id: traceId }))
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return items.map(i => ({ item_key: `${prodOid}:${i.bundle_pkg_oid}`, status: 'failed' as const, before, error_code: err.code, error_message: err.message, trace_id: traceId }))
  }
}

export async function executeBundleToggle(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]> {
  const byOid = new Map<string, BundleItem[]>()
  for (const it of rec.items as unknown as BundleItem[]) {
    const g = byOid.get(it.prod_oid) ?? []
    g.push(it)
    byOid.set(it.prod_oid, g)
  }
  const results: ItemResult[] = []
  for (const [oid, items] of byOid.entries()) {
    try {
      const groupResults = await ctx.span(`changeset.execute/${rec.actionType}`, traceId =>
        execBundleGroup({ gateway: ctx.gateway }, ctx.accessToken, ctx.modifyUser, oid, items, traceId))
      results.push(...groupResults)
    } catch (e) {
      results.push(...items.map(it => ({
        item_key: itemKey(it), status: 'failed' as const, error_code: 'EXEC_ERROR',
        error_message: (e as Error).message, trace_id: 'n/a',
      })))
    }
  }
  return results
}
