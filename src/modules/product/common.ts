// 跨 action 共用的 be2 wire-shape helper（Phase 5 Task 7 自 src/tools/batchView.ts 抽出）——
// inventoryPlatform/diff.ts（affected_pkgs 伺服器端重算）與 batchView（精靈檢視組裝）共用同一份
// packages?show_supplier=1 解析，避免兩份手抄 parser 靜默漂移。
// docs/be2-mcp/sit-write-contracts.md Phase 4a Task 1 §"packages?show_supplier=1 完整欄位形狀":
// supplier info lives under `supplier_mapping[]` (NOT `supplier`/`suppliers`); the response may
// be missing `is_bundle` entirely (defensive: absent -> treated as "unknown", not "false" — the
// authoritative is_bundle source is package-configs below, merged in by pkg_oid).
// Exported (final whole-branch review Important 3): src/changeset/platformDiff.ts reuses this
// exact parser to recompute affected_pkgs server-side — same wire-shape knowledge (supplier info
// under supplier_mapping[], is_bundle possibly absent), one implementation instead of a
// hand-copied second parser that could silently drift from this one.
export function extractPackagesWithSupplier(raw: unknown): Array<{
  pkg_oid: string; name?: string; item_oid?: string; is_active?: boolean; supplier_oid?: string; supplier_name?: string
}> {
  const list = Array.isArray(raw) ? raw : (raw as Record<string, any>)?.data ?? (raw as Record<string, any>)?.packages ?? []
  return (list as any[]).filter(p => p?.pkg_oid != null).map(p => {
    const mapping = Array.isArray(p.supplier_mapping) ? (p.supplier_mapping as any[]) : []
    const dflt = mapping.find(m => m?.is_default === true) ?? mapping[0]
    return {
      pkg_oid: String(p.pkg_oid),
      name: typeof p.pkg_name === 'string' ? p.pkg_name : (typeof p.name === 'string' ? p.name : undefined),
      item_oid: p.item_oid != null ? String(p.item_oid) : undefined,
      is_active: typeof p.is_active === 'boolean' ? p.is_active : undefined,
      supplier_oid: dflt?.supplier_oid != null ? String(dflt.supplier_oid) : undefined,
      supplier_name: typeof dflt?.supplier_name === 'string' ? dflt.supplier_name : undefined,
    }
  })
}
