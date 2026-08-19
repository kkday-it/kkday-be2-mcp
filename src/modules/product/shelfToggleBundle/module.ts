import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import { computeBundleDiff } from './diff.js'
import { itemKey } from './keys.js'
import { executeBundleToggle } from './executor.js'
import { renderConfirm } from './renderer.js'
import type { BundleItem, BundleDiffItem } from './types.js'

const itemSchema = z.object({
  prod_oid: z.string().min(1),
  bundle_pkg_oid: z.string().min(1),
  target_is_active: z.boolean(),
})

function isBundleItem(i: unknown): i is BundleItem {
  return typeof (i as BundleItem).prod_oid === 'string'
    && typeof (i as BundleItem).bundle_pkg_oid === 'string'
    && typeof (i as BundleItem).target_is_active === 'boolean'
}

export const shelfToggleBundleModule: ActionModule<BundleItem, BundleDiffItem> = {
  actionType: 'shelf_toggle_bundle',
  itemSchema,
  authz: {
    // bundle 上下架的 businessList 授權碼（沿用 shelf_toggle_plan 的 bundle-package 類碼）。
    // 契約報告 §6 只驗了 bundle 的「讀取」row 形狀，寫入 action code 對 bundle 尚 PENDING 未
    // 獨立驗證——故用 warn（ACTION_CODE_UNVERIFIED）降級，與同 factory 世代 inventory_platform/
    // shelf_schedule 一致，把權威授權判斷交給 gateway /verify（fail-closed），不誤擋有 bundle
    // 權限但無此確切 code 的使用者。
    codes: ['product.bundle-package-sale-status.update'],
    onMissing: 'warn',
  },
  invalidItemsMessage: 'shelf_toggle_bundle items need {prod_oid, bundle_pkg_oid, target_is_active}.',
  scopeNotReadMessage: 'These oids were not looked up in this session; query them first before staging a bundle change.',
  isItem: isBundleItem,
  scopeOids: (item: BundleItem) => [item.prod_oid, item.bundle_pkg_oid],
  scopeErrorKey: (item: BundleItem) => item.bundle_pkg_oid,
  validate: () => null,
  computeDiff: (ctx: DiffCtx, items: BundleItem[]) => computeBundleDiff(items, ctx),
  diffVersion: (diff: BundleDiffItem[]) => {
    const canon = diff.map(d => `${d.prod_oid}:${d.bundle_pkg_oid}=${d.current_is_active ?? 'null'}`).sort().join('|')
    return createHash('sha256').update(canon).digest('hex')
  },
  itemKey,
  execute: executeBundleToggle,
  renderConfirm: (rec, diff, version, banner) => renderConfirm(rec, diff as BundleDiffItem[], version, banner),
}
