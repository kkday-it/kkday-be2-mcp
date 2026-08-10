import { z } from 'zod'
import type { L2ToolContext, L2ToolDef } from '../server/l2Context.js'
import { computeShelfDiff, diffVersionHash } from './diff.js'
import { makeEnvelope, toEnvelopeError } from '../tools/envelope.js'
import type { ActionType, ChangeSetItem } from './types.js'

// action_type -> businessList action code(s). businessList is 666 dot-notation strings
// (e.g. "product.product-sale-status.update"), verified live against SIT be2-220.
const ACTION_CODES: Record<ActionType, string[]> = {
  shelf_toggle_product: ['product.product-sale-status.update'],
  shelf_toggle_plan: ['product.product-sale-status.update', 'product.bundle-package-sale-status.update'],
  // Confirmed live against SIT be2-220 (docs/be2-mcp/sit-write-contracts.md "inventory" section, Task 1 probe).
  inventory_setting: ['product.product-inventory.update'],
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
const itemShape = z.union([
  z.object({ prod_oid: z.string().min(1), target_is_active: z.boolean() }),
  z.object({ prod_oid: z.string().min(1), pkg_oid: z.string().min(1), target_is_active: z.boolean() }),
  invItemShape,
])
const inputShape = {
  action_type: z.enum(['shelf_toggle_product', 'shelf_toggle_plan', 'inventory_setting']),
  items: z.array(itemShape).min(1).max(20),
  note: z.string().max(500).optional(),
}

export const createChangesetTool: L2ToolDef = {
  name: 'be2_create_changeset',
  description:
    'Stage a DRAFT shelf-on/off change for products (shelf_toggle_product) or plans (shelf_toggle_plan) — max 20 items. ' +
    'Returns { changeset_id, status, diff } — a preview only; it does NOT apply anything and returns NO confirm link. ' +
    'A human operator must open the confirm page for this change-set in a browser and log in via be2-auth SSO to review ' +
    'and approve or reject it there; only then does the write execute. You CANNOT approve or execute this change-set ' +
    'yourself — report the changeset_id and the diff to the user and tell them to open the confirm page to decide. ' +
    'Only pass oids you already looked up this session.',
  inputShape,
  async handler(args, ctx: L2ToolContext) {
    const items = args.items as ChangeSetItem[]
    const actionType = args.action_type as ActionType
    // §6.2 scope-binding gate
    const notRead = items.filter(i => !ctx.readOids.has(ctx.sessionId, i.prod_oid) || (i.pkg_oid && !ctx.readOids.has(ctx.sessionId, i.pkg_oid)))
    if (notRead.length) {
      return makeEnvelope([], [{
        key: notRead.map(i => i.pkg_oid ?? i.prod_oid).join(','),
        code: 'SCOPE_NOT_READ',
        message: 'These oids were not looked up in this session; query them first (be2_find_products / be2_get_product_plans) before staging a change.',
      }])
    }
    // businessList fail-fast (action_type only)
    if (!businessListAllowsAction(ctx.businessList, actionType)) {
      return makeEnvelope([], [{ key: actionType, code: 'ACTION_NOT_ALLOWED', message: 'Your be2 permissions do not include this shelf action.' }])
    }
    try {
      // Per-user daily change-set budget (§8) — throws RateError over the cap.
      ctx.rateBudget.consumeChangeset(ctx.userLabel)
      // Task 4 narrowed computeShelfDiff's actionType param to exclude 'inventory_setting' (the
      // dispatcher now owns that branch); this call site still only ever handles the two shelf
      // action types (createChangesetTool's inventory_setting path is wired in Task 5). Safe cast.
      const diff = await computeShelfDiff(actionType as Exclude<ActionType, 'inventory_setting'>, items, { gateway: ctx.gateway, accessToken: ctx.accessToken, userLabel: ctx.userLabel })
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
      const readOidsOut = [...new Set(items.flatMap(i => [i.prod_oid, i.pkg_oid].filter((x): x is string => !!x)))]
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
  async handler(args, ctx) {
    const rec = ctx.changeSets.get(args.changeset_id as string)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return makeEnvelope([], [{ key: args.changeset_id as string, code: 'NOT_FOUND', message: 'No such change-set for this user.' }])
    const results = ['pending_approval', 'approved'].includes(rec.status) ? undefined : ctx.changeSets.getResults(rec.id)
    return makeEnvelope([{ changeset_id: rec.id, status: rec.status, action_type: rec.actionType, note: rec.note, diff: { items: rec.diff }, ...(results ? { results } : {}) }])
  },
}
