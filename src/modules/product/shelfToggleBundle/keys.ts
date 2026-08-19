// itemKey 單一事實來源（server 與潛在 UI 共用）。bundle 的 key 欄位是 bundle_pkg_oid
// （★ 非 package-configs 的 pkg_oid——stage 商品 19513 實測；盲寫用 pkg_oid 會錯）。
// item 與 diff item 都帶 prod_oid + bundle_pkg_oid，故同一函式對兩者皆適用。
export function itemKey(item: any): string {
  return `${item.prod_oid}:${item.bundle_pkg_oid}`
}
