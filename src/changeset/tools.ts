import { z } from 'zod'
import type { L2ToolContext, L2ToolDef } from '../server/l2Context.js'
import { computeChangesetDiff, diffVersionHash } from './diff.js'
import { validateInventoryItems } from './inventoryValidate.js'
import { validateInventoryPlatformItems, validateShelfScheduleItems } from './batchValidate.js'
import { makeEnvelope, toEnvelopeError } from '../tools/envelope.js'
import type { ActionType, AnyChangeSetItem, ChangeSetItem, InventoryItem, InventoryPlatformItem, ShelfScheduleItem } from './types.js'

// FINALIZE(Task 1): confirmed live against SIT be2-220 (docs/be2-mcp/sit-write-contracts.md
// "inventory" section, Task 1 probe) — this is the real businessList action code, not a
// placeholder. Exported so tests seed the same constant instead of hardcoding a literal that
// would silently diverge if the confirmed code ever changes.
export const INVENTORY_ACTION_CODES = ['product.product-inventory.update']

// action_type -> businessList action code(s). businessList is 666 dot-notation strings
// (e.g. "product.product-sale-status.update"), verified live against SIT be2-220.
const ACTION_CODES: Record<ActionType, string[]> = {
  shelf_toggle_product: ['product.product-sale-status.update'],
  shelf_toggle_plan: ['product.product-sale-status.update', 'product.bundle-package-sale-status.update'],
  inventory_setting: INVENTORY_ACTION_CODES,
  // Confirmed live against SIT be2-220 (docs/superpowers/specs/2026-08-14-be2-mcp-baa-wizard-design.md §4.3) —
  // same action code as inventory_setting (both are product-inventory writes).
  inventory_platform: INVENTORY_ACTION_CODES,
  // §4.3: no dedicated action code confirmed yet for the native-reserve endpoint — reuses the
  // shelf_toggle_plan package-config codes verbatim (spec: "沿用 Phase 2a shelf_toggle 實查的
  // package-config 類 code"). If this later proves not to be the verify-side gate, spec §4.3
  // calls for degrading this check to an audit warning instead of a hard block — not yet wired
  // here; that's an executor-level concern for a later task.
  shelf_schedule: ['product.product-sale-status.update', 'product.bundle-package-sale-status.update'],
}

export function businessListAllowsAction(businessList: unknown[], actionType: ActionType): boolean {
  const codes = new Set(
    (businessList ?? []).map(b => typeof b === 'string' ? b : (b as { action?: string; code?: string })?.action ?? (b as { code?: string })?.code).filter(Boolean) as string[])
  return ACTION_CODES[actionType].some(c => codes.has(c))
}

const invItemShape = z.object({
  item_oid: z.string().min(1),
  supplier_oid: z.string().min(1),
  op: z.enum(['set', 'adjust']),
  quantity: z.number(),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(62),  // 62 provisional — Task 1 Q4/Q6
})
// inventory_platform / shelf_schedule items are validated structurally + semantically in
// batchValidate.ts (not per-field zod), so their zod shape is deliberately loose here — a
// generic record — same pattern as inventory_setting used a strict shape for zod plus a
// separate semantic validator (inventoryValidate.ts); the detail just moved further downstream.
const looseItemShape = z.record(z.string(), z.unknown())
const itemShape = z.union([
  z.object({ prod_oid: z.string().min(1), target_is_active: z.boolean() }),
  z.object({ prod_oid: z.string().min(1), pkg_oid: z.string().min(1), target_is_active: z.boolean() }),
  invItemShape,
  looseItemShape,
])
const inputShape = {
  action_type: z.enum(['shelf_toggle_product', 'shelf_toggle_plan', 'inventory_setting', 'inventory_platform', 'shelf_schedule']),
  items: z.array(itemShape).min(1).max(20),
  note: z.string().max(500).optional(),
}

const isInventoryItem = (i: unknown): i is InventoryItem =>
  typeof (i as InventoryItem).item_oid === 'string' && Array.isArray((i as InventoryItem).dates)

const isInventoryPlatformItem = (i: unknown): i is InventoryPlatformItem =>
  typeof (i as InventoryPlatformItem).item_oid === 'string' &&
  typeof (i as InventoryPlatformItem).supplier_oid === 'string' &&
  typeof (i as InventoryPlatformItem).target === 'string' &&
  Array.isArray((i as InventoryPlatformItem).affected_pkgs)

const isShelfScheduleItem = (i: unknown): i is ShelfScheduleItem =>
  typeof (i as ShelfScheduleItem).prod_oid === 'string' &&
  typeof (i as ShelfScheduleItem).pkg_oid === 'string' &&
  Array.isArray((i as ShelfScheduleItem).queue)

export const createChangesetTool: L2ToolDef = {
  name: 'be2_create_changeset',
  description:
    'Stage a DRAFT shelf-on/off change for products (shelf_toggle_product) or plans (shelf_toggle_plan) — max 20 items. ' +
    'Returns { changeset_id, status, diff } — a preview only; it does NOT apply anything and returns NO confirm link. ' +
    'A human operator must open the confirm page for this change-set in a browser and log in via be2-auth SSO to review ' +
    'and approve or reject it there; only then does the write execute. You CANNOT approve or execute this change-set ' +
    'yourself — report the changeset_id and the diff to the user and tell them to open the confirm page to decide. ' +
    'Only pass oids you already looked up this session. ' +
    'inventory_setting stages per-date inventory quantity changes ({item_oid, supplier_oid, op: set|adjust, quantity, dates}); ' +
    'read the item inventory first — adjust is computed against live quantities at approval time.',
  inputShape,
  uiResourceUri: 'ui://be2/changeset-panel.html',
  async handler(args, ctx: L2ToolContext) {
    const items = args.items as AnyChangeSetItem[]
    const actionType = args.action_type as ActionType
    if (actionType === 'inventory_setting') {
      if (!items.every(isInventoryItem)) {
        return makeEnvelope([], [{ key: actionType, code: 'INVALID_ITEMS', message: 'inventory_setting items need {item_oid, supplier_oid, op, quantity, dates}.' }])
      }
      const inv = items as InventoryItem[]
      const bad = validateInventoryItems(inv, ctx.now())
      if (bad) return makeEnvelope([], [{ key: bad.key, code: 'INVALID_ITEMS', message: bad.message }])
      // §6.2 scope-binding gate
      const notRead = inv.filter(i => !ctx.readOids.has(ctx.sessionId, i.item_oid))
      if (notRead.length) {
        return makeEnvelope([], [{
          key: notRead.map(i => i.item_oid).join(','),
          code: 'SCOPE_NOT_READ',
          message: 'These item_oids were not looked up in this session; query them first (be2_get_inventory_settings / be2_get_product_plans) before staging a change.',
        }])
      }
    } else if (actionType === 'inventory_platform') {
      if (!items.every(isInventoryPlatformItem)) {
        return makeEnvelope([], [{ key: actionType, code: 'INVALID_ITEMS', message: 'inventory_platform items need {item_oid, supplier_oid, target, affected_pkgs}.' }])
      }
      const plat = items as InventoryPlatformItem[]
      const bad = validateInventoryPlatformItems(plat)
      if (bad) return makeEnvelope([], [{ key: actionType, code: 'INVALID_ITEMS', message: bad }])
      // §6.2 scope-binding gate — write unit is (item_oid, supplier_oid); item_oid is what was read.
      const notRead = plat.filter(i => !ctx.readOids.has(ctx.sessionId, i.item_oid))
      if (notRead.length) {
        return makeEnvelope([], [{
          key: notRead.map(i => i.item_oid).join(','),
          code: 'SCOPE_NOT_READ',
          message: 'These item_oids were not looked up in this session; query them first (be2_get_product_plans) before staging a change.',
        }])
      }
    } else if (actionType === 'shelf_schedule') {
      if (!items.every(isShelfScheduleItem)) {
        return makeEnvelope([], [{ key: actionType, code: 'INVALID_ITEMS', message: 'shelf_schedule items need {prod_oid, pkg_oid, queue}.' }])
      }
      const sched = items as ShelfScheduleItem[]
      const bad = validateShelfScheduleItems(sched, ctx.now)
      if (bad) return makeEnvelope([], [{ key: actionType, code: 'INVALID_ITEMS', message: bad }])
      // §6.2 scope-binding gate
      const notRead = sched.filter(i => !ctx.readOids.has(ctx.sessionId, i.prod_oid) || !ctx.readOids.has(ctx.sessionId, i.pkg_oid))
      if (notRead.length) {
        return makeEnvelope([], [{
          key: notRead.map(i => i.pkg_oid).join(','),
          code: 'SCOPE_NOT_READ',
          message: 'These oids were not looked up in this session; query them first (be2_get_product_plans) before staging a change.',
        }])
      }
    } else {
      if (items.some(isInventoryItem)) {
        return makeEnvelope([], [{ key: actionType, code: 'INVALID_ITEMS', message: 'shelf action_types take {prod_oid, (pkg_oid), target_is_active} items.' }])
      }
      // §6.2 scope-binding gate
      const notRead = (items as ChangeSetItem[]).filter(i => !ctx.readOids.has(ctx.sessionId, i.prod_oid) || (i.pkg_oid && !ctx.readOids.has(ctx.sessionId, i.pkg_oid)))
      if (notRead.length) {
        return makeEnvelope([], [{
          key: notRead.map(i => i.pkg_oid ?? i.prod_oid).join(','),
          code: 'SCOPE_NOT_READ',
          message: 'These oids were not looked up in this session; query them first (be2_find_products / be2_get_product_plans) before staging a change.',
        }])
      }
    }
    // businessList fail-fast (action_type only)
    if (!businessListAllowsAction(ctx.businessList, actionType)) {
      return makeEnvelope([], [{ key: actionType, code: 'ACTION_NOT_ALLOWED', message: 'Your be2 permissions do not include this shelf action.' }])
    }
    try {
      // Per-user daily change-set budget (§8) — throws RateError over the cap.
      ctx.rateBudget.consumeChangeset(ctx.userLabel)
      const diff = await computeChangesetDiff(actionType, items, { gateway: ctx.gateway, accessToken: ctx.accessToken, userLabel: ctx.userLabel })
      const diffVersion = diffVersionHash(diff)
      const id = ctx.genId()
      ctx.changeSets.create({
        id,
        creatorLabel: ctx.userLabel,
        creatorBearerHash: ctx.bearerHash,
        sessionId: ctx.sessionId,
        actionType,
        items,
        diff,
        diffVersion,
        note: args.note,
        status: 'pending_approval',
        createdAt: ctx.now(),
      })
      const readOidsOut = actionType === 'inventory_setting'
        ? [...new Set((items as InventoryItem[]).map(i => i.item_oid))]
        : [...new Set((items as ChangeSetItem[]).flatMap(i => [i.prod_oid, i.pkg_oid].filter((x): x is string => !!x)))]
      // Fix 1: the confirm_url must NOT enter the model's context — deliver it out-of-band to the
      // human instead. The tool response carries only the changeset_id, status, and diff (data
      // for the agent to summarize to the human in chat). Phase 2b: the URL carries no capability
      // token — approval on the confirm page is gated by a be2-auth SSO session cookie, not a
      // secret in the URL (see confirmRoutes.ts).
      ctx.emitConfirmUrl(id, `${ctx.baseUrl}/confirm/${id}`)
      return makeEnvelope([{
        changeset_id: id,
        status: 'pending_approval',
        diff: { items: diff },
      }], [], readOidsOut)
    } catch (e) {
      return makeEnvelope([], [toEnvelopeError('create_changeset', e)])
    }
  },
}

export const getChangesetStatusTool: L2ToolDef = {
  name: 'be2_get_changeset_status',
  description: 'Query a change-set you created: its approval/execution status and per-item before/after results. Read-only.',
  inputShape: { changeset_id: z.string().min(1) },
  uiResourceUri: 'ui://be2/changeset-panel.html',
  async handler(args, ctx) {
    const rec = ctx.changeSets.get(args.changeset_id as string)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return makeEnvelope([], [{ key: args.changeset_id as string, code: 'NOT_FOUND', message: 'No such change-set for this user.' }])
    const results = ['pending_approval', 'approved'].includes(rec.status) ? undefined : ctx.changeSets.getResults(rec.id)
    return makeEnvelope([{ changeset_id: rec.id, status: rec.status, action_type: rec.actionType, note: rec.note, diff: { items: rec.diff }, ...(results ? { results } : {}) }])
  },
}
