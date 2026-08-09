import { z } from 'zod'
import type { L2ToolContext, L2ToolDef } from '../server/l2Context.js'
import { ChangeSetStore } from './store.js'
import { computeShelfDiff, diffVersionHash } from './diff.js'
import { makeEnvelope, toEnvelopeError } from '../tools/envelope.js'
import type { ActionType, ChangeSetItem } from './types.js'

// action_type -> businessList action code(s). Adjust the codes to the real businessList
// shape after Task 1 (Phase 0 noted businessList = action list). Empty businessList = deny.
const ACTION_CODES: Record<ActionType, string[]> = {
  shelf_toggle_product: ['product_switch', 'product_active'],
  shelf_toggle_plan: ['package_config', 'package_switch'],
}

export function businessListAllowsAction(businessList: unknown[], actionType: ActionType): boolean {
  const codes = new Set(
    (businessList ?? []).map(b => typeof b === 'string' ? b : (b as { action?: string; code?: string })?.action ?? (b as { code?: string })?.code).filter(Boolean) as string[])
  return ACTION_CODES[actionType].some(c => codes.has(c))
}

const itemShape = z.union([
  z.object({ prod_oid: z.string().min(1), target_is_active: z.boolean() }),
  z.object({ prod_oid: z.string().min(1), pkg_oid: z.string().min(1), target_is_active: z.boolean() }),
])
const inputShape = {
  action_type: z.enum(['shelf_toggle_product', 'shelf_toggle_plan']),
  items: z.array(itemShape).min(1).max(20),
  note: z.string().max(500).optional(),
}

export const createChangesetTool: L2ToolDef = {
  name: 'be2_create_changeset',
  description:
    'Stage a DRAFT shelf-on/off change for products (shelf_toggle_product) or plans (shelf_toggle_plan) — max 20 items. ' +
    'Returns a diff preview + a confirm_url; it does NOT apply anything. A human must open the confirm_url and approve; ' +
    'only then does the write execute. You CANNOT approve or execute. Only pass oids you already looked up this session.',
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
      const diff = await computeShelfDiff(actionType, items, { gateway: ctx.gateway, accessToken: ctx.accessToken, userLabel: ctx.userLabel })
      const diffVersion = diffVersionHash(diff)
      const id = ctx.genId()
      const token = ctx.genToken()
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
        approvalTokenHash: ChangeSetStore.hashToken(token),
        createdAt: ctx.now(),
      })
      const readOidsOut = [...new Set(items.flatMap(i => [i.prod_oid, i.pkg_oid].filter((x): x is string => !!x)))]
      return makeEnvelope([{
        changeset_id: id,
        status: 'pending_approval',
        confirm_url: `${ctx.baseUrl}/confirm/${id}?token=${token}`,
        diff_version: diffVersion,
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
