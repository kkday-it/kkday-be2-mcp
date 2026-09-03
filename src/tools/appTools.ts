import { z } from 'zod'
import type { AppToolDef, AppToolContext } from '../server/appPipeline.js'
import { makeEnvelope, toEnvelopeError, type EnvelopeError } from './envelope.js'
import { buildBatchView, type BatchViewActionType } from './batchView.js'
import { createChangesetCore, createChangesetInputShape } from '../core/changeset/tools.js'
import { extractProductInfo } from './findProducts.js'
import { makeAnnouncementClient } from '../modules/announcement/create/svcB2cClient.js'
import { resolveProdOids } from '../gateway/prodOidResolver.js'

// 無 existence leak：找不到 id 與「id 存在但非自己建立」回同一種錯誤，讓外部觀察者無法用
// error 差異探測他人 change-set 是否存在。
const NOT_FOUND = (id: string) => makeEnvelope([], [{ key: id, code: 'NOT_FOUND', message: 'No such change-set for this user.' }])

export const appGetChangesetViewTool: AppToolDef = {
  name: 'app_get_changeset_view',
  description: 'Panel-only: fetch a change-set the caller created (status, diff, per-item results).',
  inputShape: { changeset_id: z.string().min(1) } as never,
  annotations: {
    title: 'Get change-set view',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(args, ctx: AppToolContext) {
    const rec = await ctx.changeSets.get(args.changeset_id)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return NOT_FOUND(args.changeset_id)
    const results = ['pending_approval', 'approved', 'scheduled'].includes(rec.status) ? undefined : await ctx.changeSets.getResults(rec.id)
    const view: Record<string, unknown> = { changeset_id: rec.id, status: rec.status, action_type: rec.actionType, note: rec.note, diff: { items: rec.diff } }
    // schedule 是 change-set 不可變部分:rec.schedule 存在即回、不限 status(Task 10 review
    // Critical 1——pending_approval 不回會讓面板批准少帶 expected_execute_at_utc 回聲,server
    // 端 SCHEDULE_ECHO_MISMATCH 必炸)。鍵名對齊 be2_get_changeset_status 的 snake_case。
    if (rec.schedule) {
      view.schedule = { execute_at_utc: rec.schedule.executeAtUtc, wall: rec.schedule.wall, tz: rec.schedule.tz }
    }
    if (rec.status === 'pending_approval' || rec.status === 'scheduled') {
      // nonce 只在 app-only tool 回傳裡發放（model 讀不到，見 T6）；面板批准/取消操作需帶
      // 這個 nonce + diff_version，把「按下批准/取消」綁到一個 model 拿不到的一次性密碼。
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
  annotations: {
    title: 'Get confirm link',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(args, ctx: AppToolContext) {
    const rec = await ctx.changeSets.get(args.changeset_id)
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
    decision: z.enum(['approve', 'reject', 'cancel']),
    nonce: z.string().min(1),
    diff_version: z.string().min(1),
    confirmed_keys: z.array(z.string()),
    expected_execute_at_utc: z.number().int().optional(),
  } as never,
  annotations: {
    title: 'Confirm and execute change-set',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  async handler(args, ctx: AppToolContext) {
    const rec = await ctx.changeSets.get(args.changeset_id)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return NOT_FOUND(args.changeset_id)
    // nonce 先驗（單次消耗）—— 這是防 model 自我批准的主防線。
    const ok = ctx.nonces.verifyAndConsume(args.nonce, { changesetId: rec.id, diffVersion: args.diff_version, sessionId: ctx.sessionId })
    if (!ok) return makeEnvelope([], [{ key: rec.id, code: 'NONCE_INVALID', message: 'Approval token invalid/expired; reopen the panel to refresh.' }])
    if (args.decision === 'cancel') {
      const won = await ctx.changeSets.casStatus(rec.id, 'scheduled', 'cancelled', ctx.now())
      if (!won) return makeEnvelope([], [{ key: rec.id, code: 'NOT_CANCELLABLE', message: 'Only a scheduled change-set can be cancelled.' }])
      return makeEnvelope([{ changeset_id: rec.id, status: 'cancelled' }])
    }
    if (args.decision === 'reject') {
      // Finding 2（Task 11 review）: 不可無條件 setStatus——若此 change-set 已透過確認頁(confirm
      // page)以外的路徑批准/執行完畢,面板帶著仍有效的 nonce 按「拒絕」會把已執行結果覆寫成
      // rejected(status-integrity 破洞)。改用 casStatus,只有仍是 pending_approval 才轉態成功;
      // 否則回 ALREADY_PROCESSED,不覆寫。與 confirmRoutes.ts 的 reject 路徑同一套紀律。
      const won = await ctx.changeSets.casStatus(rec.id, 'pending_approval', 'rejected', ctx.now())
      if (!won) return makeEnvelope([], [{ key: rec.id, code: 'ALREADY_PROCESSED', message: 'This change-set was already approved/executed or is no longer pending.' }])
      return makeEnvelope([{ changeset_id: rec.id, status: 'rejected' }])
    }
    // approve：交給共用 service。service 內部依序做 confirmed_keys 校驗 → liveDiff → stale → CAS →
    // executeChangeSet → audit（channel:'panel'）。confirmed_keys 必須與 change-set items 完全一致，
    // 否則 service throw CONFIRMED_KEYS_MISMATCH（面板取消勾選不能讓後端仍全量執行 —— spec §4.3）。
    try {
      const out = await ctx.approveAndExecute({ rec, expectedDiffVersion: args.diff_version, confirmedKeys: args.confirmed_keys, channel: 'panel', expectedExecuteAtUtc: args.expected_execute_at_utc as number | undefined })
      if (out.stale) return makeEnvelope([], [{ key: rec.id, code: 'DIFF_STALE', message: 'Change-set state moved; panel will reload the new diff.' }])
      if (out.casFailed) return makeEnvelope([], [{ key: rec.id, code: 'ALREADY_PROCESSED', message: 'This change-set was already approved/executed (possibly via the confirm page).' }])
      if (out.scheduled) return makeEnvelope([{ changeset_id: rec.id, status: 'scheduled' }])
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
    action_type: z.enum(['inventory_platform', 'shelf_schedule', 'inventory_setting', 'shelf_toggle_product', 'shelf_toggle_plan', 'shelf_toggle_bundle']),
    prod_mids: z.array(z.string().min(1)).max(10).optional(),
    prod_oids: z.array(z.string().min(1)).max(10).optional(),
  } as never,
  annotations: {
    title: 'Get batch view',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(args, ctx: AppToolContext) {
    // 沿用既有 L0/L2 讀取工具慣例：view 每次呼叫做真實 gateway 讀取，計一次讀取 budget（與
    // appRateBudget 的面板輪詢節流是兩個獨立額度，見 appPipeline.ts AppToolContext 註解）。
    await ctx.rateBudget.consume(ctx.userLabel, ctx.sessionId)
    // Combined cap: each array has max(10) but without a joint limit the tool could feed up to 20 oids
    // into buildBatchView — double the documented ≤10 and the gateway burst assumption. Fail fast.
    if ((args.prod_mids?.length ?? 0) + (args.prod_oids?.length ?? 0) > 10) {
      return makeEnvelope([], [{ key: 'input', code: 'TOO_MANY_IDS', message: 'Provide at most 10 ids total across prod_mids and prod_oids.' }])
    }
    const { resolved, resolutions, errors: resolveErrors } =
      await resolveProdOids(args.prod_mids ?? [], args.prod_oids ?? [], ctx.gateway, ctx.accessToken)
    if (resolved.length === 0 && resolveErrors.length === 0) {
      return makeEnvelope([], [{ key: 'input', code: 'MISSING_ID', message: 'Provide prod_mids or prod_oids.' }])
    }
    const { products, errors, read_oids } = await buildBatchView(
      ctx.gateway, ctx.accessToken, args.action_type as BatchViewActionType, resolved,
    )
    // schedule_tz（spec §9：面板須標示實際 APP_TZ 而非通用「伺服器時區」）——由 ctx 帶出給面板 step-1
    // 顯示。排程輸入的 wall-clock 即以此 tz 於 server 端換算 UTC。
    return makeEnvelope([{ products, schedule_tz: ctx.scheduleTz }], [...resolveErrors, ...errors], read_oids, resolutions)
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
  annotations: {
    title: 'Stage draft change-set (panel)',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  async handler(args, ctx: AppToolContext) {
    const env = await createChangesetCore(args as never, ctx)
    if (env.items.length === 0) return env   // pure failure: forward errors/warnings unchanged
    const { changeset_id } = env.items[0] as { changeset_id: string }
    return makeEnvelope([{ changeset_id }], env.errors, env.read_oids)
  },
}

export const appGetAnnouncementViewTool: AppToolDef = {
  name: 'app_get_announcement_view',
  description: 'Panel-only: load products (names + existing announcement count) for the announcement wizard (registers server-side read-scope for prod_oids).',
  inputShape: {
    prod_mids: z.array(z.string().min(1)).max(10).optional(),
    prod_oids: z.array(z.string().min(1)).max(10).optional(),
  } as never,
  annotations: { title: 'Get announcement view', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx: AppToolContext) {
    await ctx.rateBudget.consume(ctx.userLabel, ctx.sessionId)
    // Combined cap: each array has max(10) but without a joint limit the tool could read up to 20 oids —
    // double the documented ≤10 and the gateway burst assumption. Fail fast.
    if ((args.prod_mids?.length ?? 0) + (args.prod_oids?.length ?? 0) > 10) {
      return makeEnvelope([], [{ key: 'input', code: 'TOO_MANY_IDS', message: 'Provide at most 10 ids total across prod_mids and prod_oids.' }])
    }
    const { resolved: prodOids, resolutions, errors: resolveErrors } =
      await resolveProdOids(args.prod_mids ?? [], args.prod_oids ?? [], ctx.gateway, ctx.accessToken)
    if (prodOids.length === 0 && resolveErrors.length === 0) {
      return makeEnvelope([], [{ key: 'input', code: 'MISSING_ID', message: 'Provide prod_mids or prod_oids.' }])
    }
    const errors: EnvelopeError[] = [...resolveErrors]
    const products: Array<{ prod_oid: string; name?: string; existing_count: number | null }> = []
    // existing_count 是 best-effort context（live 讀取卡 svc-b2c S2S 403、且 dev/test 可能無
    // API_ANNOUNCE_KEY）。client 建不起來或 list 失敗一律靜默降級（existing_count = null 未知），
    // 不 push error——scope-gate 只需 read_oids + 商品名；既有公告數讀不到不該讓整個 view 報錯。
    let client: ReturnType<typeof makeAnnouncementClient> | undefined
    try { client = makeAnnouncementClient() } catch { /* announcement client unavailable → existing_count 留 null */ }
    
    // 既有公告數：一次查全部 prod_oids，事後依 prod_oid 分組計數（免 N+1）。
    // best-effort：client 建不起來 / 查詢失敗 / 回傳項無法對應 prod_oid → 全部降級為 null（未知）。
    // 已知取捨（best-effort、僅供「是否重建公告」的參考數字）：listByProdOids 固定 perPage=100，
    // 這 100 筆上限由本批 ≤10 個 prod_oids 共用——跨商品公告總數 >100 時，靠後的商品可能低報；
    // 且分組依賴回傳項帶 prod_oid/prodOid（live svc-b2c 形狀尚未實證）。真正跑 live 前需按實際形狀校準。
    let counts: Map<string, number> | null = null
    if (client) {
      try {
        const items = await client.listByProdOids(ctx.accessToken, prodOids)
        const m = new Map<string, number>()
        let anyGroupable = false
        for (const it of items as Array<Record<string, unknown>>) {
          const pid = (it?.prod_oid ?? it?.prodOid)
          if (pid == null) continue
          anyGroupable = true
          const k = String(pid)
          m.set(k, (m.get(k) ?? 0) + 1)
        }
        counts = (!anyGroupable && items.length > 0) ? null : m
      } catch { counts = null }
    }
    // read_oids must reflect ONLY products this user actually read here — never the full resolved set.
    // Because the mid→oid cache is global (a cache hit skips the per-user mid-info call), registering an
    // unread oid would let user B pass the scope-gate for an oid mapped by user A's earlier lookup. So an
    // oid whose info GET fails (403/404) is reported as an error but NOT added to read_oids.
    const readOids: string[] = []
    for (const oid of prodOids) {
      let name: string | undefined
      try {
        name = extractProductInfo(await ctx.gateway.get(`/product/api/v1/drafts/products/${encodeURIComponent(oid)}/info`, ctx.accessToken)).name
        readOids.push(oid)
      }
      catch (e) { errors.push(toEnvelopeError(oid, e)) }
      const existing: number | null = counts ? (counts.get(oid) ?? 0) : null
      products.push({ prod_oid: oid, name, existing_count: existing })
    }
    return makeEnvelope([{ products }], errors, readOids, resolutions)
  },
}

export const APP_TOOLS: AppToolDef[] = [
  appGetChangesetViewTool, appGetConfirmLinkTool, appConfirmChangesetTool, appGetBatchViewTool, appCreateChangesetTool, appGetAnnouncementViewTool,
]
