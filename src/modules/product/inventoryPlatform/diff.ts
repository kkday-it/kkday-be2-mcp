import type { GatewayClient } from '../../../gateway/client.js'
import type { ToolContext } from '../../../tools/types.js'
import { booleansToPlatform } from './validate.js'
import { DiffError } from '../shelfToggle/diff.js'
import { extractPackagesWithSupplier } from '../common.js'
import type { InventoryPlatformDiffItem, InventoryPlatformItem } from '../../../core/changeset/types.js'

type AffectedPkg = { prod_oid: string; pkg_oid: string; pkg_name: string }

// Final whole-branch review Important 3: affected_pkgs on InventoryPlatformItem is entirely
// self-reported by whoever created the change-set (the wizard panel / a tool caller) — a
// low-balled list would let an approver believe the blast radius is smaller than it really is.
// This recomputes a canonical list by re-reading each prod_oid the creator CLAIMED (a full
// reverse item_oid -> all-products lookup is out of scope) and keeping every package that
// actually references this item_oid/supplier_oid pair right now — this is what catches
// under-reporting within a claimed product. Union'd with the self-report (never a bare replace)
// so a live-read quirk (e.g. a non-default supplier_mapping entry extractPackagesWithSupplier
// doesn't pick) can only ADD annotations, never silently drop a self-reported one.
// A read failure, or nothing self-reported to scope the lookup to, degrades to the self-reported
// list verbatim, flagged unverified — never blocks the diff itself (this is a display annotation,
// not part of the diff key/hash).
async function recomputeAffectedPkgs(
  gateway: GatewayClient, accessToken: string, itemOid: string, supplierOid: string, reported: AffectedPkg[],
): Promise<{ affectedPkgs: AffectedPkg[]; unverified: boolean }> {
  const prodOids = [...new Set(reported.map(p => p.prod_oid))]
  if (prodOids.length === 0) return { affectedPkgs: reported, unverified: true }
  const merged = new Map<string, AffectedPkg>(reported.map(p => [p.pkg_oid, p]))
  try {
    for (const prodOid of prodOids) {
      const raw = await gateway.get(`/product/api/v1/products/${encodeURIComponent(prodOid)}/packages`, accessToken, { show_supplier: '1' })
      for (const p of extractPackagesWithSupplier(raw)) {
        if (p.item_oid === itemOid && p.supplier_oid === supplierOid) {
          merged.set(p.pkg_oid, { prod_oid: prodOid, pkg_oid: p.pkg_oid, pkg_name: p.name ?? p.pkg_oid })
        }
      }
    }
    return { affectedPkgs: [...merged.values()], unverified: false }
  } catch {
    return { affectedPkgs: reported, unverified: true }
  }
}

import { readSupplierInventorySetting } from './platformRead.js'
export { readSupplierInventorySetting }

// Per (item_oid, supplier_oid) live diff (design doc §4.1). One GET per item (item-level
// aggregate endpoint) — never calls the packages endpoint. affected_pkgs is carried through
// verbatim as a display annotation only (spec: the real write unit is item×supplier, not the
// packages that happen to reference it).
export async function computePlatformDiff(items: InventoryPlatformItem[], ctx: ToolContext): Promise<InventoryPlatformDiffItem[]> {
  const out: InventoryPlatformDiffItem[] = []
  for (const it of items) {
    const booleans = await readSupplierInventorySetting(ctx.gateway, ctx.accessToken, it.item_oid, it.supplier_oid)
    const current = booleansToPlatform(booleans)
    if (current === undefined) {
      throw new DiffError([`${it.item_oid}:${it.supplier_oid}`],
        `undefined inventory-platform combination (is_external_inventory+is_inventory_mgmt both true) for ${it.item_oid}:${it.supplier_oid}`)
    }
    const { affectedPkgs, unverified } = await recomputeAffectedPkgs(ctx.gateway, ctx.accessToken, it.item_oid, it.supplier_oid, it.affected_pkgs)
    out.push({ item_oid: it.item_oid, supplier_oid: it.supplier_oid, current, target: it.target,
      noop: current === it.target, affected_pkgs: affectedPkgs, ...(unverified ? { affected_pkgs_unverified: true as const } : {}) })
  }
  return out
}
