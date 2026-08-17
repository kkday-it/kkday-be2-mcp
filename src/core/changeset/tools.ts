import '../../modules/index.js'
import { z } from 'zod'
import type { L2ToolContext, L2ToolDef } from '../../server/l2Context.js'
import { makeEnvelope, toEnvelopeError, type EnvelopeError } from '../../tools/envelope.js'
import type { ActionType, AnyChangeSetItem, AnyDiffItem } from './types.js'
import { getModule, listModules } from './registry.js'
import type { ActionModule } from './module.js'

export { INVENTORY_ACTION_CODES } from '../../modules/product/inventorySetting/module.js'

export function businessListAllowsAction(businessList: unknown[], actionType: ActionType): boolean {
  return businessListAllows(businessList, getModule(actionType).authz.codes)
}

function businessListAllows(businessList: unknown[], codesToCheck: string[]): boolean {
  const codes = new Set(
    (businessList ?? []).map(b => typeof b === 'string' ? b : (b as { action?: string; code?: string })?.action ?? (b as { code?: string })?.code).filter(Boolean) as string[])
  return codesToCheck.some(c => codes.has(c))
}

const itemShape = z.union(listModules().map(m => m.itemSchema) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])

// Exported (Task 6): app_create_changeset (src/tools/appTools.ts) reuses this SAME zod shape
// verbatim — the wizard panel's create-changeset entry point must accept exactly what
// be2_create_changeset accepts, not a hand-copied subset that could silently drift.
export const createChangesetInputShape = {
  action_type: z.enum(listModules().map(m => m.actionType) as [string, ...string[]]),
  items: z.array(itemShape).min(1).max(20),
  note: z.string().max(500).optional(),
}
const inputShape = createChangesetInputShape

// Task 6: extracted so app_create_changeset (src/tools/appTools.ts, the wizard panel's create
// entry point) walks the EXACT SAME validation / §6.2 scope-gate / businessList fail-fast /
// per-user changeset budget / diff-compute / store-create / emitConfirmUrl sequence as the
// model-facing be2_create_changeset tool below — one implementation, two thin callers, so the
// two entry points structurally cannot drift apart. `ctx` only needs the L2ToolContext shape;
// AppToolContext (src/server/appPipeline.ts) is a structural superset of it (readOids,
// changeSets, rateBudget, businessList, emitConfirmUrl, etc. all present under the same names),
// so an AppToolContext value can be passed here without any adapter.
export async function createChangesetCore(args: Record<string, unknown>, ctx: L2ToolContext) {
  const actionType = args.action_type as ActionType
  // Registry guarantees actionType mapping, so we safely cast
  const mod = getModule(actionType) as ActionModule<AnyChangeSetItem, AnyDiffItem>
  const rawItems = args.items as unknown[]
  if (!rawItems.every(i => mod.isItem(i))) {
    return makeEnvelope([], [{ key: actionType, code: 'INVALID_ITEMS', message: mod.invalidItemsMessage }])
  }
  const items = rawItems as AnyChangeSetItem[]
  const bad = mod.validate(items, ctx.now())
  if (bad) return makeEnvelope([], [{ key: bad.key, code: 'INVALID_ITEMS', message: bad.message }])
  // §6.2 scope-binding gate
  const notRead = items.filter(i => mod.scopeOids(i).some(oid => !ctx.readOids.has(ctx.sessionId, oid)))
  if (notRead.length) {
    return makeEnvelope([], [{
      key: notRead.map(i => mod.scopeErrorKey(i)).join(','),
      code: 'SCOPE_NOT_READ',
      message: mod.scopeNotReadMessage,
    }])
  }
  // businessList fail-fast: block/warn 由 module.authz.onMissing 決定
  const warnings: EnvelopeError[] = []
  if (!businessListAllows(ctx.businessList, mod.authz.codes)) {
    if (mod.authz.onMissing === 'warn') {
      warnings.push({
        key: actionType,
        code: 'ACTION_CODE_UNVERIFIED',
        message: 'businessList does not contain the expected action code for this action_type; staging is allowed (spec §4.3 degrade) — the authoritative permission check happens at gateway /verify when the change-set executes.',
      })
    } else {
      return makeEnvelope([], [{ key: actionType, code: 'ACTION_NOT_ALLOWED', message: 'Your be2 permissions do not include this shelf action.' }])
    }
  }
  try {
    ctx.rateBudget.consumeChangeset(ctx.userLabel)
    const diff = await mod.computeDiff({ gateway: ctx.gateway, accessToken: ctx.accessToken, userLabel: ctx.userLabel }, items)
    const diffVersion = mod.diffVersion(diff)
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
      note: args.note as string | undefined,
      status: 'pending_approval',
      createdAt: ctx.now(),
    })
    const readOidsOut = [...new Set(items.flatMap(i => mod.scopeOids(i)))]
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
    }], warnings, readOidsOut)
  } catch (e) {
    return makeEnvelope([], [toEnvelopeError('create_changeset', e)])
  }
}

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
    'read the item inventory first — adjust is computed against live quantities at approval time. ' +
    'Before staging, you MUST confirm 3 things with the user: (1) explicit plan list (confirm each pkg_oid, no vague "all"); ' +
    '(2) whether to apply immediately (shelf_toggle_plan) or schedule (shelf_schedule); ' +
    '(3) if scheduling, the exact date, time, and TIMEZONE (ask if not provided, do not guess). ' +
    'Convert local time to UTC "YYYY-MM-DD HH:mm:ss" for reserve_date_utc. If any is missing, ASK first, do NOT stage.',
  inputShape,
  uiResourceUri: 'ui://be2/changeset-panel.html',
  annotations: {
    title: 'Stage draft change-set',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  async handler(args, ctx: L2ToolContext) {
    return createChangesetCore(args, ctx)
  },
}

export const getChangesetStatusTool: L2ToolDef = {
  name: 'be2_get_changeset_status',
  description: 'Query a change-set you created: its approval/execution status and per-item before/after results. Read-only.',
  inputShape: { changeset_id: z.string().min(1) },
  uiResourceUri: 'ui://be2/changeset-panel.html',
  annotations: {
    title: 'Get change-set status',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(args, ctx) {
    const rec = ctx.changeSets.get(args.changeset_id as string)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return makeEnvelope([], [{ key: args.changeset_id as string, code: 'NOT_FOUND', message: 'No such change-set for this user.' }])
    const results = ['pending_approval', 'approved'].includes(rec.status) ? undefined : ctx.changeSets.getResults(rec.id)
    return makeEnvelope([{ changeset_id: rec.id, status: rec.status, action_type: rec.actionType, note: rec.note, diff: { items: rec.diff }, ...(results ? { results } : {}) }])
  },
}
