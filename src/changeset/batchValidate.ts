import type { InventoryPlatform, InventoryPlatformItem, ScheduleEntry, ShelfScheduleItem } from './types.js'

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

// "YYYY-MM-DD HH:mm:ss" (spec §4.2). Parsed as UTC via Date.parse(s.replace(' ','T')+'Z').
const RESERVE_DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function parseReserveDateUtcMs(s: string): number {
  return Date.parse(s.replace(' ', 'T') + 'Z')
}

// Semantic rules zod can't express per-field (spec §4.2): reserve_date_utc must be in the
// future at creation time (be2's native scheduler would otherwise fire immediately/never);
// same pkg_oid can't appear twice in one change-set (ambiguous which queue wins); an empty
// queue is legal — it means "clear this package's schedule".
export function validateShelfScheduleItems(items: ShelfScheduleItem[], now: () => number): string | null {
  const nowMs = now()
  const seenPkg = new Set<string>()
  for (const it of items) {
    if (seenPkg.has(it.pkg_oid)) return `duplicate pkg_oid in change-set: ${it.pkg_oid}`
    seenPkg.add(it.pkg_oid)
    for (const s of it.queue) {
      if (!RESERVE_DATE_RE.test(s.reserve_date_utc)) {
        return `pkg_oid=${it.pkg_oid}: reserve_date_utc "${s.reserve_date_utc}" must match "YYYY-MM-DD HH:mm:ss"`
      }
      const ms = parseReserveDateUtcMs(s.reserve_date_utc)
      if (Number.isNaN(ms) || ms <= nowMs) {
        return `pkg_oid=${it.pkg_oid}: reserve_date_utc "${s.reserve_date_utc}" must be in the future`
      }
    }
  }
  return null
}

// Purifies a raw reserve_queue entry (as read live from GET package-configs, which also
// carries server-only fields like created_at/created_by) down to the two fields that matter
// for diffing/hashing (spec §4.2), and renames the wire field reserve_date -> reserve_date_utc
// to match our ScheduleEntry shape. Sorted ascending by date so diff_version hashing and
// no_op comparison are insensitive to upstream ordering.
export function sanitizeQueue(q: Array<{ reserve_date?: unknown; reserve_status?: unknown }>): ScheduleEntry[] {
  return q
    .filter((e): e is { reserve_date: string; reserve_status: boolean } =>
      typeof e.reserve_date === 'string' && typeof e.reserve_status === 'boolean')
    .map(e => ({ reserve_date_utc: e.reserve_date, reserve_status: e.reserve_status }))
    .sort((a, b) => a.reserve_date_utc < b.reserve_date_utc ? -1 : a.reserve_date_utc > b.reserve_date_utc ? 1 : 0)
}
