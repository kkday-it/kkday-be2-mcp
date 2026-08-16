import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { approveAndExecute, type ConfirmServiceDeps } from '../src/core/changeset/confirmService.js'
import { computeChangesetDiff } from '../src/core/changeset/diff.js'
import { getModule } from '../src/core/changeset/registry.js'
import '../src/modules/index.js'
import type { ChangeSetRecord, InventoryItem } from '../src/core/changeset/types.js'

// Task 11 Finding 1: tests/appConfirm.test.ts only exercises a FAKE approveAndExecute (it stubs
// `ctx.approveAndExecute` directly), so the REAL confirmed_keys Set-equality gate inside
// src/changeset/confirmService.ts (itemKeysOf + validation, lines ~49-67) had zero coverage. These
// tests call the real exported `approveAndExecute` against a real ChangeSetStore/AuditLog (in-
// memory sqlite, same harness as tests/confirmRoutes*.test.ts) with a fake gateway, so the actual
// itemKeysOf + Set-equality code path is what runs.

const WHO = { accessToken: 'tok', userLabel: 'owner@kkday.com', sessionId: 's1' }

function makeDeps(gateway: { get: Function; put: Function }): { store: ChangeSetStore; audit: AuditLog; deps: ConfirmServiceDeps } {
  const db = openDb(':memory:')
  const store = new ChangeSetStore(db, { now: () => 1000 })
  const audit = new AuditLog(db, () => 1000)
  const deps: ConfirmServiceDeps = {
    changeSets: store, gateway: gateway as never, audit, now: () => 1000,
    modifyUserFrom: (at: string) => 'U:' + at,
  }
  return { store, audit, deps }
}

// --- shelf fixtures -------------------------------------------------------------------------

function seedShelf(store: ChangeSetStore, id: string): ChangeSetRecord {
  store.create({
    id, creatorLabel: WHO.userLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
    items: [{ prod_oid: 'p1', target_is_active: false }],
    // diff/diffVersion are placeholders — approveAndExecute always recomputes live (spec §4).
    diff: [], diffVersion: 'seed', status: 'pending_approval', createdAt: 1000,
  })
  return store.get(id)!
}

function shelfGateway(live: { is_active: boolean } = { is_active: true }) {
  return {
    live,
    async get(path: string) {
      if (path.includes('/info')) return { name: 'Prod A' }
      return { is_active: live.is_active }
    },
    async put(_path: string, _at: string, body: Record<string, unknown>) {
      live.is_active = body.is_active as boolean
      return {}
    },
  }
}

async function realShelfDiffVersion(rec: ChangeSetRecord, gw: ReturnType<typeof shelfGateway>): Promise<string> {
  const diff = await computeChangesetDiff(rec.actionType, rec.items, { gateway: gw as never, accessToken: WHO.accessToken, userLabel: rec.creatorLabel })
  return getModule(rec.actionType).diffVersion(diff)
}

// --- inventory fixtures ----------------------------------------------------------------------

function seedInventory(store: ChangeSetStore, id: string, items: InventoryItem[]): ChangeSetRecord {
  store.create({
    id, creatorLabel: WHO.userLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'inventory_setting',
    items, diff: [], diffVersion: 'seed', status: 'pending_approval', createdAt: 1000,
  })
  return store.get(id)!
}

// Mirrors tests/confirmRoutesInventory.test.ts's fakeGw, extended to key by (item_oid,
// supplier_oid) so a change-set with TWO items (needed for finding-1(d)'s item×supplier key
// coverage) is served correctly — execInventory processes rec.items sequentially (executor.ts),
// so tracking "which supplier was last GET-ed for this item" and using it on the matching PUT is
// safe (no overlap between items).
function invGateway(qty: Record<string, Record<string, number>>) {
  const lastSupplierForItem: Record<string, string> = {}
  return {
    qty,
    async get(path: string, _at: string, query?: Record<string, string>) {
      if (path.endsWith('/inventories/status')) return { is_processing: false }
      const m = /\/items\/([^/]+)\/inventories\/([^/]+)$/.exec(path)!
      const item = decodeURIComponent(m[1]); const supplier = decodeURIComponent(m[2])
      lastSupplierForItem[item] = supplier
      const key = `${item}:${supplier}`
      const ym = query!.year_month
      const map = qty[key] ?? {}
      return { itemInventory: Object.entries(map).filter(([d]) => d.startsWith(ym)).map(([date, quantity]) => ({ date, quantity })) }
    },
    async put(path: string, _at: string, body: Record<string, unknown>) {
      const m = /\/items\/([^/]+)\/inventories$/.exec(path)!
      const item = decodeURIComponent(m[1])
      const supplier = lastSupplierForItem[item]
      const key = `${item}:${supplier}`
      qty[key] = qty[key] ?? {}
      for (const row of (body.itemInventory as Array<{ date: string; quantity: number }>) ?? []) qty[key][row.date] = row.quantity
      return {}
    },
  }
}

async function realInventoryDiffVersion(rec: ChangeSetRecord, gw: ReturnType<typeof invGateway>): Promise<string> {
  const diff = await computeChangesetDiff(rec.actionType, rec.items, { gateway: gw as never, accessToken: WHO.accessToken, userLabel: rec.creatorLabel })
  return getModule(rec.actionType).diffVersion(diff)
}

describe('approveAndExecute — real confirmed_keys validation (Task 11 Finding 1)', () => {
  it('(a) confirmedKeys exactly matching the item-key set passes the gate (no CONFIRMED_KEYS_MISMATCH)', async () => {
    const gw = shelfGateway()
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-a')
    const version = await realShelfDiffVersion(rec, gw)
    const out = await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['p1'], channel: 'panel' })
    expect(out.stale).toBeUndefined()
    expect(out.casFailed).toBeUndefined()
    expect(out.status).toBeDefined()   // reached execution — the keys gate did not throw
  })

  it('(b) confirmedKeys with an EXTRA key not in the set throws CONFIRMED_KEYS_MISMATCH, does not execute', async () => {
    const gw = shelfGateway()
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-b')
    const version = await realShelfDiffVersion(rec, gw)
    await expect(approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['p1', 'p-extra'], channel: 'panel' }))
      .rejects.toMatchObject({ code: 'CONFIRMED_KEYS_MISMATCH' })
    expect(store.get('cs-b')!.status).toBe('pending_approval')   // untouched — never reached CAS
  })

  it('(c) confirmedKeys MISSING a key (user unchecked a high-risk item) throws CONFIRMED_KEYS_MISMATCH, does not execute', async () => {
    const gw = shelfGateway()
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-c')
    const version = await realShelfDiffVersion(rec, gw)
    await expect(approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: [], channel: 'panel' }))
      .rejects.toMatchObject({ code: 'CONFIRMED_KEYS_MISMATCH' })
    expect(store.get('cs-c')!.status).toBe('pending_approval')   // unchecking must NOT silently execute
  })

  it('(d) inventory change-set: item×supplier key rule — missing one of two keys throws, both present passes', async () => {
    const items: InventoryItem[] = [
      { item_oid: 'i1', supplier_oid: 's1', op: 'set', quantity: 10, dates: ['2026-08-15'] },
      { item_oid: 'i2', supplier_oid: 's2', op: 'set', quantity: 20, dates: ['2026-08-15'] },
    ]
    const qty = { 'i1:s1': { '2026-08-15': 5 }, 'i2:s2': { '2026-08-15': 7 } }

    // missing key: only i1's key present
    {
      const gw = invGateway(structuredClone(qty))
      const { store, deps } = makeDeps(gw)
      const rec = seedInventory(store, 'cs-d-missing', items)
      const version = await realInventoryDiffVersion(rec, gw)
      await expect(approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['i1:s1'], channel: 'panel' }))
        .rejects.toMatchObject({ code: 'CONFIRMED_KEYS_MISMATCH' })
      expect(store.get('cs-d-missing')!.status).toBe('pending_approval')
    }

    // both keys present: passes the gate
    {
      const gw = invGateway(structuredClone(qty))
      const { store, deps } = makeDeps(gw)
      const rec = seedInventory(store, 'cs-d-full', items)
      const version = await realInventoryDiffVersion(rec, gw)
      const out = await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['i1:s1', 'i2:s2'], channel: 'panel' })
      expect(out.stale).toBeUndefined()
      expect(out.casFailed).toBeUndefined()
      expect(out.status).toBeDefined()
    }
  })

  it('(f) inventory duplicate key: TWO items share (item_oid,supplier_oid) with disjoint dates — Set-equality bug vs multiset fix', async () => {
    // Task 12 review Finding 1: validateInventoryItems only enforces (item, supplier, date)
    // uniqueness — two items with the SAME (item_oid, supplier_oid) but disjoint `dates` are
    // legal and both collapse to the SAME rendered key `i1:s1` in the panel. Under Set-based
    // comparison, expected=[k,k] dedups to {k}; confirmedKeys=[k] (user unchecked ONE of the two
    // rows) also dedups to {k} — sizes match, contents match, the mismatch check never fires,
    // and the full batch (including the row the user tried to uncheck) executes. This test pins
    // the multiset fix: (b) below MUST throw CONFIRMED_KEYS_MISMATCH, which it would NOT under
    // the old Set logic (non-vacuous regression pin).
    const items: InventoryItem[] = [
      { item_oid: 'i1', supplier_oid: 's1', op: 'set', quantity: 10, dates: ['2026-08-15'] },
      { item_oid: 'i1', supplier_oid: 's1', op: 'set', quantity: 20, dates: ['2026-08-16'] },
    ]
    const qty = { 'i1:s1': { '2026-08-15': 5, '2026-08-16': 7 } }

    // (a) confirmed_keys = both keys ['i1:s1','i1:s1'] (both rows still checked) — passes the gate.
    {
      const gw = invGateway(structuredClone(qty))
      const { store, deps } = makeDeps(gw)
      const rec = seedInventory(store, 'cs-f-both', items)
      const version = await realInventoryDiffVersion(rec, gw)
      const out = await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['i1:s1', 'i1:s1'], channel: 'panel' })
      expect(out.stale).toBeUndefined()
      expect(out.casFailed).toBeUndefined()
      expect(out.status).toBeDefined()
    }

    // (b) confirmed_keys = ONE key ['i1:s1'] (user unchecked one of the two same-key rows) — must
    // throw CONFIRMED_KEYS_MISMATCH (reject the whole batch), not silently execute it.
    {
      const gw = invGateway(structuredClone(qty))
      const { store, deps } = makeDeps(gw)
      const rec = seedInventory(store, 'cs-f-one', items)
      const version = await realInventoryDiffVersion(rec, gw)
      await expect(approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['i1:s1'], channel: 'panel' }))
        .rejects.toMatchObject({ code: 'CONFIRMED_KEYS_MISMATCH' })
      expect(store.get('cs-f-one')!.status).toBe('pending_approval')   // untouched — never reached CAS
    }
  })

  it('(e) confirm_page channel never sends confirmedKeys — validation is skipped (existing whole-batch behavior)', async () => {
    const gw = shelfGateway()
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-e')
    const version = await realShelfDiffVersion(rec, gw)
    // no confirmedKeys field at all — must not throw CONFIRMED_KEYS_MISMATCH regardless of items.
    const out = await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, channel: 'confirm_page' })
    expect(out.stale).toBeUndefined()
    expect(out.casFailed).toBeUndefined()
    expect(out.status).toBeDefined()
  })
})

describe('approveAndExecute — stale diff write-back (final whole-branch review Important 2)', () => {
  // app_get_changeset_view (src/tools/appTools.ts) reads rec.diff/rec.diffVersion straight off the
  // store — it never recomputes. Before this fix, a DIFF_STALE result from approveAndExecute never
  // wrote anything back, so the panel's "reload the view" recovery had nothing fresher to read:
  // every reload would return the SAME stale diff_version forever and every re-approval attempt
  // would 're-detect' the exact same staleness — the panel could never converge. This pins that
  // approveAndExecute persists the live-recomputed diff/version into the store on the stale path,
  // so a subsequent store.get() (what app_get_changeset_view does) sees it.
  it('on stale detection, the recomputed diff+version is written back to the store', async () => {
    const gw = shelfGateway({ is_active: true })
    const { store, deps } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-stale-1')
    // Live drifted after seeding (seed's placeholder diffVersion 'seed' never matches a real hash).
    const out = await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: 'stale-version-from-a-stale-page', channel: 'confirm_page' })
    expect(out.stale).toBe(true)
    const stored = store.get('cs-stale-1')!
    expect(stored.status).toBe('pending_approval')   // not consumed — still approvable
    expect(stored.diffVersion).not.toBe('seed')
    expect(stored.diffVersion).not.toBe('stale-version-from-a-stale-page')
    // The freshly-stored version is exactly what a live recompute produces right now — i.e. it
    // converges: approving AGAIN with this stored version must succeed (not stale a second time).
    const version2 = await realShelfDiffVersion(store.get('cs-stale-1')!, gw)
    expect(stored.diffVersion).toBe(version2)
    const out2 = await approveAndExecute(deps, { rec: store.get('cs-stale-1')!, who: WHO, expectedDiffVersion: version2, channel: 'confirm_page' })
    expect(out2.stale).toBeUndefined()
    expect(out2.status).toBeDefined()
  })

  it('does NOT write back once the change-set has already left pending_approval (no resurrecting a decided change-set)', async () => {
    const gw = shelfGateway({ is_active: true })
    const { store, deps } = makeDeps(gw)
    seedShelf(store, 'cs-stale-2')
    store.setStatus('cs-stale-2', 'rejected')
    const rejectedRec = store.get('cs-stale-2')!
    const out = await approveAndExecute(deps, { rec: rejectedRec, who: WHO, expectedDiffVersion: 'whatever', channel: 'confirm_page' })
    expect(out.stale).toBe(true)   // version mismatch still detected/reported...
    expect(store.get('cs-stale-2')!.diffVersion).toBe(rejectedRec.diffVersion)   // ...but store.updateDiff no-ops: status is no longer pending_approval
  })
})

describe('approveAndExecute — audit clientInfo prefix (Task 11 Finding 3)', () => {
  it('confirm_page channel records the ORIGINAL pre-refactor "confirm-page:" (hyphen) prefix', async () => {
    const gw = shelfGateway()
    const { store, deps, audit } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-audit-page')
    const version = await realShelfDiffVersion(rec, gw)
    await approveAndExecute(deps, {
      rec, who: WHO, expectedDiffVersion: version, channel: 'confirm_page',
      audit: { clientInfo: 'Mozilla/5.0 test-agent' },
    })
    const row = audit.recent().find(r => r.tool === 'changeset.approve')!
    expect(row.clientInfo).toBe('confirm-page:Mozilla/5.0 test-agent')
  })

  it('panel channel records a "panel:" prefix', async () => {
    const gw = shelfGateway()
    const { store, deps, audit } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-audit-panel')
    const version = await realShelfDiffVersion(rec, gw)
    await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['p1'], channel: 'panel' })
    const row = audit.recent().find(r => r.tool === 'changeset.approve')!
    expect(row.clientInfo).toBe('panel:')
  })
})

describe('approveAndExecute — executor per-item audit clientInfo reflects the real approval channel (final whole-branch review Minor)', () => {
  // executor.ts's changeset.execute rows used to hardcode clientInfo: 'confirm-page' regardless of
  // which channel actually approved the change-set — a panel approval's per-item audit trail would
  // misleadingly read as if it went through the confirm page. approveAndExecute must thread the
  // real channel through to executeChangeSet so the per-item rows match reality.
  it('panel approval -> changeset.execute audit rows record clientInfo "app-panel"', async () => {
    const gw = shelfGateway()
    const { store, deps, audit } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-exec-panel')
    const version = await realShelfDiffVersion(rec, gw)
    await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, confirmedKeys: ['p1'], channel: 'panel' })
    const rows = audit.recent().filter(r => r.tool === 'changeset.execute')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.clientInfo).toBe('app-panel')
  })

  it('confirm_page approval -> changeset.execute audit rows record clientInfo "confirm-page" (unchanged default)', async () => {
    const gw = shelfGateway()
    const { store, deps, audit } = makeDeps(gw)
    const rec = seedShelf(store, 'cs-exec-page')
    const version = await realShelfDiffVersion(rec, gw)
    await approveAndExecute(deps, { rec, who: WHO, expectedDiffVersion: version, channel: 'confirm_page' })
    const rows = audit.recent().filter(r => r.tool === 'changeset.execute')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.clientInfo).toBe('confirm-page')
  })
})
