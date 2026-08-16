import { z } from 'zod'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import type { ChangeSetItem } from '../../../changeset/types.js'
import { computeChangesetDiff, diffVersionHash } from '../../../changeset/diff.js'
import { itemKey } from './keys.js'

const itemSchemaProduct = z.object({ prod_oid: z.string().min(1), target_is_active: z.boolean() })
const itemSchemaPlan = z.object({ prod_oid: z.string().min(1), pkg_oid: z.string().min(1), target_is_active: z.boolean() })

function isShelfToggleProductItem(i: unknown): i is ChangeSetItem {
  return typeof (i as ChangeSetItem).prod_oid === 'string' && typeof (i as ChangeSetItem).target_is_active === 'boolean'
}

function isShelfTogglePlanItem(i: unknown): i is ChangeSetItem {
  return typeof (i as ChangeSetItem).prod_oid === 'string' && typeof (i as ChangeSetItem).pkg_oid === 'string' && typeof (i as ChangeSetItem).target_is_active === 'boolean'
}

export const shelfToggleProductModule: ActionModule<ChangeSetItem, unknown> = {
  actionType: 'shelf_toggle_product',
  itemSchema: itemSchemaProduct,
  authz: {
    // action_type -> businessList action code(s). businessList is 666 dot-notation strings
    // (e.g. "product.product-sale-status.update"), verified live against SIT be2-220.
    codes: ['product.product-sale-status.update'],
    onMissing: 'block'
  },
  invalidItemsMessage: 'shelf action_types take {prod_oid, (pkg_oid), target_is_active} items.',
  scopeNotReadMessage: 'These oids were not looked up in this session; query them first (be2_find_products / be2_get_product_plans) before staging a change.',
  isItem: isShelfToggleProductItem,
  scopeOids: (item: ChangeSetItem) => [item.prod_oid, ...(item.pkg_oid ? [item.pkg_oid] : [])],
  scopeErrorKey: (item: ChangeSetItem) => item.pkg_oid ?? item.prod_oid,
  validate: () => null,
  computeDiff: (ctx: DiffCtx, items: ChangeSetItem[]) => computeChangesetDiff('shelf_toggle_product', items, ctx),
  diffVersion: diffVersionHash,
  itemKey,
  execute: () => { throw new Error('not wired until Task 5/6') },
  renderConfirm: () => { throw new Error('not wired until Task 5/6') }
}

export const shelfTogglePlanModule: ActionModule<ChangeSetItem, unknown> = {
  actionType: 'shelf_toggle_plan',
  itemSchema: itemSchemaPlan,
  authz: {
    codes: ['product.product-sale-status.update', 'product.bundle-package-sale-status.update'],
    onMissing: 'block'
  },
  invalidItemsMessage: 'shelf action_types take {prod_oid, (pkg_oid), target_is_active} items.',
  scopeNotReadMessage: 'These oids were not looked up in this session; query them first (be2_find_products / be2_get_product_plans) before staging a change.',
  isItem: isShelfTogglePlanItem,
  scopeOids: (item: ChangeSetItem) => [item.prod_oid, ...(item.pkg_oid ? [item.pkg_oid] : [])],
  scopeErrorKey: (item: ChangeSetItem) => item.pkg_oid ?? item.prod_oid,
  validate: () => null,
  computeDiff: (ctx: DiffCtx, items: ChangeSetItem[]) => computeChangesetDiff('shelf_toggle_plan', items, ctx),
  diffVersion: diffVersionHash,
  itemKey,
  execute: () => { throw new Error('not wired until Task 5/6') },
  renderConfirm: () => { throw new Error('not wired until Task 5/6') }
}
