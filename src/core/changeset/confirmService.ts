import { getModule } from './registry.js'
import '../../modules/index.js'
import { executeChangeSet, itemKey, type ExecutorDeps } from './executor.js'
import { AppError } from '../../errors.js'
import type { ChangeSetRecord, ChangeSetItem, InventoryItem, InventoryPlatformItem, ShelfScheduleItem, ItemResult } from './types.js'

// Task 11: the change-set approval+execution sequence used to live ONLY inside
// src/server/confirmRoutes.ts's POST /confirm/:id/approve handler. The MCP Apps panel
// (app_confirm_changeset, src/tools/appTools.ts) needs to trigger the exact same sequence —
// nonce-gated instead of session-cookie-gated — so this module extracts it into one shared
// function both callers invoke. There must never be a second, hand-rolled copy of "recompute
// live diff -> check staleness -> CAS the status -> resolve modify_user -> execute -> audit the
// decision": that sequence is security-critical (it is what makes approval execute-exactly-once
// and immune to a stale/replayed diff) and a copy would silently drift from the original.

export interface ApproveWho { accessToken: string; userLabel: string; sessionId: string; identityId: string }

export interface ApproveParams {
  rec: ChangeSetRecord
  who: ApproveWho
  expectedDiffVersion: string
  // Populated only by the panel: the set of item keys the human actually left checked in the
  // panel UI at the moment of approval. Must exactly match the change-set's full item-key set
  // (no more, no fewer), or the panel's "uncheck an item" affordance would be purely cosmetic —
  // the backend would still execute the full batch regardless of what the human unchecked (spec
  // §4.3). The confirm page never sends this (it has no per-item checkboxes; it stays
  // whole-batch, same as Phase 2a/2b), so this validation is skipped for channel:'confirm_page'.
  confirmedKeys?: string[]
  channel: 'panel' | 'confirm_page'
  audit?: { ip?: string; clientInfo?: string }
  expectedExecuteAtUtc?: number
}

// The three failure modes are mutually exclusive with success: exactly one of stale/casFailed is
// set on failure, or neither is set and status+results are populated on success.
export interface ApproveResult {
  stale?: true
  casFailed?: true
  scheduled?: true
  status?: 'done' | 'partial' | 'failed'
  results?: ItemResult[]
}

export interface ConfirmServiceDeps extends ExecutorDeps {
  // modify_user is resolved LAZILY inside approveAndExecute (see call site below) — never at
  // caller/ctx-creation time. modifyUserFromToken (src/server/app.ts) throws if the token is invalid
  // or missing the platformId claim; eager resolution at AppToolContext construction time
  // would make even read-only app tools (app_get_changeset_view) fail when missing a platformId.
  modifyUserFrom: (accessToken: string) => string
}



export async function approveAndExecute(deps: ConfirmServiceDeps, params: ApproveParams): Promise<ApproveResult> {
  const { rec, who, expectedDiffVersion, confirmedKeys, channel, audit } = params
  const mod = getModule(rec.actionType)

  // (1) confirmed_keys 校驗（面板專用；確認頁不傳此欄位、跳過本步）——見 spec §4.3:面板取消勾選
  // 某個項目後,後端不得仍全量執行整批。集合須完全一致(無多、無缺)。
  //
  // multiset（非 Set）比對:面板取消勾選某項後,後端不得仍全量執行,集合須完全一致(無多無缺)。
  // 用排序後逐一比對的 multiset 而非 Set,避免重複 key 被去重而使 mismatch 永不觸發。
  // （塊A 後 inventory_setting 已無 dates、(item_oid, supplier_oid) 全域唯一,不再產生重複 key;
  // multiset 對唯一 key 與 Set 等價、仍安全,保留以涵蓋任何可能產生重複 key 的 action type。）
  if (confirmedKeys) {
    const expected = rec.items.map(i => mod.itemKey(i)).sort()
    const got = [...confirmedKeys].sort()
    const same = expected.length === got.length && expected.every((k, i) => k === got[i])
    if (!same) {
      throw new AppError('CONFIRMED_KEYS_MISMATCH', "confirmed_keys does not match the change-set's item-key set", 409)
    }
  }

  // (2) 即時重算 diff + staleness 比對——批准的必須是「此刻仍為真」的 diff,不是使用者打開頁面/
  // 面板當下的舊 diff。
  const diff = await mod.computeDiff({ gateway: deps.gateway, accessToken: who.accessToken, userLabel: rec.creatorLabel }, rec.items) as import('./types.js').AnyDiffItem[]
  const version = mod.diffVersion(diff)
  if (version !== expectedDiffVersion) {
    // Final whole-branch review Important 2: without this write-back, app_get_changeset_view
    // (which reads rec.diff/rec.diffVersion straight off the store, unlike the confirm page's GET
    // which always recomputes live) would return the SAME stale diff/version forever — the
    // panel's "reload after DIFF_STALE" recovery path had nothing fresher to ever read, so it
    // could never converge. Persist the diff we just recomputed (the one that revealed the
    // staleness) so the next read sees it. Gated on status still being pending_approval inside
    // updateDiff itself — if a concurrent approve/reject/expiry already moved this change-set on,
    // this is correctly a no-op (never resurrects/overwrites a decided change-set).
    await deps.changeSets.updateDiff(rec.id, diff, version)
    return { stale: true }
  }

  // CRITICAL ordering (carried over verbatim from the pre-extraction confirmRoutes.ts, agy
  // round-2): resolve modifyUser BEFORE the CAS below. modifyUserFrom can throw (the Fix-4
  // placeholder guard throws unless an env flag is set; a real resolver could 5xx) — if that
  // throw happened AFTER pending_approval -> approved, the change-set would be stranded in
  // 'approved' forever (never executes, never fails). Resolving first means a throw here aborts
  // the whole call while the change-set is still 'pending_approval' — retryable, not stranded.
  const modifyUser = deps.modifyUserFrom(who.accessToken)

  // Finding 3（Task 11 review）: 沿用抽出前 confirmRoutes.ts 原本的 'confirm-page:'（連字號）字首,
  // 不可讓 channel 字面值('confirm_page',底線)直接滲入可觀察的 audit 紀錄——那是這次抽取造成的
  // clientInfo 漂移,不是刻意設計。面板(panel)沒有「原本」可沿用,取一個獨立字首。
  const clientInfoPrefix = channel === 'confirm_page' ? 'confirm-page' : 'panel'

  // 塊 B(spec §5):時間回聲綁定——人看到的時間必須等於將執行的時間(同 confirmed_keys 綁
  // items、diff_version 綁內容)。有 schedule 必帶回聲、無 schedule 不得帶,錯配一律 409。
  if (rec.schedule || params.expectedExecuteAtUtc !== undefined) {
    if (!rec.schedule || params.expectedExecuteAtUtc !== rec.schedule.executeAtUtc) {
      throw new AppError('SCHEDULE_ECHO_MISMATCH', 'expected_execute_at_utc does not match this change-set schedule', 409)
    }
    // 批准閾值刻意與建立不同(spec §5):只驗「仍在未來」——若也用 minLead,建立時剛好
    // minLead 後的排程在人審完 diff 點批准的瞬間必然 409,tight schedule 永遠批不過。
    if (rec.schedule.executeAtUtc <= deps.now()) {
      throw new AppError('SCHEDULE_IN_PAST', 'scheduled time has passed — cancel and re-create with a new time', 409)
    }
    const won = await deps.changeSets.setScheduled(rec.id, {
      identityId: who.identityId, userLabel: who.userLabel, modifyUser, sessionId: who.sessionId,
    }, deps.now())
    if (!won) return { casFailed: true }
    await deps.audit.record({
      userLabel: who.userLabel, sessionId: who.sessionId,
      clientInfo: `${clientInfoPrefix}:${String(audit?.clientInfo ?? '').slice(0, 80)}`,
      tool: 'changeset.approve',
      params: { changeset_id: rec.id, ip: audit?.ip, channel, scheduled_for: rec.schedule.executeAtUtc },
      status: 'ok', traceId: 'n/a', durationMs: 0,
    })
    return { scheduled: true }
  }

  // (3) atomic compare-and-swap: only the caller that wins the pending_approval -> approved
  // transition may proceed to executeChangeSet. This is what guarantees execute-exactly-once
  // under concurrent approvals — including the cross-channel case now possible post-Task-11 (one
  // approval via the confirm page, another via the panel, for the same change-set).
  const wonCas = await deps.changeSets.casStatus(rec.id, 'pending_approval', 'approved', deps.now())
  if (!wonCas) return { casFailed: true }

  // Audit the human DECISION itself (governance event "human approved change-set X at T via
  // <channel>"), separate from the per-item audit rows executeChangeSet writes under
  // tool='changeset.execute'. Preserves the confirm-page's original ip/clientInfo audit fields
  // (params.audit) verbatim — dropping IP audit here was an explicitly called-out regression risk
  // during this extraction.
  await deps.audit.record({
    userLabel: who.userLabel, sessionId: who.sessionId,
    clientInfo: `${clientInfoPrefix}:${String(audit?.clientInfo ?? '').slice(0, 80)}`,
    tool: 'changeset.approve',
    params: { changeset_id: rec.id, ip: audit?.ip, channel },
    status: 'ok', traceId: 'n/a', durationMs: 0,
  })

  // (4) execute.
  const out = await executeChangeSet(deps, rec.id, { accessToken: who.accessToken, userLabel: who.userLabel, modifyUser, sessionId: who.sessionId, channel })
  if (!out) return { casFailed: true }
  return { status: out.status, results: out.results }
}
