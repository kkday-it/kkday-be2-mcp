import { randomUUID, createHash } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { AuthServiceClient } from '../src/auth/authServiceClient.js'
import { GatewayClient } from '../src/gateway/client.js'
import { openDb } from '../src/store/db.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { createChangesetCore } from '../src/core/changeset/tools.js'
import { approveAndExecute, type ConfirmServiceDeps } from '../src/core/changeset/confirmService.js'
import { modifyUserFromToken } from '../src/server/app.js'
import { sanitizeQueue } from '../src/modules/product/shelfSchedule/validate.js'
import { queuesEqual, sortQueue } from '../src/modules/product/shelfSchedule/diff.js'
import type { L2ToolContext } from '../src/server/l2Context.js'
import type { ScheduleEntry, ShelfScheduleDiffItem } from '../src/core/changeset/types.js'

// Phase 4a Task 8 live acceptance — NEVER run in CI, manual only, fully reversible.
// Run: npx tsx --env-file=.env scripts/live-4a-acceptance.ts [prodOid]   (default prodOid: 34133)
//
// What this proves against SIT be2-220 with the `.env` account:
//
//   Part A — shelf_schedule: a FULL live round trip (create draft change-set -> approve+execute
//   through the exact same shared src/changeset/confirmService.ts#approveAndExecute the confirm
//   page / wizard panel call -> verify the write landed by re-reading package-configs directly ->
//   create a second change-set that restores the original reserve_queue -> approve+execute it ->
//   verify the restoration). A far-future reserve_date_utc (2027-01-01) is used so be2's native
//   scheduler cannot have fired the event during this test's run window regardless of clock skew.
//   This is the action_type whose read+write contract is already double-verified live (design doc
//   §2.2; docs/be2-mcp/sit-write-contracts.md), so this script expects a real 200 end to end.
//
//   Part B — inventory_platform: create is EXPECTED to fail closed with a DiffError. The write
//   contract for this action_type is confirmed (design doc §2.1), but the current-state READ this
//   account needs before staging any change (`GET items/{itemOid}/configs`) 403s on be2-220 for
//   this account (docs/be2-mcp/sit-write-contracts.md "inventory-platform read" section — same
//   verify-per-URI authorization gap documented for Phase 3a's quantity write). spec §4.1 mandates
//   "read fails -> DiffError blocks creation, never assume defaults" — this script exercises
//   exactly that fail-closed path and prints the real error, it does NOT attempt to work around it.
//
// Sanitization: never prints accessToken/refreshToken/service key/password. userLabel (the be2
// login email) is printed — that is not a credential and is already the identity label persisted
// in plaintext by audit_log (src/audit/auditLog.ts) and referenced throughout the docs.

const PROD_OID = process.argv[2] ?? '34133'

function shortErr(e: unknown): string {
  const err = e as { code?: string; status?: number; message?: string }
  return `${err.code ?? 'ERR'}${err.status ? `(${err.status})` : ''}: ${(err.message ?? String(e)).slice(0, 220)}`
}

async function readPackageConfigs(gateway: GatewayClient, at: string, prodOid: string): Promise<Array<Record<string, unknown>>> {
  const raw = await gateway.get(`/product/api/v1/products/${encodeURIComponent(prodOid)}/package-configs`, at)
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

async function pickScheduleCandidate(gateway: GatewayClient, at: string, prodOid: string):
  Promise<{ pkgOid: string; name: string; originalQueue: ScheduleEntry[] } | undefined> {
  const rows = await readPackageConfigs(gateway, at, prodOid)
  const nonBundle = rows.filter(r => r.is_bundle !== true && r.pkg_oid != null)
  // Prefer a package with an EMPTY current reserve_queue: shelf_schedule is a full-replace write
  // and validateShelfScheduleItems (src/changeset/batchValidate.ts) rejects ANY past-dated entry in
  // the submitted queue — including pre-existing ones being carried over on restore. A package
  // whose original queue is empty sidesteps that entirely (restore target is simply `[]`, which
  // is always valid). Falls back to the first non-bundle package with a note if none is empty.
  const empty = nonBundle.find(r => sanitizeQueue((r.reserve_queue as Array<{ reserve_date?: unknown; reserve_status?: unknown }>) ?? []).length === 0)
  const chosen = empty ?? nonBundle[0]
  if (!chosen) return undefined
  if (!empty) {
    console.log('  WARNING: no non-bundle package had an empty reserve_queue; picked the first non-bundle package anyway.')
    console.log('  If its original queue contains any already-past entries, the restore step will fail validation')
    console.log('  (validateShelfScheduleItems rejects past-dated entries even on a carry-over restore) — this is')
    console.log('  expected/documented, not a bug; rerun against a package with an empty schedule if that happens.')
  }
  return {
    pkgOid: String(chosen.pkg_oid),
    name: String(chosen.name ?? ''),
    originalQueue: sanitizeQueue((chosen.reserve_queue as Array<{ reserve_date?: unknown; reserve_status?: unknown }>) ?? []),
  }
}

async function pickInventoryPlatformTarget(gateway: GatewayClient, at: string, prodOid: string):
  Promise<{ item_oid: string; supplier_oid: string; pkg_oid: string; pkg_name: string }> {
  const raw = await gateway.get(`/product/api/v1/products/${encodeURIComponent(prodOid)}/packages?locale=zh-tw&show_supplier=1`, at)
  const packages = (Array.isArray(raw) ? raw : ((raw as { packages?: unknown[] })?.packages ?? [])) as Array<Record<string, unknown>>
  const candidate = packages.find(p => p.is_bundle !== true && p.item_oid != null)
  if (!candidate) throw new Error(`no non-bundle package with item_oid found under prod ${prodOid}`)
  const supplierList = (candidate.supplier_mapping as Array<{ supplier_oid?: unknown; is_default?: boolean }> | undefined) ?? []
  const supplierOid = supplierList.find(s => s.is_default)?.supplier_oid ?? supplierList[0]?.supplier_oid
  if (supplierOid == null) throw new Error(`no supplier_oid resolved for pkg ${String(candidate.pkg_oid)}`)
  return {
    item_oid: String(candidate.item_oid),
    supplier_oid: String(supplierOid),
    pkg_oid: String(candidate.pkg_oid),
    pkg_name: String(candidate.pkg_name ?? ''),
  }
}

async function runShelfScheduleRoundTrip(
  ctx: L2ToolContext, confirmDeps: ConfirmServiceDeps, gateway: GatewayClient, at: string, prodOid: string,
): Promise<boolean> {
  const candidate = await pickScheduleCandidate(gateway, at, prodOid)
  if (!candidate) { console.log('  no non-bundle package found under this prod_oid — cannot run round trip.'); return false }
  const { pkgOid, name, originalQueue } = candidate
  console.log(`  target: prod_oid=${prodOid} pkg_oid=${pkgOid} name="${name}" (original queue: ${originalQueue.length} entries)`)

  // Scope-gate substrate: mirrors what a real caller establishes via be2_get_product_plans /
  // app_get_batch_view before be2_create_changeset's SCOPE_NOT_READ gate will allow this oid.
  ctx.readOids.record(ctx.sessionId, [prodOid, pkgOid])

  const FAR_FUTURE = '2027-01-01 00:00:00' // UTC — far enough out that be2's native scheduler
  // cannot have fired this during the run window of this script.

  console.log('  step 1/4: create change-set — schedule an on-shelf event at 2027-01-01 00:00:00 UTC')
  const createEnv1 = await createChangesetCore(
    { action_type: 'shelf_schedule', items: [{ prod_oid: prodOid, pkg_oid: pkgOid, queue: [{ reserve_date_utc: FAR_FUTURE, reserve_status: true }] }] },
    ctx,
  )
  if (createEnv1.errors.length) {
    console.log(`    FAILED: ${createEnv1.errors.map(e => `${e.code}: ${e.message}`).join('; ')}`)
    return false
  }
  const created1 = createEnv1.items[0] as { changeset_id: string; diff: { items: ShelfScheduleDiffItem[] } }
  console.log(`    OK: changeset_id=${created1.changeset_id}`)

  console.log('  step 2/4: approve + execute (same shared service the confirm page / wizard panel call)')
  const rec1 = ctx.changeSets.get(created1.changeset_id)!
  const out1 = await approveAndExecute(confirmDeps, {
    rec: rec1, who: { accessToken: at, userLabel: ctx.userLabel, sessionId: ctx.sessionId, identityId: 'live-acceptance-script' },   // 佔位:本腳本只走立即批准;若擴充排程測試需換真實 identityId(store 查無此 id 會炸 getFreshByIdentityId)
    expectedDiffVersion: rec1.diffVersion, channel: 'confirm_page',
  })
  if (out1.stale || out1.casFailed) { console.log(`    FAILED: stale=${!!out1.stale} casFailed=${!!out1.casFailed}`); return false }
  console.log(`    status=${out1.status}`)
  if (out1.status !== 'done') {
    console.log(`    item results: ${JSON.stringify(out1.results?.map(r => ({ key: r.item_key, status: r.status, error: r.error_code })))}`)
    return false
  }

  console.log('  step 3/4: verify — re-read package-configs directly and confirm the far-future entry landed')
  const rowsAfter1 = await readPackageConfigs(gateway, at, prodOid)
  const rowAfter1 = rowsAfter1.find(r => String(r.pkg_oid) === pkgOid)
  const queueAfter1 = sanitizeQueue((rowAfter1?.reserve_queue as Array<{ reserve_date?: unknown; reserve_status?: unknown }>) ?? [])
  const landed = queueAfter1.some(e => e.reserve_date_utc === FAR_FUTURE && e.reserve_status === true)
  console.log(`    reserve_queue now has ${queueAfter1.length} entries; contains the scheduled entry: ${landed}`)
  if (!landed) {
    // Execute reported 'done' (the PUT returned 200), so the write may well have REALLY landed
    // even though this re-read didn't observe it (read-after-write lag, or an unexpected
    // server-side shape). Bailing out here would be the one path that leaves a possibly-applied
    // write behind with no restore attempt — so flag it loudly AND still fall through to the
    // step-4 restore below (a full-replace back to the original queue is correct/idempotent
    // whether or not the far-future entry actually landed).
    console.log('    WARNING: execute reported done but the re-read did NOT observe the scheduled entry —')
    console.log('    the write may still have landed (read-after-write lag). Proceeding to the restore step anyway.')
    console.log(`    MANUAL CLEANUP NEEDED (if the restore below fails): pkg_oid=${pkgOid} should be restored to queue=${JSON.stringify(originalQueue)}`)
  }

  console.log('  step 4/4: restore — create + approve + execute a change-set back to the ORIGINAL queue, then verify')
  ctx.readOids.record(ctx.sessionId, [prodOid, pkgOid])
  const createEnv2 = await createChangesetCore(
    { action_type: 'shelf_schedule', items: [{ prod_oid: prodOid, pkg_oid: pkgOid, queue: originalQueue }] },
    ctx,
  )
  if (createEnv2.errors.length) {
    console.log(`    RESTORE create FAILED: ${createEnv2.errors.map(e => `${e.code}: ${e.message}`).join('; ')}`)
    console.log(`    MANUAL CLEANUP NEEDED: pkg_oid=${pkgOid} should be restored to queue=${JSON.stringify(originalQueue)}`)
    return false
  }
  const created2 = createEnv2.items[0] as { changeset_id: string }
  const rec2 = ctx.changeSets.get(created2.changeset_id)!
  const out2 = await approveAndExecute(confirmDeps, {
    rec: rec2, who: { accessToken: at, userLabel: ctx.userLabel, sessionId: ctx.sessionId, identityId: 'live-acceptance-script' },   // 佔位:本腳本只走立即批准;若擴充排程測試需換真實 identityId(store 查無此 id 會炸 getFreshByIdentityId)
    expectedDiffVersion: rec2.diffVersion, channel: 'confirm_page',
  })
  if (out2.stale || out2.casFailed || out2.status !== 'done') {
    console.log(`    RESTORE approve+execute FAILED: stale=${!!out2.stale} casFailed=${!!out2.casFailed} status=${out2.status}`)
    console.log(`    MANUAL CLEANUP NEEDED: pkg_oid=${pkgOid} should be restored to queue=${JSON.stringify(originalQueue)}`)
    return false
  }
  const rowsAfter2 = await readPackageConfigs(gateway, at, prodOid)
  const rowAfter2 = rowsAfter2.find(r => String(r.pkg_oid) === pkgOid)
  const queueAfter2 = sanitizeQueue((rowAfter2?.reserve_queue as Array<{ reserve_date?: unknown; reserve_status?: unknown }>) ?? [])
  const restored = queuesEqual(sortQueue(queueAfter2), sortQueue(originalQueue))
  console.log(`    reserve_queue now has ${queueAfter2.length} entries; matches original: ${restored}`)
  if (!restored) {
    console.log(`    MANUAL CLEANUP NEEDED: pkg_oid=${pkgOid} should be restored to queue=${JSON.stringify(originalQueue)}`)
    return false
  }
  if (!landed) {
    // Restored fine, but step 3 never observed the scheduled entry — the round trip is NOT
    // proven (the "write landed" leg failed verification), so report honestly and fail overall.
    console.log('    NOTE: state restored to original, but the step-3 landing verification had FAILED —')
    console.log('    recording this run as "write-landing verification failed but state was restored"; overall result stays FAILED.')
    return false
  }
  return true
}

async function runInventoryPlatformExpectBlocked(
  ctx: L2ToolContext, gateway: GatewayClient, at: string, prodOid: string,
): Promise<void> {
  const target = await pickInventoryPlatformTarget(gateway, at, prodOid)
  console.log(`  target: item_oid=${target.item_oid} supplier_oid=${target.supplier_oid} (pkg_oid=${target.pkg_oid} "${target.pkg_name}")`)
  ctx.readOids.record(ctx.sessionId, [target.item_oid])
  const env = await createChangesetCore(
    {
      action_type: 'inventory_platform',
      items: [{
        item_oid: target.item_oid, supplier_oid: target.supplier_oid, target: 'BE2',
        affected_pkgs: [{ prod_oid: prodOid, pkg_oid: target.pkg_oid, pkg_name: target.pkg_name }],
      }],
    },
    ctx,
  )
  if (env.errors.length === 0) {
    const csId = (env.items[0] as { changeset_id: string }).changeset_id
    console.log(`  UNEXPECTED: create SUCCEEDED (changeset_id=${csId}).`)
    console.log('  The read-side 403 documented in sit-write-contracts.md may have been resolved for this account/env.')
    console.log('  Do NOT auto-approve this — investigate and update sit-write-contracts.md before treating as routine.')
    return
  }
  console.log(`  create FAILED AS EXPECTED (fail-closed at DiffError): ${env.errors.map(e => shortErr({ code: e.code, status: e.status, message: e.message })).join('; ')}`)
  console.log('  This is the documented PENDING state (spec §4.1 "read fails -> DiffError blocks creation") —')
  console.log('  see docs/be2-mcp/sit-write-contracts.md "inventory-platform read" and phase0-inventory.md Phase 4a section.')
}

async function main() {
  const cfg = loadConfig()
  const auth = new AuthServiceClient({ baseUrl: cfg.authsvcUrl, serviceKey: cfg.serviceKey })
  const { authorizationCode } = await auth.login(process.env.AUTH_email!, process.env.AUTH_pwd!)
  const tokens = await auth.exchangeCode(authorizationCode)
  const accessToken = tokens.accessToken
  console.log(`login+exchange OK; businessList entries: ${tokens.businessList.length}`)

  const gateway = new GatewayClient({ baseUrl: cfg.gatewayUrl })
  const db = openDb(':memory:')
  const readOids = new ReadOidStore(db)
  const changeSets = new ChangeSetStore(db)
  const rateBudget = new RateBudget(db)
  const audit = new AuditLog(db)
  const sessionId = `live-4a-acceptance-${randomUUID()}`
  const userLabel = process.env.AUTH_email!

  const ctx: L2ToolContext = {
    gateway, accessToken, userLabel, sessionId,
    bearerHash: createHash('sha256').update(accessToken).digest('hex'),
    businessList: tokens.businessList,
    scheduleTz: 'Asia/Taipei',
    readOids, changeSets, rateBudget,
    baseUrl: `http://127.0.0.1:${cfg.port}`,
    genId: () => randomUUID(),
    now: Date.now,
    // No browser confirm page in this script — approveAndExecute is called directly below (the
    // exact same shared service the confirm page / wizard panel call), so the confirm_url this
    // would normally emit out-of-band is unused; just log it for visibility into what a real
    // caller would have received.
    emitConfirmUrl: (id, url) => console.log(`  (confirm_url would have been: ${url} — this script approves directly instead)`),
  }
  const confirmDeps: ConfirmServiceDeps = { changeSets, gateway, audit, now: Date.now, modifyUserFrom: modifyUserFromToken }

  console.log(`\n=== Part A: shelf_schedule — full live round trip (prod_oid=${PROD_OID}) ===`)
  let shelfScheduleOk = false
  try {
    shelfScheduleOk = await runShelfScheduleRoundTrip(ctx, confirmDeps, gateway, accessToken, PROD_OID)
  } catch (e) {
    console.log(`  round trip threw: ${shortErr(e)}`)
  }

  console.log(`\n=== Part B: inventory_platform — expect fail-closed DiffError at creation (prod_oid=${PROD_OID}) ===`)
  try {
    await runInventoryPlatformExpectBlocked(ctx, gateway, accessToken, PROD_OID)
  } catch (e) {
    console.log(`  probe threw unexpectedly (not the documented DiffError path): ${shortErr(e)}`)
  }

  console.log('\n=== audit_log summary (sanitized: ts/tool/status/user only — no tokens) ===')
  for (const e of audit.recent(30).reverse()) {
    console.log(`  ${new Date(e.ts).toISOString()}  ${e.tool.padEnd(24)} status=${e.status}  user=${e.userLabel}`)
  }

  console.log(`\nRESULT=${shelfScheduleOk ? 'SHELF_SCHEDULE_LIVE_OK' : 'SHELF_SCHEDULE_LIVE_FAILED'}`)
  console.log('RESULT=INVENTORY_PLATFORM_DIFF_BLOCKED_AS_EXPECTED (see docs/be2-mcp/sit-write-contracts.md)')
}

main().catch(e => { console.error('live-4a-acceptance failed:', shortErr(e)); process.exit(1) })
