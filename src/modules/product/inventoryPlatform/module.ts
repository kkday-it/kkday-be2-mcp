import { z } from 'zod'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import type { InventoryPlatformItem } from '../../../changeset/types.js'
import { computeChangesetDiff, diffVersionHash } from '../../../changeset/diff.js'
import { validateInventoryPlatformItems } from '../../../changeset/batchValidate.js'
import { itemKey } from './keys.js'

// Strict shapes for the two Phase 4a item kinds (Task 2 review #1: a loose z.record in the
// union would swallow malformed SHELF items that previously failed zod, silently weakening
// existing validation). Field existence + types live here; cross-item semantic rules
// (duplicates, future-time) stay in batchValidate.ts — same split as invItemShape above vs
// inventoryValidate.ts.
const invPlatformItemShape = z.object({
  item_oid: z.string().min(1),
  supplier_oid: z.string().min(1),
  target: z.enum(['BE2', 'BE2_SCM', 'EXTERNAL']),
  affected_pkgs: z.array(z.object({ prod_oid: z.string().min(1), pkg_oid: z.string().min(1), pkg_name: z.string() })),
})

function isInventoryPlatformItem(i: unknown): i is InventoryPlatformItem {
  return typeof (i as InventoryPlatformItem).item_oid === 'string' &&
    typeof (i as InventoryPlatformItem).supplier_oid === 'string' &&
    typeof (i as InventoryPlatformItem).target === 'string' &&
    Array.isArray((i as InventoryPlatformItem).affected_pkgs)
}

export const inventoryPlatformModule: ActionModule<InventoryPlatformItem, unknown> = {
  actionType: 'inventory_platform',
  itemSchema: invPlatformItemShape,
  authz: {
    // Confirmed live against SIT be2-220 (docs/superpowers/specs/2026-08-14-be2-mcp-baa-wizard-design.md §4.3) —
    // same action code as inventory_setting (both are product-inventory writes).
    codes: ['product.product-inventory.update'],
    onMissing: 'warn'
  },
  invalidItemsMessage: 'inventory_platform items need {item_oid, supplier_oid, target, affected_pkgs}.',
  scopeNotReadMessage: 'These item_oids were not looked up in this session; query them first (be2_get_product_plans) before staging a change.',
  isItem: isInventoryPlatformItem,
  scopeOids: (item: InventoryPlatformItem) => [item.item_oid],
  scopeErrorKey: (item: InventoryPlatformItem) => item.item_oid,
  validate: (items: InventoryPlatformItem[], nowMs: number) => {
    const bad = validateInventoryPlatformItems(items)
    return bad ? { key: 'inventory_platform', message: bad } : null
  },
  computeDiff: (ctx: DiffCtx, items: InventoryPlatformItem[]) => computeChangesetDiff('inventory_platform', items, ctx),
  diffVersion: diffVersionHash,
  itemKey,
  execute: () => { throw new Error('not wired until Task 5/6') },
  renderConfirm: () => { throw new Error('not wired until Task 5/6') }
}
