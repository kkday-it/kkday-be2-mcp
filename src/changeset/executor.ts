import { trace } from '@opentelemetry/api'
import type { ChangeSetStore } from './store.js'
import type { TokenManager } from '../auth/tokenManager.js'
import type { GatewayClient } from '../gateway/client.js'
import type { AuditLog } from '../audit/auditLog.js'
import type { ItemResult, ChangeSetItem } from './types.js'
import { AppError } from '../errors.js'

export interface ExecutorDeps {
  changeSets: ChangeSetStore; tokenManager: TokenManager; gateway: GatewayClient; audit: AuditLog
  modifyUserFrom: (accessToken: string) => string; now: () => number
}

export async function executeChangeSet(deps: ExecutorDeps, changesetId: string): Promise<{ status: 'done' | 'partial' | 'failed'; results: ItemResult[] }> {
  const rec = deps.changeSets.get(changesetId)
  if (!rec) throw new AppError('NOT_FOUND', 'change-set not found', 404)
  if (rec.status !== 'approved') throw new AppError('BAD_STATE', `change-set is ${rec.status}, not approved`, 409)
  deps.changeSets.setStatus(changesetId, 'executing')

  // Anything that throws AFTER we flip to 'executing' but BEFORE per-item results are recorded
  // (e.g. token refresh REAUTH_REQUIRED) would otherwise strand the change-set in 'executing'
  // forever. Guard: on early throw, mark it 'failed' (terminal, visible) and rethrow.
  let at: string, modifyUser: string
  try {
    const user = await deps.tokenManager.getFreshByHash(rec.creatorBearerHash)
    at = user.accessToken
    modifyUser = deps.modifyUserFrom(at)
  } catch (e) {
    deps.changeSets.setStatus(changesetId, 'failed', deps.now())
    deps.audit.record({
      userLabel: rec.creatorLabel, sessionId: rec.sessionId, clientInfo: 'confirm-page', tool: 'changeset.execute',
      params: { changeset_id: changesetId }, status: 'error', errorMessage: (e as Error).message, traceId: 'n/a', durationMs: 0,
    })
    throw e
  }
  const tracer = trace.getTracer('be2-mcp')

  const byOid = new Map<string, ChangeSetItem[]>()
  for (const it of rec.items) {
    const g = byOid.get(it.prod_oid) ?? []
    g.push(it)
    byOid.set(it.prod_oid, g)
  }

  const groups = [...byOid.entries()]
  const settled = await Promise.allSettled(groups.map(([oid, items]) =>
    tracer.startActiveSpan(`changeset.execute/${rec.actionType}`, async span => {
      const traceId = span.spanContext().traceId
      try {
        if (rec.actionType === 'shelf_toggle_product') {
          return await execProduct(deps, at, modifyUser, oid, items[0].target_is_active, traceId)
        }
        return await execPlan(deps, at, modifyUser, oid, items, traceId)
      } finally {
        span.end()
      }
    })))

  const results: ItemResult[] = []
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') results.push(...s.value)
    else results.push(...groups[i][1].map(it => ({
      item_key: itemKey(it), status: 'failed' as const, error_code: 'EXEC_ERROR',
      error_message: (s.reason as Error).message, trace_id: 'n/a',
    })))
  })
  deps.changeSets.recordResults(changesetId, results)
  for (const r of results) {
    deps.audit.record({
      userLabel: rec.creatorLabel, sessionId: rec.sessionId, clientInfo: 'confirm-page', tool: 'changeset.execute',
      params: { changeset_id: changesetId, item: r.item_key }, status: r.status === 'failed' ? 'error' : 'ok',
      errorMessage: r.error_message, traceId: r.trace_id, durationMs: 0,
    })
  }
  const status = results.every(r => r.status === 'done' || r.status === 'skipped_noop')
    ? 'done'
    : results.every(r => r.status === 'failed') ? 'failed' : 'partial'
  deps.changeSets.setStatus(changesetId, status, deps.now())
  return { status, results }
}

function itemKey(it: ChangeSetItem): string {
  return it.pkg_oid ? `${it.prod_oid}:${it.pkg_oid}` : it.prod_oid
}

// READ-ONLY fields that the write endpoint rejects (Task 1 SIT probe confirmed).
const SWITCH_READONLY = ['is_locked_for_active', 'updated_by', 'updated_at']

async function execProduct(deps: ExecutorDeps, at: string, modifyUser: string, oid: string, target: boolean, traceId: string): Promise<ItemResult[]> {
  const path = `/product/api/v1/product-configs/${encodeURIComponent(oid)}/switch`
  const before = await deps.gateway.get(path, at) as Record<string, unknown>
  if (before?.is_active === target) return [{ item_key: oid, status: 'skipped_noop', before, after: before, trace_id: traceId }]
  try {
    // read-merge-write: start from the FULL current object (preserve every writable field,
    // e.g. market_*), flip only is_active, drop confirmed read-only fields, add modify_user.
    const body: Record<string, unknown> = { ...before, is_active: target, modify_user: modifyUser }
    for (const k of SWITCH_READONLY) delete body[k]
    await deps.gateway.put(path, at, body)
    const after = await deps.gateway.get(path, at)
    return [{ item_key: oid, status: 'done', before, after, trace_id: traceId }]
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return [{ item_key: oid, status: 'failed', before, error_code: err.code, error_message: err.message, trace_id: traceId }]
  }
}

async function execPlan(deps: ExecutorDeps, at: string, modifyUser: string, oid: string, items: ChangeSetItem[], traceId: string): Promise<ItemResult[]> {
  const path = `/product/api/v1/products/${encodeURIComponent(oid)}/package-configs`
  const raw = await deps.gateway.get(path, at)
  // Preserve each pkg's FULL config object (not just is_active). config_data = { pkg_oid: {full object minus pkg_oid} }.
  const entries = configEntries(raw) // Array<[pkg_oid, fullObj]>
  const currentActive = new Map(entries.map(([k, o]) => [k, !!(o as Record<string, unknown>).is_active]))
  const targets = new Map(items.map(i => [i.pkg_oid!, i.target_is_active]))
  const before = Object.fromEntries(currentActive)
  const allNoop = items.every(i => currentActive.get(i.pkg_oid!) === i.target_is_active)
  if (allNoop) return items.map(i => ({ item_key: `${oid}:${i.pkg_oid}`, status: 'skipped_noop' as const, before, after: before, trace_id: traceId }))
  const config_data: Record<string, Record<string, unknown>> = {}
  for (const [pkg, obj] of entries) {
    const full = { ...(obj as Record<string, unknown>) }
    delete full.pkg_oid
    if (targets.has(pkg)) full.is_active = targets.get(pkg)! // flip ONLY the target; preserve everything else
    config_data[pkg] = full
  }
  try {
    await deps.gateway.put(path, at, { config_data, modify_user: modifyUser })
    const after = Object.fromEntries(configEntries(await deps.gateway.get(path, at)).map(([k, o]) => [k, !!(o as Record<string, unknown>).is_active]))
    return items.map(i => ({ item_key: `${oid}:${i.pkg_oid}`, status: 'done' as const, before, after, trace_id: traceId }))
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return items.map(i => ({ item_key: `${oid}:${i.pkg_oid}`, status: 'failed' as const, before, error_code: err.code, error_message: err.message, trace_id: traceId }))
  }
}

// Returns [pkg_oid, fullConfigObject] preserving ALL fields — handles both array and
// {config_data:{...}} shapes. NEVER strips fields (read-merge-write depends on this).
function configEntries(raw: unknown): Array<[string, unknown]> {
  const r = raw as Record<string, any>
  const cd = r?.config_data ?? r
  if (Array.isArray(cd)) return cd.filter(p => p?.pkg_oid != null).map(p => [String(p.pkg_oid), p])
  if (cd && typeof cd === 'object') return Object.entries(cd)
  return []
}
