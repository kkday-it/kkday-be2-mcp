// tests/ui/batchWizard.test.ts — Task 7 (.superpowers/sdd/task-7-brief.md).
//
// Fidelity note (documented deviation from the literal launcherHarness.ts technique): that
// harness extracts the built HTML's inline <script> and eval's it via `new Function`, which works
// for the /confirm/login and /oauth/authorize launcher pages because those are plain
// window.postMessage/fetch scripts with no MCP dependency. src/ui/batch-wizard.ts (like the
// existing changeset-panel.ts/products-panel.ts) is an MCP Apps panel built on
// `@modelcontextprotocol/ext-apps`'s `App` class, whose `connect()` performs a real
// `ui/initialize` JSON-RPC handshake over `window.postMessage` with the host on the other end of
// the iframe. Faithfully replaying that handshake here would mean hand-building a fake MCP host
// (message-transport framing, request/response id matching, ResizeObserver/requestAnimationFrame
// stubs for the App class's autoResize) — infrastructure disproportionate to this panel's test
// needs and not attempted anywhere else in this repo (panel.smoke.test.ts's own comment: "面板目前
// 只有...沒有 DOM 行為測試" for the exact same reason).
//
// Same spirit, adapted mechanism: src/ui/batch-wizard.ts exports `initWizard(app)` — the exact
// same closure body that `connectApp('be2-batch-wizard').then(initWizard)` would run in
// production — as a directly callable entry point that takes a duck-typed `WizardApp` (just
// `callServerTool` + `ontoolresult`, the only two App members this panel touches). That IS "stub
// app.callServerTool" from the brief, just injected as a parameter instead of intercepted at the
// transport layer. `document` is stubbed via tests/ui/fakeDom.ts (same "hand-roll only what's
// used" philosophy as launcherHarness.ts's own `el()`/FakeElement). The real bundled HTML/JS
// artifact is still produced and sanity-checked by tests/ui/panel.smoke.test.ts (build-string
// assertions), so the actual `npm run build:ui` output is not left unverified.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDocument, type FakeElement } from './fakeDom.js'

const doc = createFakeDocument()
vi.stubGlobal('document', doc)
// initWizard's bootstrap guard (`typeof window !== 'undefined'`) keeps the real
// connectApp()/MCP-transport path from running under this document-only stub — see the guard's
// comment in src/ui/batch-wizard.ts for why.

const { initWizard, toReserveDateUtc } = await import('../../src/ui/batch-wizard.js')

interface ToolCall { name: string; arguments: Record<string, unknown> }

function makeFakeApp(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: ToolCall[] = []
  let launch: ((params: { structuredContent?: unknown }) => void) | undefined
  const app = {
    get ontoolresult() { return launch },
    set ontoolresult(fn: ((params: { structuredContent?: unknown }) => void) | undefined) { launch = fn },
    async callServerTool({ name, arguments: args }: ToolCall) {
      calls.push({ name, arguments: args })
      const h = handlers[name]
      if (!h) throw new Error(`no handler stubbed for tool ${name}`)
      const structuredContent = await h(args)
      return { structuredContent }
    },
  }
  return {
    app,
    calls,
    fireLaunch(actionType: string, prodOids: string[]) {
      launch!({ structuredContent: { items: [{ action_type: actionType, prod_oids: prodOids }], errors: [], read_oids: [] } })
    },
  }
}

function envelope(items: unknown[], errors: unknown[] = []) { return { items, errors, read_oids: [] } }

// Flush pending microtasks (chained awaits inside doNext/doApprove — create-then-view is two
// sequential `await app.callServerTool(...)` calls, each itself awaiting a resolved value inside
// the fake app, so a handful of bare `await Promise.resolve()` isn't reliably enough ticks; a
// macrotask boundary drains everything queued so far).
function flush(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)) }

function findByRole(root: FakeElement, role: string): FakeElement {
  const found = root.querySelectorAll(`[data-role=${role}]`)[0]
  if (!found) throw new Error(`no element with data-role=${role}`)
  return found
}
function checkboxesFor(root: FakeElement, dataAttr: string, value: string): FakeElement[] {
  return root.querySelectorAll(`input[type=checkbox][data-${dataAttr}=${value}]`)
}

describe('toReserveDateUtc (pure UTC conversion, brief §UTC 轉換)', () => {
  it('converts 2026-08-20 10:00 Asia/Taipei -> 2026-08-20 02:00:00 UTC (brief test value, verbatim)', () => {
    expect(toReserveDateUtc('2026-08-20', 10, 0, 'Asia/Taipei')).toBe('2026-08-20 02:00:00')
  })
  it('Asia/Tokyo (+9) and UTC (+0) offsets', () => {
    expect(toReserveDateUtc('2026-08-20', 10, 0, 'Asia/Tokyo')).toBe('2026-08-20 01:00:00')
    expect(toReserveDateUtc('2026-08-20', 10, 0, 'UTC')).toBe('2026-08-20 10:00:00')
  })
})

describe('batch-wizard panel: inventory_platform flow', () => {
  const wizardEl = doc.getElementById('wizard')
  beforeEach(() => { wizardEl.children.length = 0 })

  it('load -> check 2 plans (sibling auto-included) -> next -> approve, asserting the full callServerTool sequence + payloads', async () => {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P1', name: '商品1', plans: [
          { pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' },
          { pkg_oid: 'B', name: '方案B', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }, // sibling: same item_oid+supplier_oid as A
          { pkg_oid: 'C', name: '方案C', item_oid: 'I2', supplier_oid: 'S2', current_platform: 'BE2' }, // unrelated
        ],
      }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-1' }])
    const viewResult = envelope([{
      changeset_id: 'cs-1', status: 'pending_approval', nonce: 'nonce-xyz', diff_version: 'dv-1',
      diff: { items: [{ item_oid: 'I1', supplier_oid: 'S1', current: 'BE2', target: 'BE2_SCM', noop: false, affected_pkgs: [{ prod_oid: 'P1', pkg_oid: 'A', pkg_name: '方案A' }, { prod_oid: 'P1', pkg_oid: 'B', pkg_name: '方案B' }] }] },
    }])
    const confirmResult = envelope([{ changeset_id: 'cs-1', status: 'done', results: [{ item_key: 'I1:S1', status: 'done', trace_id: 't1' }] }])

    const { app, calls, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => viewResult,
      app_confirm_changeset: () => confirmResult,
    })

    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])

    // Step 1: load
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    expect(calls[0]).toEqual({ name: 'app_get_batch_view', arguments: { action_type: 'inventory_platform', prod_oids: ['P1'] } })

    // Check plan A only -> sibling B (same item_oid+supplier_oid) auto-checked.
    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    const cbB = checkboxesFor(wizardEl, 'pkg-oid', 'B')[0]
    const cbC = checkboxesFor(wizardEl, 'pkg-oid', 'C')[0]
    cbA.checked = true
    cbA.onclick!()
    expect(cbB.checked).toBe(true) // brief: 勾選時自動勾同 item 兄弟方案
    expect(cbC.checked).toBe(false)

    // Pick target platform radio.
    const radios = wizardEl.querySelectorAll('input[type=radio][name=target]')
    const scmRadio = radios.find(r => r.value === 'BE2_SCM')!
    scmRadio.checked = true

    // Step 1 -> 2: next
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()

    expect(calls[1].name).toBe('app_create_changeset')
    expect(calls[1].arguments.action_type).toBe('inventory_platform')
    expect(calls[1].arguments.items).toEqual([{
      item_oid: 'I1', supplier_oid: 'S1', target: 'BE2_SCM',
      affected_pkgs: [{ prod_oid: 'P1', pkg_oid: 'A', pkg_name: '方案A' }, { prod_oid: 'P1', pkg_oid: 'B', pkg_name: '方案B' }],
    }]) // brief: 勾選兄弟方案自動帶入 affected_pkgs

    expect(calls[2]).toEqual({ name: 'app_get_changeset_view', arguments: { changeset_id: 'cs-1' } })
    expect(calls.length).toBe(3) // batch_view -> create -> view, no more (brief's required sequence)

    // Step 2 -> 3
    findByRole(wizardEl, 'toApproveBtn').onclick!()

    // Step 3: approve. nonce/diff_version must be exactly what app_get_changeset_view returned —
    // the model never sees these (spike T6); only the panel, via this view call, can.
    findByRole(wizardEl, 'approveBtn').onclick!()
    await flush()

    expect(calls[3]).toEqual({
      name: 'app_confirm_changeset',
      arguments: { changeset_id: 'cs-1', decision: 'approve', nonce: 'nonce-xyz', diff_version: 'dv-1', confirmed_keys: ['I1:S1'] },
    })

    // Step 4: ledger rendered.
    const resultRows = wizardEl.querySelectorAll('[data-item-key]')
    expect(resultRows.length).toBe(1)
    expect(resultRows[0].dataset.status).toBe('done')
  })

  // Shared fixture for the sibling-sync / filter regression tests below: plans A+B share the
  // write unit (I1,S1); X is the review-finding case — SAME item_oid I1 but a DIFFERENT
  // supplier S9, i.e. a different (item, supplier) write unit that must NOT be dragged in.
  async function loadPanel() {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P1', name: '商品1', plans: [
          { pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' },
          { pkg_oid: 'B', name: '方案B', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' },
          { pkg_oid: 'X', name: '方案X', item_oid: 'I1', supplier_oid: 'S9', current_platform: 'BE2' },
          { pkg_oid: 'C', name: '方案C', item_oid: 'I2', supplier_oid: 'S2', current_platform: 'BE2' },
        ],
      }],
    }])
    const { app, fireLaunch } = makeFakeApp({ app_get_batch_view: () => batchViewResult })
    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    return {
      cb: (pkg: string) => checkboxesFor(wizardEl, 'pkg-oid', pkg)[0],
      row: (pkg: string) => checkboxesFor(wizardEl, 'pkg-oid', pkg)[0].parentNode!,
      badge: (pkg: string) => checkboxesFor(wizardEl, 'pkg-oid', pkg)[0].parentNode!.querySelectorAll('[data-role=coBadge]')[0],
    }
  }

  it('review fix 1: 同 item、不同 supplier 不連動（寫入單位是 item×supplier，不能靜默擴大到未選 supplier）', async () => {
    const p = await loadPanel()
    p.cb('A').checked = true
    p.cb('A').onclick!()
    expect(p.cb('B').checked).toBe(true)  // same (I1,S1): co-selected
    expect(p.cb('X').checked).toBe(false) // same item I1 but supplier S9: must NOT be dragged in
    expect(p.cb('C').checked).toBe(false)
  })

  it('review fix 3: 取消勾選連動取消同 (item,supplier) 兄弟列並移除「將一併變更」標示（整組進/整組不進）', async () => {
    const p = await loadPanel()
    p.cb('A').checked = true
    p.cb('A').onclick!()
    expect(p.cb('B').checked).toBe(true)
    expect(p.badge('B').hidden).toBe(false) // co-change badge shown while co-selected

    p.cb('A').checked = false
    p.cb('A').onclick!()
    expect(p.cb('B').checked).toBe(false)  // whole write unit leaves together
    expect(p.badge('B').hidden).toBe(true) // badge removed — no stale "將一併變更" on an unchecked row

    // Symmetric direction: unchecking the auto-included sibling (B) must also release A.
    p.cb('A').checked = true
    p.cb('A').onclick!()
    p.cb('B').checked = false
    p.cb('B').onclick!()
    expect(p.cb('A').checked).toBe(false)
    expect(p.badge('A').hidden).toBe(true)
    expect(p.badge('B').hidden).toBe(true)
  })

  it('review fix 2: 「篩選方案…」即時過濾（比對方案名/pkg_oid）與「隱藏未勾選」toggle（spec §5.4）', async () => {
    const p = await loadPanel()
    const filter = findByRole(wizardEl, 'filterInput')

    // Filter by plan name substring.
    filter.value = '方案B'
    filter.oninput!()
    expect(p.row('A').hidden).toBe(true)
    expect(p.row('B').hidden).toBe(false)
    expect(p.row('X').hidden).toBe(true)
    expect(p.row('C').hidden).toBe(true)

    // Filter by pkg_oid.
    filter.value = 'C'
    filter.oninput!()
    expect(p.row('C').hidden).toBe(false)
    expect(p.row('A').hidden).toBe(true)

    // Clearing the filter restores all rows.
    filter.value = ''
    filter.oninput!()
    for (const k of ['A', 'B', 'X', 'C']) expect(p.row(k).hidden).toBe(false)

    // Hide-unchecked toggle: only checked rows stay visible; toggling again restores all.
    p.cb('C').checked = true
    p.cb('C').onclick!()
    const toggle = findByRole(wizardEl, 'hideUncheckedBtn')
    toggle.onclick!()
    expect(p.row('C').hidden).toBe(false)
    expect(p.row('A').hidden).toBe(true)
    expect(p.row('B').hidden).toBe(true)
    expect(p.row('X').hidden).toBe(true)
    toggle.onclick!()
    for (const k of ['A', 'B', 'X', 'C']) expect(p.row(k).hidden).toBe(false)

    // Filter AND hide-unchecked compose (both conditions must hold to stay visible).
    filter.value = '方案'
    filter.oninput!()
    toggle.onclick!()
    expect(p.row('C').hidden).toBe(false) // matches filter + checked
    expect(p.row('A').hidden).toBe(true)  // matches filter but unchecked
  })
})

describe('batch-wizard panel: shelf_schedule flow', () => {
  const wizardEl = doc.getElementById('wizard')
  beforeEach(() => { wizardEl.children.length = 0 })

  it('bundle rows are disabled; "套用到所有已勾選" applies the UTC-converted time to every checked row', async () => {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P2', name: '商品2', plans: [
          { pkg_oid: 'D', name: '方案D', is_bundle: false, reserve_queue: [] },
          { pkg_oid: 'E', name: '方案E(bundle)', is_bundle: true, reserve_queue: [] },
        ],
      }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-2' }])
    const viewResult = envelope([{ changeset_id: 'cs-2', status: 'pending_approval', nonce: 'n2', diff_version: 'dv-2', diff: { items: [] } }])

    const { app, calls, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => viewResult,
    })

    initWizard(app as never)
    fireLaunch('shelf_schedule', ['P2'])

    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    const cbD = checkboxesFor(wizardEl, 'pkg-oid', 'D')[0]
    const cbE = checkboxesFor(wizardEl, 'pkg-oid', 'E')[0]
    expect(cbE.disabled).toBe(true) // brief: bundle 列 disabled

    cbD.checked = true

    ;(findByRole(wizardEl, 'defDate') as FakeElement).value = '2026-08-20'
    ;(findByRole(wizardEl, 'defHour') as FakeElement).value = '10'
    ;(findByRole(wizardEl, 'defMinute') as FakeElement).value = '0'
    ;(findByRole(wizardEl, 'defTz') as FakeElement).value = 'Asia/Taipei'
    ;(findByRole(wizardEl, 'defStatus') as FakeElement).value = 'true'
    findByRole(wizardEl, 'applyAllBtn').onclick!()

    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()

    expect(calls[1].name).toBe('app_create_changeset')
    expect(calls[1].arguments.items).toEqual([{
      prod_oid: 'P2', pkg_oid: 'D',
      queue: [{ reserve_date_utc: '2026-08-20 02:00:00', reserve_status: true }], // brief's UTC test value
    }])
  })
})
