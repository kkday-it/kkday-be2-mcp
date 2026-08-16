import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import type { InventoryItem, InventoryDiffItem } from '../../../changeset/types.js'
import { computeInventoryDiff } from '../../../changeset/inventoryDiff.js'
import { validateInventoryItems } from '../../../changeset/inventoryValidate.js'
import { itemKey } from './keys.js'

const invItemShape = z.object({
  item_oid: z.string().min(1),
  supplier_oid: z.string().min(1),
  op: z.enum(['set', 'adjust']),
  quantity: z.number(),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(62),  // 62 provisional — Task 1 Q4/Q6
})

function isInventoryItem(i: unknown): i is InventoryItem {
  return typeof (i as InventoryItem).item_oid === 'string' && Array.isArray((i as InventoryItem).dates)
}

export const INVENTORY_ACTION_CODES = ['product.product-inventory.update']

export const inventorySettingModule: ActionModule<InventoryItem, InventoryDiffItem> = {
  actionType: 'inventory_setting',
  itemSchema: invItemShape,
  authz: {
    codes: INVENTORY_ACTION_CODES,
    onMissing: 'block'
  },
  invalidItemsMessage: 'inventory_setting items need {item_oid, supplier_oid, op, quantity, dates}.',
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
    const canon = diff.map(inv => {
      if (inv.op === 'adjust') {
        return `invadj:${inv.item_oid}:${inv.supplier_oid}:${inv.dates.map(x => x.date).sort().join(',')}=${inv.quantity}`
      }
      return inv.dates.map(x => `inv:${inv.item_oid}:${inv.supplier_oid}:${x.date}=${x.current ?? 'null'}`).sort().join('|')
    }).sort().join('|')
    return createHash('sha256').update(canon).digest('hex')
  },
  itemKey,
  execute: () => { throw new Error('not wired until Task 5/6') },
  renderConfirm: () => { throw new Error('not wired until Task 5/6') }
}
