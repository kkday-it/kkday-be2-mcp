export function itemKey(item: any): string {
  return `${item.prod_oid}:${item.pkg_oid}`
}
