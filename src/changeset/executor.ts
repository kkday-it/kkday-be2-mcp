import { trace } from '@opentelemetry/api'
import type { ChangeSetStore } from './store.js'
import type { GatewayClient } from '../gateway/client.js'
import type { AuditLog } from '../audit/auditLog.js'
import type { ItemResult, ChangeSetItem } from './types.js'
import { AppError } from '../errors.js'
import { getModule } from '../core/changeset/registry.js'
import type { ExecCtx } from '../core/changeset/module.js'
import '../modules/index.js'

export interface ExecutorDeps {
  changeSets: ChangeSetStore; gateway: GatewayClient; audit: AuditLog; now: () => number
}

// The identity to execute AS. Resolved by the CALLER before executeChangeSet is invoked (spec
// §4): a token-resolution failure must never strand a change-set in 'executing' with no way
// forward. The caller resolves `who` first, then CAS's pending_approval -> approved, then calls
// executeChangeSet — so a resolution failure simply leaves the change-set pending_approval
// (retryable), never stuck mid-execution.
// Final whole-branch review Minor: `channel` records which approval surface actually decided this
// change-set, so the per-item changeset.execute audit rows below reflect reality instead of the
// hardcoded 'confirm-page' every branch used to write regardless of caller. Defaults to
// 'confirm_page' semantics (via clientInfoFor's fallback) for any pre-existing direct caller that
// doesn't pass it — see clientInfoFor below.
export interface ExecutorIdentity { accessToken: string; userLabel: string; modifyUser: string; sessionId: string; channel?: 'panel' | 'confirm_page' }

// Same channel->label mapping as confirmService.ts's clientInfoPrefix, but for the PER-ITEM
// changeset.execute audit rows (as opposed to confirmService's single changeset.approve decision
// row) — intentionally a DIFFERENT literal ('app-panel', not 'panel') so the two audit surfaces
// stay visually distinguishable when scanning audit_log by clientInfo.
function clientInfoFor(who: ExecutorIdentity): string { return who.channel === 'panel' ? 'app-panel' : 'confirm-page' }

export async function executeChangeSet(deps: ExecutorDeps, changesetId: string, who: ExecutorIdentity): Promise<{ status: 'done' | 'partial' | 'failed'; results: ItemResult[] }> {
  const rec = deps.changeSets.get(changesetId)
  if (!rec) throw new AppError('NOT_FOUND', 'change-set not found', 404)
  if (rec.status !== 'approved') throw new AppError('BAD_STATE', `change-set is ${rec.status}, not approved`, 409)
  deps.changeSets.setStatus(changesetId, 'executing')
  const mod = getModule(rec.actionType)
  const tracer = trace.getTracer('be2-mcp')
  const ctx: ExecCtx = {
    gateway: deps.gateway, accessToken: who.accessToken, modifyUser: who.modifyUser,
    userLabel: who.userLabel, sessionId: who.sessionId, channel: who.channel, now: deps.now,
    span: (name, fn) => tracer.startActiveSpan(name, async span => {
      try { return await fn(span.spanContext().traceId) } finally { span.end() }
    }),
  }
  let results: ItemResult[]
  try {
    results = await mod.execute(ctx, rec)
  } catch (e) {
    // 整批兜底（與現行三個 batch 分支的 .catch 等價）：每 item 一筆 failed
    results = rec.items.map(it => ({
      item_key: mod.itemKey(it), status: 'failed' as const,
      error_code: 'EXEC_ERROR', error_message: (e as Error).message, trace_id: 'n/a',
    }))
  }
  deps.changeSets.recordResults(changesetId, results)
  for (const r of results) {
    deps.audit.record({
      userLabel: who.userLabel, sessionId: who.sessionId, clientInfo: clientInfoFor(who), tool: 'changeset.execute',
      params: { changeset_id: changesetId, item: r.item_key },
      status: (r.status === 'done' || r.status === 'skipped_noop') ? 'ok' : 'error',
      errorMessage: r.error_message, traceId: r.trace_id, durationMs: 0,
    })
  }
  const status = results.every(r => r.status === 'done' || r.status === 'skipped_noop') ? 'done'
    : results.every(r => r.status === 'failed') ? 'failed' : 'partial'
  deps.changeSets.setStatus(changesetId, status, deps.now())
  return { status, results }
}

// Exported for src/changeset/confirmService.ts (Task 11): the panel's confirmed_keys validation
// needs the SAME key rule the executor itself groups/reports results by, so a panel "uncheck an
// item" check can never silently disagree with what the executor considers one item.
export function itemKey(it: ChangeSetItem): string {
  return it.pkg_oid ? `${it.prod_oid}:${it.pkg_oid}` : it.prod_oid
}
