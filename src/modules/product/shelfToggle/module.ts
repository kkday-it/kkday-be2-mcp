import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import type { ChangeSetItem, DiffItem } from '../../../core/changeset/types.js'
import { computeShelfDiff } from './diff.js'
import { itemKey } from './keys.js'
import { executeShelfToggle } from './executor.js'
import { renderConfirm } from './renderer.js'
import { shelfToggleProductWizard, shelfTogglePlanWizard } from './ui.js'

// .strict()：product 是 {prod_oid,target_is_active}——plan/bundle item 的純子集。itemShape 是
// z.union(所有 module schema,依註冊序),product 排在 plan/bundle 前;若非 strict,zod 會讓 plan/bundle
// item「命中」product schema 並「剝除」pkg_oid/bundle_pkg_oid,剝完的 item 再過 plan/bundle 的 isItem
// 就 INVALID_ITEMS。strict 讓帶額外鍵的 plan/bundle item 不命中 product、正確落到自己的 schema。
const itemSchemaProduct = z.object({ prod_oid: z.string().min(1), target_is_active: z.boolean() }).strict()
const itemSchemaPlan = z.object({ prod_oid: z.string().min(1), pkg_oid: z.string().min(1), target_is_active: z.boolean() })

function isShelfToggleProductItem(i: unknown): i is ChangeSetItem {
  return typeof (i as ChangeSetItem).prod_oid === 'string' && typeof (i as ChangeSetItem).target_is_active === 'boolean'
}

function isShelfTogglePlanItem(i: unknown): i is ChangeSetItem {
  return typeof (i as ChangeSetItem).prod_oid === 'string' && typeof (i as ChangeSetItem).pkg_oid === 'string' && typeof (i as ChangeSetItem).target_is_active === 'boolean'
}

function singleDirection(items: Array<{ target_is_active: boolean }>) {
  const dirs = new Set(items.map(i => i.target_is_active))
  if (dirs.size > 1) return { key: 'mixed_direction', message: '一批上下架不可同時含上架與下架，請分兩批送出。' }
  return null
}

export const shelfToggleProductModule: ActionModule<ChangeSetItem, DiffItem> = {
  actionType: 'shelf_toggle_product',
  shapeFamily: 'shelf_toggle',
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
  validate: (items) => singleDirection(items as Array<{ target_is_active: boolean }>),
  computeDiff: (ctx: DiffCtx, items: ChangeSetItem[]) => computeShelfDiff('shelf_toggle_product', items, ctx),
  diffVersion: (diff: DiffItem[]) => {
    const canon = diff.map(s => `${s.prod_oid}:${s.pkg_oid ?? ''}=${s.current_is_active ?? 'null'}`).sort().join('|')
    return createHash('sha256').update(canon).digest('hex')
  },
  itemKey,
  execute: executeShelfToggle,
  renderConfirm: (rec, diff, version, banner) => renderConfirm(rec, diff as DiffItem[], version, banner),
  wizard: shelfToggleProductWizard
}

export const shelfTogglePlanModule: ActionModule<ChangeSetItem, DiffItem> = {
  actionType: 'shelf_toggle_plan',
  shapeFamily: 'shelf_toggle',
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
  validate: (items) => singleDirection(items as Array<{ target_is_active: boolean }>),
  computeDiff: (ctx: DiffCtx, items: ChangeSetItem[]) => computeShelfDiff('shelf_toggle_plan', items, ctx),
  diffVersion: (diff: DiffItem[]) => {
    const canon = diff.map(s => `${s.prod_oid}:${s.pkg_oid ?? ''}=${s.current_is_active ?? 'null'}`).sort().join('|')
    return createHash('sha256').update(canon).digest('hex')
  },
  itemKey,
  execute: executeShelfToggle,
  renderConfirm: (rec, diff, version, banner) => renderConfirm(rec, diff as DiffItem[], version, banner),
  wizard: shelfTogglePlanWizard
}
