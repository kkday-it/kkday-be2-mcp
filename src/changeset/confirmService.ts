import { computeChangesetDiff, diffVersionHash } from './diff.js'
import { executeChangeSet, itemKey, type ExecutorDeps } from './executor.js'
import { AppError } from '../errors.js'
import type { ChangeSetRecord, ChangeSetItem, InventoryItem, ItemResult } from './types.js'

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

function itemKeysOf(rec: ChangeSetRecord): string[] {
  return rec.actionType === 'inventory_setting'
    ? (rec.items as InventoryItem[]).map(it => `${it.item_oid}:${it.supplier_oid}`)
    : (rec.items as ChangeSetItem[]).map(itemKey)
}

export async function approveAndExecute(deps: ConfirmServiceDeps, params: ApproveParams): Promise<ApproveResult> {
  const { rec, who, expectedDiffVersion, confirmedKeys, channel, audit } = params

  // (1) confirmed_keys 校驗（面板專用；確認頁不傳此欄位、跳過本步）——見 spec §4.3:面板取消勾選
  // 某個項目後,後端不得仍全量執行整批。集合須完全一致(無多、無缺)。
  if (confirmedKeys) {
    const expected = new Set(itemKeysOf(rec))
    const got = new Set(confirmedKeys)
    const same = expected.size === got.size && [...expected].every(k => got.has(k))
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
  deps.audit.record({
    userLabel: who.userLabel, sessionId: who.sessionId,
    clientInfo: `${channel}:${String(audit?.clientInfo ?? '').slice(0, 80)}`,
    tool: 'changeset.approve',
    params: { changeset_id: rec.id, ip: audit?.ip, channel },
    status: 'ok', traceId: 'n/a', durationMs: 0,
  })

  // (4) execute.
  const out = await executeChangeSet(deps, rec.id, { accessToken: who.accessToken, userLabel: who.userLabel, modifyUser, sessionId: who.sessionId })
  return { status: out.status, results: out.results }
}
