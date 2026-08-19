// shelf_toggle_bundle 的 item/diff 形狀（stage 商品 19513 契約實測）。
// 與 shelfToggle 的差別：key 欄位是 bundle_pkg_oid（非 pkg_oid）。core 對 item/diff opaque，
// 故這兩型只在本 module 內用，不進 core 的 AnyChangeSetItem/AnyDiffItem union。
export interface BundleItem {
  prod_oid: string
  bundle_pkg_oid: string
  target_is_active: boolean
}

export interface BundleDiffItem {
  prod_oid: string
  bundle_pkg_oid: string
  name?: string
  current_is_active?: boolean
  target_is_active: boolean
  no_op: boolean
}
