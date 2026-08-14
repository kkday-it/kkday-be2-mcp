import { computeChangesetDiff, diffVersionHash } from './diff.js'
import { executeChangeSet, itemKey, type ExecutorDeps } from './executor.js'
import { AppError } from '../errors.js'
import type { ChangeSetRecord, ChangeSetItem, InventoryItem, InventoryPlatformItem, ItemResult } from './types.js'

// Task 11: the change-set approval+execution sequence used to live ONLY inside
// src/server/confirmRoutes.ts's POST /confirm/:id/approve handler. The MCP Apps panel
// (app_confirm_changeset, src/tools/appTools.ts) needs to trigger the exact same sequence —
// nonce-gated instead of session-cookie-gated — so this module extracts it into one shared
// function both callers invoke. There must never be a second, hand-rolled copy of "recompute
// live diff -> check staleness -> CAS the status -> resolve modify_user -> execute -> audit the
// decision": that sequence is security-critical (it is what makes approval execute-exactly-once
// and immune to a stale/replayed diff) and a copy would silently drift from the original.

export interface ApproveWho { accessToken: string; userLabel: string; sessionId: string }

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
}

// The three failure modes are mutually exclusive with success: exactly one of stale/casFailed is
// set on failure, or neither is set and status+results are populated on success.
export interface ApproveResult {
  stale?: true
  casFailed?: true
  status?: 'done' | 'partial' | 'failed'
  results?: ItemResult[]
}

export interface ConfirmServiceDeps extends ExecutorDeps {
  // modify_user is resolved LAZILY inside approveAndExecute (see call site below) — never at
  // caller/ctx-creation time. modifyUserFromPlaceholder (src/server/app.ts) throws unless
  // BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER=1; eager resolution at AppToolContext construction time
  // would make even read-only app tools (app_get_changeset_view) fail in the default config.
  modifyUserFrom: (accessToken: string) => string
}

// Explicit per-actionType branch (Task 3 review): inventory_platform's item key is
// `${item_oid}:${supplier_oid}`, the SAME shape as inventory_setting — but before this branch
// existed, any actionType other than 'inventory_setting' fell through to the shelf `itemKey()`
// cast, which reads `.prod_oid`/`.pkg_oid` (both undefined on InventoryPlatformItem) and returns
// undefined for every item. That would permanently mismatch any real confirmedKeys sent by the
// panel and lock the approval path shut (CONFIRMED_KEYS_MISMATCH on every attempt).
function itemKeysOf(rec: ChangeSetRecord): string[] {
  if (rec.actionType === 'inventory_setting' || rec.actionType === 'inventory_platform') {
    return (rec.items as Array<InventoryItem | InventoryPlatformItem>).map(it => `${it.item_oid}:${it.supplier_oid}`)
  }
  return (rec.items as ChangeSetItem[]).map(itemKey)
}

export async function approveAndExecute(deps: ConfirmServiceDeps, params: ApproveParams): Promise<ApproveResult> {
  const { rec, who, expectedDiffVersion, confirmedKeys, channel, audit } = params

  // (1) confirmed_keys 校驗（面板專用；確認頁不傳此欄位、跳過本步）——見 spec §4.3:面板取消勾選
  // 某個項目後,後端不得仍全量執行整批。集合須完全一致(無多、無缺)。
  //
  // Task 12 review Finding 1: 不可用 Set 比對——inventory change-set 合法允許兩個項目共用同一
  // (item_oid, supplier_oid) 但 dates 不相交(validateInventoryItems 只檢查 (item,supplier,date)
  // 三元組唯一性),兩者在面板上會渲染成同一把 key。若用 Set,expected 的 [k,k] 會被去重成 {k},
  // 使用者取消勾選其中一列後 confirmedKeys 送出的 [k] 也去重成 {k}——集合大小、內容都對得上,
  // mismatch 檢查永遠不會觸發,導致使用者想取消的那一列仍隨整批一起執行。改用「排序後逐一比對
  // 的 multiset」:重複次數必須相同,長度不同或排序後任一位置不同即視為不符。唯一 key 的情境下
  // 與舊 Set 邏輯行為一致(既有測試不受影響)。
  if (confirmedKeys) {
    const expected = [...itemKeysOf(rec)].sort()
    const got = [...confirmedKeys].sort()
    const same = expected.length === got.length && expected.every((k, i) => k === got[i])
    if (!same) {
      throw new AppError('CONFIRMED_KEYS_MISMATCH', "confirmed_keys does not match the change-set's item-key set", 409)
    }
  }

  // (2) 即時重算 diff + staleness 比對——批准的必須是「此刻仍為真」的 diff,不是使用者打開頁面/
  // 面板當下的舊 diff。
  const diff = await computeChangesetDiff(rec.actionType, rec.items, { gateway: deps.gateway, accessToken: who.accessToken, userLabel: rec.creatorLabel })
  const version = diffVersionHash(diff)
  if (version !== expectedDiffVersion) return { stale: true }

  // CRITICAL ordering (carried over verbatim from the pre-extraction confirmRoutes.ts, agy
  // round-2): resolve modifyUser BEFORE the CAS below. modifyUserFrom can throw (the Fix-4
  // placeholder guard throws unless an env flag is set; a real resolver could 5xx) — if that
  // throw happened AFTER pending_approval -> approved, the change-set would be stranded in
  // 'approved' forever (never executes, never fails). Resolving first means a throw here aborts
  // the whole call while the change-set is still 'pending_approval' — retryable, not stranded.
  const modifyUser = deps.modifyUserFrom(who.accessToken)

  // (3) atomic compare-and-swap: only the caller that wins the pending_approval -> approved
  // transition may proceed to executeChangeSet. This is what guarantees execute-exactly-once
  // under concurrent approvals — including the cross-channel case now possible post-Task-11 (one
  // approval via the confirm page, another via the panel, for the same change-set).
  const wonCas = deps.changeSets.casStatus(rec.id, 'pending_approval', 'approved', deps.now())
  if (!wonCas) return { casFailed: true }

  // Audit the human DECISION itself (governance event "human approved change-set X at T via
  // <channel>"), separate from the per-item audit rows executeChangeSet writes under
  // tool='changeset.execute'. Preserves the confirm-page's original ip/clientInfo audit fields
  // (params.audit) verbatim — dropping IP audit here was an explicitly called-out regression risk
  // during this extraction.
  // Finding 3（Task 11 review）: 沿用抽出前 confirmRoutes.ts 原本的 'confirm-page:'（連字號）字首,
  // 不可讓 channel 字面值('confirm_page',底線)直接滲入可觀察的 audit 紀錄——那是這次抽取造成的
  // clientInfo 漂移,不是刻意設計。面板(panel)沒有「原本」可沿用,取一個獨立字首。
  const clientInfoPrefix = channel === 'confirm_page' ? 'confirm-page' : 'panel'
  deps.audit.record({
    userLabel: who.userLabel, sessionId: who.sessionId,
    clientInfo: `${clientInfoPrefix}:${String(audit?.clientInfo ?? '').slice(0, 80)}`,
    tool: 'changeset.approve',
    params: { changeset_id: rec.id, ip: audit?.ip, channel },
    status: 'ok', traceId: 'n/a', durationMs: 0,
  })

  // (4) execute.
  const out = await executeChangeSet(deps, rec.id, { accessToken: who.accessToken, userLabel: who.userLabel, modifyUser, sessionId: who.sessionId })
  return { status: out.status, results: out.results }
}
