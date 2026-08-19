import type { DiffCtx } from '../../../core/changeset/module.js'
import { DiffError } from '../../../core/changeset/diff.js'
import type { BundleItem, BundleDiffItem } from './types.js'

// GET /products/{prodOid}/bundle-package-configs → array（GatewayClient.get 已解 .data envelope）。
// 每列 { bundle_pkg_oid, name, is_active, reserve_date, reserve_status, reserve_queue,
// updated_by, updated_at }（stage 商品 19513 實測）。無現成 bundle 讀取工具，直打 gateway。
// 依 prod_oid 分組單 GET（同 shelfToggle plan 的分組讀）；current is_active 解不出即 throw
// DiffError（不 silently stage current_is_active:undefined）。
// 雙形狀容錯（比照 shelfToggle configEntries）：GET 回 array，但若回 {config_data:{...}}
// 物件形狀也認得，避免靜默退化成空 entries。
function extractRows(raw: unknown): Array<Record<string, unknown>> {
  const r = raw as Record<string, any>
  const cd = r?.config_data ?? r
  if (Array.isArray(cd)) return cd as Array<Record<string, unknown>>
  if (cd && typeof cd === 'object') {
    return Object.entries(cd).map(([k, v]) => ({ bundle_pkg_oid: k, ...(v as Record<string, unknown>) }))
  }
  return []
}

export async function computeBundleDiff(items: BundleItem[], ctx: DiffCtx): Promise<BundleDiffItem[]> {
  const out: BundleDiffItem[] = []
  for (const prodOid of [...new Set(items.map(i => i.prod_oid))]) {
    let raw: unknown
    try {
      raw = await ctx.gateway.get(`/product/api/v1/products/${encodeURIComponent(prodOid)}/bundle-package-configs`, ctx.accessToken)
    } catch (e) {
      const err = e as { code?: string; message?: string }
      throw new DiffError([prodOid], `could not read bundle-package-configs for ${prodOid}: ${err.code ?? err.message ?? 'err'}`)
    }
    const byBundle = new Map(extractRows(raw).map(r => [String(r.bundle_pkg_oid), r]))
    for (const i of items.filter(x => x.prod_oid === prodOid)) {
      const cur = byBundle.get(i.bundle_pkg_oid)
      if (!cur || typeof cur.is_active !== 'boolean') {
        throw new DiffError([`${prodOid}:${i.bundle_pkg_oid}`], `bundle ${i.bundle_pkg_oid} not found (or no is_active) under product ${prodOid}`)
      }
      const current = cur.is_active as boolean
      out.push({
        prod_oid: prodOid, bundle_pkg_oid: i.bundle_pkg_oid,
        name: typeof cur.name === 'string' ? cur.name : undefined,
        current_is_active: current, target_is_active: i.target_is_active,
        no_op: current === i.target_is_active,
      })
    }
  }
  return out
}
