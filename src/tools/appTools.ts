import { z } from 'zod'
import type { AppToolDef, AppToolContext } from '../server/appPipeline.js'
import { makeEnvelope, toEnvelopeError } from './envelope.js'
import { buildBatchView } from './batchView.js'
import { createChangesetCore, createChangesetInputShape } from '../core/changeset/tools.js'

// 無 existence leak：找不到 id 與「id 存在但非自己建立」回同一種錯誤，讓外部觀察者無法用
// error 差異探測他人 change-set 是否存在。
const NOT_FOUND = (id: string) => makeEnvelope([], [{ key: id, code: 'NOT_FOUND', message: 'No such change-set for this user.' }])

export const appGetChangesetViewTool: AppToolDef = {
  name: 'app_get_changeset_view',
  description: 'Panel-only: fetch a change-set the caller created (status, diff, per-item results).',
  inputShape: { changeset_id: z.string().min(1) } as never,
  async handler(args, ctx: AppToolContext) {
    const rec = ctx.changeSets.get(args.changeset_id)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return NOT_FOUND(args.changeset_id)
    const results = ['pending_approval', 'approved'].includes(rec.status) ? undefined : ctx.changeSets.getResults(rec.id)
    const view: Record<string, unknown> = { changeset_id: rec.id, status: rec.status, action_type: rec.actionType, note: rec.note, diff: { items: rec.diff } }
    if (rec.status === 'pending_approval') {
      // nonce 只在 app-only tool 回傳裡發放（model 讀不到，見 T6）；面板批准操作（Task 11）需帶
      // 這個 nonce + diff_version，把「按下批准」綁到一個 model 拿不到的一次性密碼。
      view.diff_version = rec.diffVersion
      view.nonce = ctx.nonces.issue({ changesetId: rec.id, diffVersion: rec.diffVersion, sessionId: ctx.sessionId })
    } else if (results) {
      view.results = results
    }
    return makeEnvelope([view])
  },
}

export const appGetConfirmLinkTool: AppToolDef = {
  name: 'app_get_confirm_link',
  description: 'Panel-only: get the confirm-page URL for a change-set the caller created (opened via openLink).',
  inputShape: { changeset_id: z.string().min(1) } as never,
  async handler(args, ctx: AppToolContext) {
    const rec = ctx.changeSets.get(args.changeset_id)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return NOT_FOUND(args.changeset_id)
    return makeEnvelope([{ confirm_url: `${ctx.baseUrl}/confirm/${rec.id}` }])
  },
}

// Task 11: panel-side approve/reject. This is the ONLY caller besides confirmRoutes.ts's
// /confirm/:id/approve that may transition a change-set out of pending_approval — both funnel
// through the single shared src/changeset/confirmService.ts#approveAndExecute (injected here as
// ctx.approveAndExecute by wrapAppTool), so there is exactly one execution implementation.
//
// Self-approval defense (spec §4.3, spike T6): the nonce is verified+consumed FIRST, before
// anything else. The nonce is the primary defense — it is only ever returned by
// app_get_changeset_view (an app-only tool a prompt-injected/hallucinating model structurally
// cannot call, per T6) and never enters model context. creator-bound NOT_FOUND check (no
// existence leak for a different user's change-set) still applies on top, same as the other
// app-only tools.
export const appConfirmChangesetTool: AppToolDef = {
  name: 'app_confirm_changeset',
  description: 'Panel-only: approve or reject a change-set the caller created (requires the panel-issued nonce).',
  inputShape: {
    changeset_id: z.string().min(1),
    decision: z.enum(['approve', 'reject']),
    nonce: z.string().min(1),
    diff_version: z.string().min(1),
    confirmed_keys: z.array(z.string()),
  } as never,
  async handler(args, ctx: AppToolContext) {
    const rec = ctx.changeSets.get(args.changeset_id)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return NOT_FOUND(args.changeset_id)
    // nonce 先驗（單次消耗）—— 這是防 model 自我批准的主防線。
    const ok = ctx.nonces.verifyAndConsume(args.nonce, { changesetId: rec.id, diffVersion: args.diff_version, sessionId: ctx.sessionId })
    if (!ok) return makeEnvelope([], [{ key: rec.id, code: 'NONCE_INVALID', message: 'Approval token invalid/expired; reopen the panel to refresh.' }])
    if (args.decision === 'reject') {
      // Finding 2（Task 11 review）: 不可無條件 setStatus——若此 change-set 已透過確認頁(confirm
      // page)以外的路徑批准/執行完畢,面板帶著仍有效的 nonce 按「拒絕」會把已執行結果覆寫成
      // rejected(status-integrity 破洞)。改用 casStatus,只有仍是 pending_approval 才轉態成功;
      // 否則回 ALREADY_PROCESSED,不覆寫。與 confirmRoutes.ts 的 reject 路徑同一套紀律。
      const won = ctx.changeSets.casStatus(rec.id, 'pending_approval', 'rejected', ctx.now())
      if (!won) return makeEnvelope([], [{ key: rec.id, code: 'ALREADY_PROCESSED', message: 'This change-set was already approved/executed or is no longer pending.' }])
      return makeEnvelope([{ changeset_id: rec.id, status: 'rejected' }])
    }
    // approve：交給共用 service。service 內部依序做 confirmed_keys 校驗 → liveDiff → stale → CAS →
    // executeChangeSet → audit（channel:'panel'）。confirmed_keys 必須與 change-set items 完全一致，
    // 否則 service throw CONFIRMED_KEYS_MISMATCH（面板取消勾選不能讓後端仍全量執行 —— spec §4.3）。
    try {
      const out = await ctx.approveAndExecute({ rec, expectedDiffVersion: args.diff_version, confirmedKeys: args.confirmed_keys, channel: 'panel' })
      if (out.stale) return makeEnvelope([], [{ key: rec.id, code: 'DIFF_STALE', message: 'Change-set state moved; panel will reload the new diff.' }])
      if (out.casFailed) return makeEnvelope([], [{ key: rec.id, code: 'ALREADY_PROCESSED', message: 'This change-set was already approved/executed (possibly via the confirm page).' }])
      return makeEnvelope([{ changeset_id: rec.id, status: out.status, results: out.results }])
    } catch (e) {
      return makeEnvelope([], [toEnvelopeError(rec.id, e)])   // CONFIRMED_KEYS_MISMATCH 等
    }
  },
}

// Task 5 (design doc §5.1): wizard step-1 "load products -> plans + current state". This is the
// server-side scope-gate legalization point for the two Phase 4a batch action_types — its
// wrapAppTool auto-records read_oids into the SAME session-scoped ReadOidStore
// be2_create_changeset's SCOPE_NOT_READ gate reads from (see appPipeline.ts's wrapAppTool). The
// panel's own selections are NOT trusted for scope — only what actually got read here counts.
export const appGetBatchViewTool: AppToolDef = {
  name: 'app_get_batch_view',
  description: 'Panel-only: load products -> plans + current state for the batch wizard (registers server-side read-scope).',
  inputShape: {
    action_type: z.enum(['inventory_platform', 'shelf_schedule']),
    prod_oids: z.array(z.string().min(1)).min(1).max(10),
  } as never,
  async handler(args, ctx: AppToolContext) {
    // 沿用既有 L0/L2 讀取工具慣例：view 每次呼叫做真實 gateway 讀取，計一次讀取 budget（與
    // appRateBudget 的面板輪詢節流是兩個獨立額度，見 appPipeline.ts AppToolContext 註解）。
    ctx.rateBudget.consume(ctx.userLabel, ctx.sessionId)
    const { products, errors, read_oids } = await buildBatchView(
      ctx.gateway, ctx.accessToken, args.action_type as 'inventory_platform' | 'shelf_schedule', args.prod_oids as string[],
    )
    return makeEnvelope([{ products }], errors, read_oids)
  },
}

// Task 6 (design doc §5.2): wizard step-2 "stage the change-set the panel just built". Walks the
// EXACT SAME path as be2_create_changeset — same zod input shape (createChangesetInputShape,
// imported verbatim from src/changeset/tools.ts, not hand-copied), same §6.2 scope-gate, same
// businessList fail-fast/degrade, same per-user daily change-set budget, same audit trail — by
// delegating to createChangesetCore, which both entry points share. The only difference from the
// model-facing tool's response is shape: the panel already has (or will separately fetch via
// app_get_changeset_view) the full diff, so this only needs to hand back the changeset_id per
// spec §5.2. A pure failure (no changeset created) is forwarded unchanged so its error code/key
// still reaches the panel and — via wrapAppTool's audit recording — audit_log.
export const appCreateChangesetTool: AppToolDef = {
  name: 'app_create_changeset',
  description:
    'Panel-only: stage a DRAFT change-set from the batch wizard (wizard step 2) — same validation, ' +
    '§6.2 read-scope gate, businessList fail-fast, and per-user daily change-set budget as ' +
    'be2_create_changeset; only the entry point differs. Returns only { changeset_id } — use ' +
    'app_get_changeset_view to load the diff for rendering. Creating a change-set here does NOT ' +
    'approve or execute it; that still requires app_confirm_changeset with its panel-issued nonce.',
  inputShape: createChangesetInputShape as never,
  async handler(args, ctx: AppToolContext) {
    const env = await createChangesetCore(args as never, ctx)
    if (env.items.length === 0) return env   // pure failure: forward errors/warnings unchanged
    const { changeset_id } = env.items[0] as { changeset_id: string }
    return makeEnvelope([{ changeset_id }], env.errors, env.read_oids)
  },
}

export const APP_TOOLS: AppToolDef[] = [
  appGetChangesetViewTool, appGetConfirmLinkTool, appConfirmChangesetTool, appGetBatchViewTool, appCreateChangesetTool,
]
