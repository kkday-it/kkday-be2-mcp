import type { InventoryPlatform, InventoryPlatformItem } from '../../../core/changeset/types.js'

// Enum <-> boolean-pair mapping (be2-web `enums/product/InventoryDataSource.js`; verified live
// against SIT be2-220, docs/be2-mcp/sit-write-contracts.md §Task 1 "inventory-platform read").
// Tens digit = is_external_inventory, ones digit = is_inventory_mgmt:
//   BE2      = 00 -> {false, false}
//   BE2_SCM  = 01 -> {false, true}
//   EXTERNAL = 10 -> {true,  false}
// The 4th combo (11, external+mgmt both true) is not a defined platform state.
export function platformToBooleans(t: InventoryPlatform): { is_external_inventory: boolean; is_inventory_mgmt: boolean } {
  switch (t) {
    case 'BE2': return { is_external_inventory: false, is_inventory_mgmt: false }
    case 'BE2_SCM': return { is_external_inventory: false, is_inventory_mgmt: true }
    case 'EXTERNAL': return { is_external_inventory: true, is_inventory_mgmt: false }
    default: {
      // Exhaustive guard (Task 2 review #2): zod's target enum makes this unreachable from
      // tool input, but a raw value from a direct internal caller must fail loudly here
      // instead of letting `undefined` booleans flow downstream into a gateway PUT.
      const impossible: never = t
      throw new Error(`unknown InventoryPlatform: ${String(impossible)}`)
    }
  }
}

export function booleansToPlatform(b: { is_external_inventory: boolean; is_inventory_mgmt: boolean }): InventoryPlatform | undefined {
  if (!b.is_external_inventory && !b.is_inventory_mgmt) return 'BE2'
  if (!b.is_external_inventory && b.is_inventory_mgmt) return 'BE2_SCM'
  if (b.is_external_inventory && !b.is_inventory_mgmt) return 'EXTERNAL'
  return undefined // external+mgmt=true (11) — undefined combination, never produced by platformToBooleans
}

// Semantic rules zod can't express per-field (spec §4.1): the change-set's real write unit is
// (item_oid, supplier_oid) — a package's prod_oid/pkg_oid is only a display annotation
// (affected_pkgs). Two items targeting the same (item, supplier) with different platforms
// would race at execution time, so it's rejected at creation with both conflicting pkg_names
// named in the message (so the operator can see which package selections collided).
export function validateInventoryPlatformItems(items: InventoryPlatformItem[]): string | null {
  const seen = new Map<string, InventoryPlatformItem>()
  for (const it of items) {
    if (!it.affected_pkgs || it.affected_pkgs.length === 0) {
      return `item_oid=${it.item_oid} supplier_oid=${it.supplier_oid}: affected_pkgs must not be empty`
    }
    const key = `${it.item_oid}:${it.supplier_oid}`
    const prev = seen.get(key)
    if (prev) {
      const prevNames = prev.affected_pkgs.map(p => p.pkg_name).join(', ')
      const curNames = it.affected_pkgs.map(p => p.pkg_name).join(', ')
      return `duplicate (item_oid, supplier_oid) ${key}: conflicting packages "${prevNames}" vs "${curNames}"`
    }
    seen.set(key, it)
  }
  return null
}

