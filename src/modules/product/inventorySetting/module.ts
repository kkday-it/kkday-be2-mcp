import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import type { InventoryItem, InventoryDiffItem } from '../../../core/changeset/types.js'
import { computeInventoryDiff } from './diff.js'
import { validateInventoryItems } from './validate.js'
import { itemKey } from './keys.js'
import { executeInventorySetting } from './executor.js'
import { renderConfirm } from './renderer.js'

const invItemShape = z.object({
  item_oid: z.string().min(1),
  supplier_oid: z.string().min(1),
  quantity: z.number(),
})

function isInventoryItem(i: unknown): i is InventoryItem {
  return typeof (i as InventoryItem).item_oid === 'string' && typeof (i as InventoryItem).quantity === 'number'
}

export const INVENTORY_ACTION_CODES = ['product.product-inventory.update']

export const inventorySettingModule: ActionModule<InventoryItem, InventoryDiffItem> = {
  actionType: 'inventory_setting',
  schedulable: true,
  itemSchema: invItemShape,
  authz: {
    codes: INVENTORY_ACTION_CODES,
    onMissing: 'block'
  },
  invalidItemsMessage: 'inventory_setting items need {item_oid, supplier_oid, quantity} (fullday SET).',
  scopeNotReadMessage: 'These item_oids were not looked up in this session; query them first (be2_get_inventory_settings / be2_get_product_plans) before staging a change.',
  isItem: isInventoryItem,
  scopeOids: (item: InventoryItem) => [item.item_oid],
  scopeErrorKey: (item: InventoryItem) => item.item_oid,
  validate: (items: InventoryItem[], nowMs: number) => {
    const bad = validateInventoryItems(items, nowMs)
    return bad || null
  },
  computeDiff: (ctx: DiffCtx, items: InventoryItem[]) => computeInventoryDiff(items, ctx),
  diffVersion: (diff: InventoryDiffItem[]) => {
    const canon = diff.map(inv => `inv:${inv.item_oid}:${inv.supplier_oid}=${inv.current ?? 'null'}->${inv.target}`).sort().join('|')
    return createHash('sha256').update(canon).digest('hex')
  },
  itemKey,
  execute: executeInventorySetting,
  renderConfirm
}
