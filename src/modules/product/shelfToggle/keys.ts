export function itemKey(item: any): string {
  return item.pkg_oid ? `${item.prod_oid}:${item.pkg_oid}` : item.prod_oid
}
