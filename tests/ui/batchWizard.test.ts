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
      const res = await h(args) as any
      if (res && res.__rawError) return { isError: true, content: res.content }
      return { structuredContent: res }
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

  it('platform mode: hides inactive rows by default, toggle shows them; row check reveals detail sub-row, radio updates preview, EXTERNAL warning toggles', async () => {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P1', name: '商品1', plans: [
          { pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', supplier_name: '供1', current_platform: 'BE2', is_active: true },
          { pkg_oid: 'B', name: '方案B', item_oid: 'I2', supplier_oid: 'S2', supplier_name: '供2', current_platform: 'BE2_SCM', is_active: false, inventory_mode: 'SKU依日期' }, // inactive
        ],
      }],
    }])
    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
    })

    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    // 1. Inactive hidden by default, toggle shows them
    const toggle = findByRole(wizardEl, 'showInactiveBtn')
    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    const cbB = checkboxesFor(wizardEl, 'pkg-oid', 'B')[0]
    const rowWrapA = cbA.parentNode!.parentNode!
    const rowWrapB = cbB.parentNode!.parentNode!

    expect(toggle.checked).toBe(false)
    expect(rowWrapA.hidden).toBe(false)
    expect(rowWrapB.hidden).toBe(true)

    toggle.checked = true
    toggle.onchange!()
    expect(rowWrapB.hidden).toBe(false)

    // 2. Checking a row inserts detail sub-row
    expect(wizardEl.querySelectorAll('.bw-detail-row').length).toBe(0)
    cbB.checked = true
    cbB.onclick!()
    
    let detailRows = wizardEl.querySelectorAll('.bw-detail-row')
    expect(detailRows.length).toBe(1)
    expect(detailRows[0].textContent).toContain('供應商: S2 供2')
    expect(detailRows[0].textContent).toContain('目前平台: BE2 / SCM 管理')
    expect(detailRows[0].textContent).toContain('→ BE2 管理')
    expect(detailRows[0].textContent).toContain('庫存模式: SKU依日期')

    // 3. Radio change updates preview
    const radios = wizardEl.querySelectorAll('input[type=radio][name=target]')
    const extRadio = radios.find(r => r.value === 'EXTERNAL')!
    extRadio.checked = true
    extRadio.onchange!()
    
    expect(detailRows[0].textContent).toContain('→ 串接外部庫存（包含 rezio）')

    const scmRadio = radios.find(r => r.value === 'BE2_SCM')!
    scmRadio.checked = true
    scmRadio.onchange!()
    // current is BE2_SCM, target is BE2_SCM -> show "(相同，將略過)"
    expect(detailRows[0].textContent).toContain('(相同，將略過)')

    // 4. EXTERNAL warning appears/disappears
    const extWarning = findByRole(wizardEl, 'extWarning')
    expect(extWarning.hidden).toBe(true)
    
    extRadio.checked = true
    extRadio.onchange!()
    expect(extWarning.hidden).toBe(false)
    expect(extWarning.textContent).toContain('串接外部庫存（B2D/B2S/rezio 等）開啟前請先與 IT 確認')

    scmRadio.checked = true
    scmRadio.onchange!()
    expect(extWarning.hidden).toBe(true)
    
    // Unchecking removes detail row
    cbB.checked = false
    cbB.onclick!()
    expect(wizardEl.querySelectorAll('.bw-detail-row').length).toBe(0)
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
      row: (pkg: string) => checkboxesFor(wizardEl, 'pkg-oid', pkg)[0].parentNode!.parentNode!,
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

describe('batch-wizard panel: DIFF_STALE recovery (final whole-branch review Important 2)', () => {
  const wizardEl = doc.getElementById('wizard')
  beforeEach(() => { wizardEl.children.length = 0 })

  // Before this fix, doApprove() on a DIFF_STALE error just called showFallback with a message and
  // stopped — there was no way for the panel itself to ever get back to a state where re-approving
  // could succeed (the user would have to close and reopen the whole wizard). This pins the new
  // "回檢視重載" button: it re-calls app_get_changeset_view (picking up the fresher diff_version +
  // nonce the server now writes back on staleness detection, see src/changeset/confirmService.ts)
  // and returns to step 2, from which the user can proceed to approve again — this time
  // successfully.
  it('DIFF_STALE renders a "回檢視重載" button; clicking it reloads the view and a second approval succeeds', async () => {
    const batchViewResult = envelope([{
      products: [{ prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }] }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-stale' }])
    let viewCall = 0
    const confirmCalls: Array<Record<string, unknown>> = []

    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => {
        viewCall += 1
        return viewCall === 1
          ? envelope([{
              changeset_id: 'cs-stale', status: 'pending_approval', nonce: 'nonce-v1', diff_version: 'dv-1',
              diff: { items: [{ item_oid: 'I1', supplier_oid: 'S1', current: 'BE2', target: 'BE2_SCM', noop: false, affected_pkgs: [] }] },
            }])
          : envelope([{
              changeset_id: 'cs-stale', status: 'pending_approval', nonce: 'nonce-v2', diff_version: 'dv-2',
              diff: { items: [{ item_oid: 'I1', supplier_oid: 'S1', current: 'BE2_SCM', target: 'BE2_SCM', noop: true, affected_pkgs: [] }] },
            }])
      },
      app_confirm_changeset: (args: Record<string, unknown>) => {
        confirmCalls.push(args)
        return confirmCalls.length === 1
          ? makeEnvelopeWithError('cs-stale', 'DIFF_STALE', 'stale')
          : envelope([{ changeset_id: 'cs-stale', status: 'done', results: [{ item_key: 'I1:S1', status: 'done', trace_id: 't1' }] }])
      },
    })

    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    cbA.checked = true
    cbA.onclick!()
    const radios = wizardEl.querySelectorAll('input[type=radio][name=target]')
    radios.find(r => r.value === 'BE2_SCM')!.checked = true
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()
    findByRole(wizardEl, 'toApproveBtn').onclick!()

    // First approval attempt -> DIFF_STALE.
    findByRole(wizardEl, 'approveBtn').onclick!()
    await flush()
    expect(confirmCalls[0]).toMatchObject({ diff_version: 'dv-1', nonce: 'nonce-v1' })

    const reloadBtn = findByRole(wizardEl, 'reloadBtn')
    // Reload -> back to step 2 with the fresh diff/nonce.
    reloadBtn.onclick!()
    await flush()
    expect(viewCall).toBe(2)

    // Proceed to step 3 again and approve — this time with the fresh nonce/diff_version.
    findByRole(wizardEl, 'toApproveBtn').onclick!()
    findByRole(wizardEl, 'approveBtn').onclick!()
    await flush()
    expect(confirmCalls[1]).toMatchObject({ diff_version: 'dv-2', nonce: 'nonce-v2' })

    const resultRows = wizardEl.querySelectorAll('[data-item-key]')
    expect(resultRows.length).toBe(1)
    expect(resultRows[0].dataset.status).toBe('done')
  })

  it('Step back navigation: Step 2 back to Step 1 preserves state and rejects changeset', async () => {
    const batchViewResult = envelope([{
      products: [{ prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }] }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-back' }])
    const viewResult = envelope([{
      changeset_id: 'cs-back', status: 'pending_approval', nonce: 'nonce-back', diff_version: 'dv-back',
      diff: { items: [{ item_oid: 'I1', supplier_oid: 'S1', current: 'BE2', target: 'BE2_SCM', noop: false, affected_pkgs: [] }] },
    }])
    let rejectCalled = false

    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => viewResult,
      app_confirm_changeset: (args: Record<string, unknown>) => {
        if (args.decision === 'reject') {
          rejectCalled = true
          // Simulate failure to ensure panel ignores it and proceeds
          return { __rawError: true, content: [{ type: 'text', text: 'Error' }] }
        }
        return envelope([])
      }
    })

    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    // Step 1 check and transition
    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    cbA.checked = true
    cbA.onclick!()
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()

    // In Step 2, click back button
    const backBtn = findByRole(wizardEl, 'backToStep1Btn')
    backBtn.onclick!()
    await flush()

    expect(rejectCalled).toBe(true)
    // Should be back at step 1 with DOM restored, checkbox still checked
    expect(wizardEl.querySelector('[data-role=loadBtn]')).not.toBeNull()
    const cbA_returned = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    expect(cbA_returned.checked).toBe(true)
  })

  it('Step back navigation: Step 3 back to Step 2 restores view without server call', async () => {
    const batchViewResult = envelope([{
      products: [{ prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }] }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-back3' }])
    const viewResult = envelope([{
      changeset_id: 'cs-back3', status: 'pending_approval', nonce: 'n', diff_version: 'v',
      diff: { items: [{ item_oid: 'I1', supplier_oid: 'S1', current: 'BE2', target: 'BE2_SCM', noop: false, affected_pkgs: [] }] },
    }])
    let viewCallCount = 0

    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => {
        viewCallCount++
        return viewResult
      }
    })

    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    checkboxesFor(wizardEl, 'pkg-oid', 'A')[0].checked = true
    checkboxesFor(wizardEl, 'pkg-oid', 'A')[0].onclick!()
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()

    expect(viewCallCount).toBe(1)

    // Go to Step 3
    findByRole(wizardEl, 'toApproveBtn').onclick!()

    // Go back to Step 2
    findByRole(wizardEl, 'backToStep2Btn').onclick!()
    await flush()

    expect(viewCallCount).toBe(1) // No new call
    expect(wizardEl.querySelector('.bw-diff-card')).not.toBeNull()
  })

  it('Step 4 new batch: clears state and reloads initial view', async () => {
    const batchViewResult = envelope([{
      products: [{ prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }] }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-new' }])
    const viewResult = envelope([{
      changeset_id: 'cs-new', status: 'pending_approval', nonce: 'n', diff_version: 'v',
      diff: { items: [] },
    }])
    const confirmResult = envelope([{ changeset_id: 'cs-new', status: 'done', results: [] }])
    let loadCallCount = 0

    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => {
        loadCallCount++
        return batchViewResult
      },
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => viewResult,
      app_confirm_changeset: () => confirmResult
    })

    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    expect(loadCallCount).toBe(1)

    checkboxesFor(wizardEl, 'pkg-oid', 'A')[0].checked = true
    checkboxesFor(wizardEl, 'pkg-oid', 'A')[0].onclick!()
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()
    findByRole(wizardEl, 'toApproveBtn').onclick!()
    findByRole(wizardEl, 'approveBtn').onclick!()
    await flush()

    // Step 4
    findByRole(wizardEl, 'newBatchBtn').onclick!()
    await flush()

    expect(loadCallCount).toBe(2) // 1 initial load + 1 new batch reload（results 為空 → 自動回讀驗證合理跳過，不發呼叫）
    expect(wizardEl.querySelector('[data-role=loadBtn]')).not.toBeNull()
    expect(checkboxesFor(wizardEl, 'pkg-oid', 'A')[0].checked).toBe(false) // state is clean
  })
})

function makeEnvelopeWithError(key: string, code: string, message: string) {
  return { items: [], errors: [{ key, code, message }], read_oids: [] }
}

describe('batch-wizard panel: shelf_schedule flow', () => {
  const wizardEl = doc.getElementById('wizard')
  beforeEach(() => { wizardEl.children.length = 0 })

  it('shelf_schedule: showInactiveBtn toggle is not present', async () => {
    const batchViewResult = envelope([{
      products: [{ prod_oid: 'P2', name: '商品2', plans: [{ pkg_oid: 'D', name: '方案D', is_bundle: false, reserve_queue: [] }] }],
    }])
    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
    })
    initWizard(app as never)
    fireLaunch('shelf_schedule', ['P2'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    expect(() => findByRole(wizardEl, 'showInactiveBtn')).toThrow()
  })

  it('bundle rows are disabled; "套用到所有已勾選" applies the UTC-converted time to every checked row, and completes to step 4', async () => {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P2', name: '商品2', plans: [
          { pkg_oid: 'D', name: '方案D', is_bundle: false, reserve_queue: [] },
          { pkg_oid: 'E', name: '方案E(bundle)', is_bundle: true, reserve_queue: [] },
        ],
      }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-2' }])
    const viewResult = envelope([{
      changeset_id: 'cs-2', status: 'pending_approval', nonce: 'n2', diff_version: 'dv-2',
      diff: { items: [{ prod_oid: 'P2', pkg_oid: 'D', pkg_name: '方案D', current_queue: [], new_queue: [{ reserve_date_utc: '2026-08-20 02:00:00', reserve_status: true }] }] }
    }])
    const confirmResult = envelope([{ changeset_id: 'cs-2', status: 'done', results: [{ item_key: 'P2:D', status: 'done', trace_id: 't2' }] }])

    const { app, calls, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => viewResult,
      app_confirm_changeset: () => confirmResult,
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

    // Proceed to Step 3 -> 4
    findByRole(wizardEl, 'toApproveBtn').onclick!()
    findByRole(wizardEl, 'approveBtn').onclick!()
    await flush()

    // Step 4: Ledger rendered with human-readable plan name as primary text, raw key as secondary
    const resultRows = wizardEl.querySelectorAll('[data-item-key]')
    expect(resultRows.length).toBe(1)
    
    const rowD = resultRows[0]
    expect(rowD.dataset.status).toBe('done')
    
    const primary = rowD.querySelector('.bw-ledger-key')
    const secondary = rowD.querySelector('.bw-plan-name-oid')
    
    expect(primary?.textContent).toBe('方案D')
    expect(secondary?.textContent).toBe('P2:D')
  })

  it('同一時間戳重複套用 = 取代（上架套錯改下架，佇列只剩一筆下架）', async () => {
    const batchViewResult = envelope([{
      products: [{ prod_oid: 'P2', name: '商品2', plans: [{ pkg_oid: 'D', name: '方案D', is_bundle: false, reserve_queue: [] }] }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-r' }])
    const viewResult = envelope([{ changeset_id: 'cs-r', status: 'pending_approval', nonce: 'nr', diff_version: 'dvr', diff: { items: [] } }])
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
    cbD.checked = true
    ;(findByRole(wizardEl, 'defDate') as FakeElement).value = '2026-08-20'
    ;(findByRole(wizardEl, 'defHour') as FakeElement).value = '10'
    ;(findByRole(wizardEl, 'defMinute') as FakeElement).value = '0'
    ;(findByRole(wizardEl, 'defTz') as FakeElement).value = 'UTC'
    ;(findByRole(wizardEl, 'defStatus') as FakeElement).value = 'true'
    findByRole(wizardEl, 'applyAllBtn').onclick!()      // 先套「上架」
    ;(findByRole(wizardEl, 'defStatus') as FakeElement).value = 'false'
    findByRole(wizardEl, 'applyAllBtn').onclick!()      // 同時間改套「下架」→ 取代
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()
    expect(calls[1].name).toBe('app_create_changeset')
    expect(calls[1].arguments.items).toEqual([{
      prod_oid: 'P2', pkg_oid: 'D',
      queue: [{ reserve_date_utc: '2026-08-20 10:00:00', reserve_status: false }],
    }])
  })

  it('不同時間戳套用兩次 = 累加兩筆', async () => {
    const batchViewResult = envelope([{
      products: [{ prod_oid: 'P2', name: '商品2', plans: [{ pkg_oid: 'D', name: '方案D', is_bundle: false, reserve_queue: [] }] }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-a' }])
    const viewResult = envelope([{ changeset_id: 'cs-a', status: 'pending_approval', nonce: 'na', diff_version: 'dva', diff: { items: [] } }])
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
    cbD.checked = true
    ;(findByRole(wizardEl, 'defDate') as FakeElement).value = '2026-08-20'
    ;(findByRole(wizardEl, 'defHour') as FakeElement).value = '10'
    ;(findByRole(wizardEl, 'defMinute') as FakeElement).value = '0'
    ;(findByRole(wizardEl, 'defTz') as FakeElement).value = 'UTC'
    ;(findByRole(wizardEl, 'defStatus') as FakeElement).value = 'false'
    findByRole(wizardEl, 'applyAllBtn').onclick!()
    ;(findByRole(wizardEl, 'defDate') as FakeElement).value = '2026-08-27'
    ;(findByRole(wizardEl, 'defStatus') as FakeElement).value = 'true'
    findByRole(wizardEl, 'applyAllBtn').onclick!()
    // badge 顯示兩筆待送明細
    const badgeD = cbD.parentNode!.querySelectorAll('[data-role=coBadge]')[0] as FakeElement
    expect(badgeD.hidden).toBe(false)
    expect(badgeD.textContent).toContain('08-20 10:00 下架')
    expect(badgeD.textContent).toContain('08-27 10:00 上架')
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()
    expect(calls[1].arguments.items).toEqual([{
      prod_oid: 'P2', pkg_oid: 'D',
      queue: [
        { reserve_date_utc: '2026-08-20 10:00:00', reserve_status: false },
        { reserve_date_utc: '2026-08-27 10:00:00', reserve_status: true },
      ],
    }])
  })

  it('clear schedule: applies cleared state, outputs queue: [], applying time un-clears', async () => {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P3', name: '商品3', plans: [
          { pkg_oid: 'F', name: '方案F', is_bundle: false, reserve_queue: [{ reserve_date_utc: '2026-08-20 02:00:00', reserve_status: true }] },
          { pkg_oid: 'G', name: '方案G', is_bundle: false, reserve_queue: [] },
        ],
      }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-3' }])
    const viewResult = envelope([{
      changeset_id: 'cs-3', status: 'pending_approval', nonce: 'n3', diff_version: 'dv-3',
      diff: { items: [
        { prod_oid: 'P3', pkg_oid: 'F', pkg_name: '方案F', current_queue: [{ reserve_date_utc: '2026-08-20 02:00:00', reserve_status: true }], new_queue: [] },
        { prod_oid: 'P3', pkg_oid: 'G', pkg_name: '方案G', current_queue: [], new_queue: [] }
      ]}
    }])
    const confirmResult = envelope([{ changeset_id: 'cs-3', status: 'done', results: [{ item_key: 'P3:F', status: 'done' }, { item_key: 'P3:G', status: 'skipped_noop' }] }])

    const { app, calls, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => viewResult,
      app_confirm_changeset: () => confirmResult,
    })

    initWizard(app as never)
    fireLaunch('shelf_schedule', ['P3'])

    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    const cbF = checkboxesFor(wizardEl, 'pkg-oid', 'F')[0]
    const cbG = checkboxesFor(wizardEl, 'pkg-oid', 'G')[0]

    cbF.checked = true
    cbG.checked = true

    // 1. Select clear mode
    const statusSelect = findByRole(wizardEl, 'defStatus') as FakeElement
    const defDate = findByRole(wizardEl, 'defDate') as FakeElement
    const defHour = findByRole(wizardEl, 'defHour') as FakeElement
    const defMinute = findByRole(wizardEl, 'defMinute') as FakeElement
    const defTz = findByRole(wizardEl, 'defTz') as FakeElement

    statusSelect.value = 'clear'
    statusSelect.onchange!()
    
    expect(defDate.disabled).toBe(true)
    expect(defHour.disabled).toBe(true)
    expect(defMinute.disabled).toBe(true)
    expect(defTz.disabled).toBe(true)

    findByRole(wizardEl, 'applyAllBtn').onclick!()

    const badgeF = cbF.parentNode!.querySelectorAll('[data-role=coBadge]')[0] as FakeElement
    expect(badgeF.hidden).toBe(false)
    expect(badgeF.textContent).toBe('將清除排程')

    // 2. Un-clear by applying normal time
    statusSelect.value = 'true'
    statusSelect.onchange!()

    expect(defDate.disabled).toBe(false)
    expect(defHour.disabled).toBe(false)
    expect(defMinute.disabled).toBe(false)
    expect(defTz.disabled).toBe(false)

    ;(findByRole(wizardEl, 'defDate') as FakeElement).value = '2026-08-20'
    ;(findByRole(wizardEl, 'defHour') as FakeElement).value = '10'
    ;(findByRole(wizardEl, 'defMinute') as FakeElement).value = '0'
    ;(findByRole(wizardEl, 'defTz') as FakeElement).value = 'UTC'
    
    // Only check G so we apply normal time to G, leaving F cleared
    cbF.checked = false
    findByRole(wizardEl, 'applyAllBtn').onclick!()
    
    const badgeG = cbG.parentNode!.querySelectorAll('[data-role=coBadge]')[0] as FakeElement
    // 待送佇列可視化（2026-08-18 apply-replace 修正）：套用一般時間後 badge 改顯示佇列明細，
    // 不再隱藏——舊行為（hidden=true）正是「使用者看不到自己排了什麼」的缺陷本身。
    expect(badgeG.hidden).toBe(false)
    expect(badgeG.textContent).toContain('待送')
    expect(badgeG.textContent).toContain('上架')

    // 3. Re-clear both for the final payload
    cbF.checked = true
    statusSelect.value = 'clear'
    statusSelect.onchange!()
    findByRole(wizardEl, 'applyAllBtn').onclick!()
    
    expect(badgeG.hidden).toBe(false)
    expect(badgeG.textContent).toBe('將清除排程')

    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()

    expect(calls[1].name).toBe('app_create_changeset')
    expect(calls[1].arguments.items).toEqual([
      { prod_oid: 'P3', pkg_oid: 'F', queue: [] },
      { prod_oid: 'P3', pkg_oid: 'G', queue: [] }
    ])
  })

  it('shows actionable validation messages for shelf_schedule', async () => {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P1', name: '商品1', plans: [
          { pkg_oid: 'A', name: '方案A', is_bundle: false, reserve_queue: [] }
        ],
      }],
    }])
    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => envelope([{ changeset_id: 'cs-1' }])
    })
    initWizard(app as never)
    fireLaunch('shelf_schedule', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    const nextBtn = findByRole(wizardEl, 'nextBtn')
    const fallbackEl = doc.getElementById('fallback')
    
    // Nothing checked
    nextBtn.onclick!()
    await flush()
    expect(fallbackEl.hidden).toBe(false)
    expect(fallbackEl.textContent).toBe('請至少勾選一筆方案')

    // Checked but no time applied
    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    cbA.checked = true
    cbA.onclick!()
    
    nextBtn.onclick!()
    await flush()
    expect(fallbackEl.textContent).toBe('已勾選 1 筆但尚未套用——請先按『套用到所有已勾選』設定時間或取消排程')
  })

  it('Fix 1 & 2: client-side validation in applyAll and toReserveDateUtc defense', async () => {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P1', name: '商品1', plans: [
          { pkg_oid: 'A', name: '方案A', is_bundle: false, reserve_queue: [] }
        ],
      }],
    }])
    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult
    })
    initWizard(app as never)
    fireLaunch('shelf_schedule', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    cbA.checked = true; cbA.onclick!()

    const defDate = findByRole(wizardEl, 'defDate') as FakeElement
    const defHour = findByRole(wizardEl, 'defHour') as FakeElement
    const defMinute = findByRole(wizardEl, 'defMinute') as FakeElement
    const fallbackEl = doc.getElementById('fallback') as FakeElement
    const applyAllBtn = findByRole(wizardEl, 'applyAllBtn')
    const badgeA = cbA.parentNode!.querySelectorAll('[data-role=coBadge]')[0] as FakeElement

    // (a) apply with empty date
    defDate.value = ''
    defHour.value = '10'
    defMinute.value = '0'
    applyAllBtn.onclick!()
    expect(fallbackEl.hidden).toBe(false)
    expect(fallbackEl.textContent).toBe('請先選擇日期並確認時間（時 0–23、分 0–59）')
    expect(badgeA.hidden).toBe(true) // badge state unchanged
    
    // clear fallback for next check
    fallbackEl.hidden = true
    
    // (b) apply with hour=25
    defDate.value = '2026-08-20'
    defHour.value = '25'
    defMinute.value = '0'
    applyAllBtn.onclick!()
    expect(fallbackEl.hidden).toBe(false)
    expect(fallbackEl.textContent).toBe('請先選擇日期並確認時間（時 0–23、分 0–59）')
    expect(badgeA.hidden).toBe(true)
    
    // apply with invalid date -> throws INVALID_DATE, caught and shows same message
    fallbackEl.hidden = true
    defDate.value = 'invalid-date'
    defHour.value = '10'
    defMinute.value = '0'
    applyAllBtn.onclick!()
    expect(fallbackEl.hidden).toBe(false)
    expect(fallbackEl.textContent).toBe('請先選擇日期並確認時間（時 0–23、分 0–59）')
    expect(badgeA.hidden).toBe(true)

    // (c) valid apply still works
    fallbackEl.hidden = true
    defDate.value = '2026-08-20'
    defHour.value = '10'
    defMinute.value = '0'
    applyAllBtn.onclick!()
    expect(fallbackEl.hidden).toBe(true)
    // 2026-08-18 apply-replace 修正後：合法套用會在 badge 顯示待送佇列明細（可視化），
    // 這裡確認驗證不誤攔且套用有生效。
    expect(badgeA.hidden).toBe(false)
    expect(badgeA.textContent).toContain('待送')
  })

  it('Fix 3: surfaces server error on create failure', async () => {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P1', name: '商品1', plans: [
          { pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }
        ],
      }],
    }])
    
    let errorResponse: any = { __rawError: true, content: [{ type: 'text', text: '{"errors":[{"code":"INVALID_ITEMS","message":"Invalid items selected"}]}' }] }
    
    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => errorResponse
    })
    
    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    cbA.checked = true; cbA.onclick!()
    const radios = wizardEl.querySelectorAll('input[type=radio][name=target]')
    radios.find(r => r.value === 'BE2_SCM')!.checked = true

    const nextBtn = findByRole(wizardEl, 'nextBtn')
    const fallbackEl = doc.getElementById('fallback') as FakeElement

    // (d) parseable body
    nextBtn.onclick!()
    await flush()
    expect(fallbackEl.hidden).toBe(false)
    expect(fallbackEl.textContent).toBe('建立變更失敗：INVALID_ITEMS — Invalid items selected')

    // stub without parseable body -> generic fallback message
    errorResponse = { __rawError: true, content: [{ type: 'text', text: 'not json' }] }
    nextBtn.onclick!()
    await flush()
    expect(fallbackEl.hidden).toBe(false)
    expect(fallbackEl.textContent).toBe('建立變更失敗')
    
    // json but no envelope
    errorResponse = { __rawError: true, content: [{ type: 'text', text: '{"something":1}' }] }
    nextBtn.onclick!()
    await flush()
    expect(fallbackEl.hidden).toBe(false)
    expect(fallbackEl.textContent).toBe('建立變更失敗')
  })
})

describe('batch-wizard panel: additional UI behaviors', () => {
  const wizardEl = doc.getElementById('wizard')
  beforeEach(() => { wizardEl.children.length = 0 })

  it('renders tabs for multiple products and controls row visibility', async () => {
    const batchViewResult = envelope([{
      products: [
        { prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }] },
        { prod_oid: 'P2', name: '商品2', plans: [{ pkg_oid: 'B', name: '方案B', item_oid: 'I2', supplier_oid: 'S2', current_platform: 'BE2' }] },
      ],
    }])
    const { app, fireLaunch } = makeFakeApp({ app_get_batch_view: () => batchViewResult })
    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1', 'P2'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    const tabs = wizardEl.querySelectorAll('.bw-tab')
    expect(tabs.length).toBe(2)
    
    const rowA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0].parentNode!.parentNode!
    const rowB = checkboxesFor(wizardEl, 'pkg-oid', 'B')[0].parentNode!.parentNode!

    // P1 is active by default
    expect(rowA.hidden).toBe(false)
    expect(rowB.hidden).toBe(true)

    // Switch to P2
    tabs[1].onclick!()
    expect(rowA.hidden).toBe(true)
    expect(rowB.hidden).toBe(false)
    expect(tabs[1].className).toContain('bw-tab-active')
    expect(tabs[0].className).not.toContain('bw-tab-active')

    // Check B in P2, switch back to P1, B is still checked
    checkboxesFor(wizardEl, 'pkg-oid', 'B')[0].checked = true
    checkboxesFor(wizardEl, 'pkg-oid', 'B')[0].onclick!()
    tabs[0].onclick!()

    expect(checkboxesFor(wizardEl, 'pkg-oid', 'B')[0].checked).toBe(true)
  })

  it('clears stale error banner on success or change', async () => {
    const batchViewResult = envelope([{
      products: [{
        prod_oid: 'P1', name: '商品1', plans: [
          { pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1' }
        ],
      }],
    }])
    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => envelope([{ changeset_id: 'cs-1' }]),
      app_get_changeset_view: () => envelope([{ diff: {} }])
    })
    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    const nextBtn = findByRole(wizardEl, 'nextBtn')
    const fallbackEl = doc.getElementById('fallback')
    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    
    // 1. Trigger error
    nextBtn.onclick!()
    await flush()
    expect(fallbackEl.hidden).toBe(false)
    
    // 2. Change selection -> clears error
    cbA.checked = true
    cbA.onclick!()
    expect(fallbackEl.hidden).toBe(true)

    // Trigger error again
    cbA.checked = false
    cbA.onclick!()
    nextBtn.onclick!()
    await flush()
    expect(fallbackEl.hidden).toBe(false)
    
    // 3. Success next -> clears error
    cbA.checked = true
    cbA.onclick!()
    fallbackEl.hidden = false
    fallbackEl.textContent = 'stale error'
    nextBtn.onclick!()
    await flush()
    expect(fallbackEl.hidden).toBe(true)
  })

  it('Fix 1: load one valid + one not_found product -> tab labels correct, warning visible, next-step items exclude not_found', async () => {
    const batchViewResult = envelope([{
      products: [
        { prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }] },
        { prod_oid: 'BAD', not_found: true, plans: [] }
      ],
    }], [{ key: 'BAD', code: 'PRODUCT_NOT_FOUND', message: 'PRODUCT_NOT_FOUND: 找不到商品 BAD' }])
    
    const { app, fireLaunch, calls } = makeFakeApp({
      app_get_batch_view: () => batchViewResult,
      app_create_changeset: () => envelope([{ changeset_id: 'cs-1' }])
    })
    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1', 'BAD'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    // 1. Warning visible in fallbackEl
    const fallbackEl = doc.getElementById('fallback') as any
    expect(fallbackEl.hidden).toBe(false)
    expect(fallbackEl.textContent).toContain('PRODUCT_NOT_FOUND: 找不到商品 BAD')

    // 2. Tab labels correct
    const tabs = wizardEl.querySelectorAll('.bw-tab')
    expect(tabs.length).toBe(2)
    expect(tabs[1].className).toContain('bw-tab-danger')
    expect(tabs[1].querySelector('.bw-tab-name')!.textContent).toBe('找不到商品')
    expect(tabs[1].querySelector('.bw-tab-oid')!.textContent).toBe('BAD')

    // 3. P1 active, bad product hidden message? Let's check when clicking bad product tab.
    tabs[1].onclick!()
    const emptyMsgs = wizardEl.querySelectorAll('.bw-not-found-msg')
    expect(emptyMsgs.length).toBe(1)
    expect(emptyMsgs[0].hidden).toBe(false)
    expect(emptyMsgs[0].textContent).toBe('查無此商品，請確認 prod_oid')

    // 4. Next-step items exclude the not_found product.
    tabs[0].onclick!()
    checkboxesFor(wizardEl, 'pkg-oid', 'A')[0].checked = true
    const radios = wizardEl.querySelectorAll('input[type=radio][name=target]')
    radios.find(r => r.value === 'BE2_SCM')!.checked = true
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()

    expect(calls[1].name).toBe('app_create_changeset')
    expect(calls[1].arguments.items).toHaveLength(1)
    expect((calls[1].arguments.items as any)[0].affected_pkgs[0].prod_oid).toBe('P1')
  })
})

describe('batch-wizard panel: step 4 automatic read-back verification', () => {
  const wizardEl = doc.getElementById('wizard')
  beforeEach(() => { wizardEl.children.length = 0 })

  it('verifies inventory_platform: match -> ✓, mismatch -> ⏳, re-verify -> ✓', async () => {
    const batchViewResult1 = envelope([{
      products: [{ prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }] }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-1' }])
    const viewResult = envelope([{
      changeset_id: 'cs-1', status: 'pending_approval', nonce: 'n1', diff_version: 'dv-1',
      diff: { items: [{ item_oid: 'I1', supplier_oid: 'S1', current: 'BE2', target: 'BE2_SCM', noop: false, affected_pkgs: [{ prod_oid: 'P1', pkg_oid: 'A', pkg_name: '方案A' }] }] },
    }])
    const confirmResult = envelope([{ changeset_id: 'cs-1', status: 'done', results: [{ item_key: 'I1:S1', status: 'done', trace_id: 't1' }] }])
    
    // (b) mismatched state -> ⏳ line
    const batchViewResultMismatched = envelope([{
      products: [{ prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2' }] }], // still BE2
    }])

    // (a) landed state matching targets -> ✓ line
    const batchViewResultMatched = envelope([{
      products: [{ prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', current_platform: 'BE2_SCM' }] }], // updated
    }])

    let viewCount = 0
    const { app, fireLaunch, calls } = makeFakeApp({
      app_get_batch_view: () => {
        viewCount++
        if (viewCount === 1) return batchViewResult1
        if (viewCount === 2) return batchViewResultMismatched
        return batchViewResultMatched
      },
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => viewResult,
      app_confirm_changeset: () => confirmResult,
    })

    initWizard(app as never)
    fireLaunch('inventory_platform', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    cbA.checked = true; cbA.onclick!()
    const radios = wizardEl.querySelectorAll('input[type=radio][name=target]')
    radios.find(r => r.value === 'BE2_SCM')!.checked = true
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()
    findByRole(wizardEl, 'toApproveBtn').onclick!()
    findByRole(wizardEl, 'approveBtn').onclick!()
    await flush()

    // Post-execution check happens automatically (viewCount should be 2 now)
    expect(viewCount).toBe(2)
    const verificationCall1 = calls[calls.length - 1]
    expect(verificationCall1.arguments).toEqual({ action_type: 'inventory_platform', prod_oids: ['P1'] })

    let rows = wizardEl.querySelectorAll('.bw-ledger-row')
    expect(rows[0].textContent).toContain('⏳ 尚未觀察到落地（可能為讀取延遲）')

    // (c) clicking 重新驗證 triggers another batch_view call
    const reVerifyBtn = findByRole(wizardEl, 'reverifyBtn')
    reVerifyBtn.onclick!()
    await flush()

    expect(viewCount).toBe(3)
    rows = wizardEl.querySelectorAll('.bw-ledger-row')
    expect(rows[0].textContent).toContain('✓ 已驗證：be2 現況與目標一致')
    expect(rows[0].textContent).not.toContain('⏳')
  })

  it('verifies shelf_schedule: match -> ✓, mismatch -> ⏳, read error -> muted', async () => {
    const batchViewResult1 = envelope([{
      products: [{ prod_oid: 'P2', name: '商品2', plans: [{ pkg_oid: 'B', name: '方案B', is_bundle: false, reserve_queue: [] }] }],
    }])
    const createResult = envelope([{ changeset_id: 'cs-2' }])
    const viewResult = envelope([{
      changeset_id: 'cs-2', status: 'pending_approval', nonce: 'n2', diff_version: 'dv-2',
      diff: { items: [{ prod_oid: 'P2', pkg_oid: 'B', pkg_name: '方案B', current_queue: [], new_queue: [{ reserve_date_utc: '2026-08-20 02:00:00', reserve_status: true }] }] },
    }])
    const confirmResult = envelope([{ changeset_id: 'cs-2', status: 'done', results: [{ item_key: 'P2:B', status: 'done', trace_id: 't2' }] }])
    
    // First verification attempt throws or returns error
    const batchViewResultMatched = envelope([{
      products: [{ prod_oid: 'P2', name: '商品2', plans: [{ pkg_oid: 'B', name: '方案B', is_bundle: false, reserve_queue: [{ reserve_date_utc: '2026-08-20 02:00:00', reserve_status: true }] }] }],
    }])

    let viewCount = 0
    const { app, fireLaunch, calls } = makeFakeApp({
      app_get_batch_view: async () => {
        viewCount++
        if (viewCount === 1) return batchViewResult1
        if (viewCount === 2) throw new Error('Simulated network error') // First auto check fails
        return batchViewResultMatched // Re-verify succeeds
      },
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => viewResult,
      app_confirm_changeset: () => confirmResult,
    })

    initWizard(app as never)
    fireLaunch('shelf_schedule', ['P2'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    const cbB = checkboxesFor(wizardEl, 'pkg-oid', 'B')[0]
    cbB.checked = true; cbB.onclick!()
    ;(findByRole(wizardEl, 'defDate') as FakeElement).value = '2026-08-20'
    ;(findByRole(wizardEl, 'defHour') as FakeElement).value = '10'
    ;(findByRole(wizardEl, 'defMinute') as FakeElement).value = '0'
    ;(findByRole(wizardEl, 'defTz') as FakeElement).value = 'Asia/Taipei'
    ;(findByRole(wizardEl, 'defStatus') as FakeElement).value = 'true'
    findByRole(wizardEl, 'applyAllBtn').onclick!()
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()
    findByRole(wizardEl, 'toApproveBtn').onclick!()
    findByRole(wizardEl, 'approveBtn').onclick!()
    await flush()

    expect(viewCount).toBe(2)
    let rows = wizardEl.querySelectorAll('.bw-ledger-row')
    expect(rows[0].textContent).toContain('（無法自動驗證：讀取失敗，可稍後按重新驗證）')

    // Click 重新驗證
    const reVerifyBtn = findByRole(wizardEl, 'reverifyBtn')
    reVerifyBtn.onclick!()
    await flush()

    expect(viewCount).toBe(3)
    rows = wizardEl.querySelectorAll('.bw-ledger-row')
    expect(rows[0].textContent).toContain('✓ 已驗證：be2 現況與目標一致')
  })
})

describe('batch-wizard panel: inventory_setting 排程(塊 B)', () => {
  const wizardEl = doc.getElementById('wizard')
  beforeEach(() => { wizardEl.children.length = 0 })

  const invBatchView = envelope([{
    products: [{
      prod_oid: 'P1', name: '商品1', plans: [
        { pkg_oid: 'A', name: '方案A', item_oid: 'I1', supplier_oid: 'S1', inventory_mode: 'item_by_amount', current_quantity: 10 },
      ],
    }],
  }])

  it('schedulable 分頁(inventory_setting)顯示排程切換,勾選才露出 datetime;shelf_schedule 不顯示', async () => {
    const { app, fireLaunch } = makeFakeApp({ app_get_batch_view: () => invBatchView })
    initWizard(app as never)
    fireLaunch('inventory_setting', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    const schedToggle = findByRole(wizardEl, 'schedToggle')
    expect(schedToggle).toBeDefined()
    const schedWall = findByRole(wizardEl, 'schedWall')
    expect(schedWall.hidden).toBe(true)
    schedToggle.checked = true
    schedToggle.onchange!()
    expect(schedWall.hidden).toBe(false)

    // 對照組:非 schedulable(shelf_schedule)不渲染切換
    wizardEl.children.length = 0
    const { app: app2, fireLaunch: fire2 } = makeFakeApp({
      app_get_batch_view: () => envelope([{ products: [{ prod_oid: 'P1', name: '商品1', plans: [{ pkg_oid: 'A', name: '方案A', queue: [] }] }] }]),
    })
    initWizard(app2 as never)
    fire2('shelf_schedule', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    expect(wizardEl.querySelectorAll('[data-role=schedToggle]').length).toBe(0)
  })

  it('勾排程建立帶 schedule.wall;批准帶 expected_execute_at_utc;scheduled 合成 ledger 列含取消按鈕,取消送 decision:cancel', async () => {
    const createResult = envelope([{ changeset_id: 'cs-s' }])
    const viewResult = envelope([{
      changeset_id: 'cs-s', status: 'pending_approval', nonce: 'n-1', diff_version: 'dv-1',
      schedule: { execute_at_utc: 1756717200000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' },
      diff: { items: [{ item_oid: 'I1', supplier_oid: 'S1', current: 10, target: 20, no_op: false }] },
    }])
    // 真實 server 對排程批准只回 {changeset_id, status:'scheduled'}——無 results(面板需自行合成列)
    const confirmResult = envelope([{ changeset_id: 'cs-s', status: 'scheduled' }])
    // 仿真 server:每次 view 發「新鮮」nonce(單次消耗語意)——取消流程必須重新 view 拿新 nonce,
    // 不得複用批准時已消耗的那顆(review Critical 2a)。
    let viewCalls = 0
    const { app, calls, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => invBatchView,
      app_create_changeset: () => createResult,
      app_get_changeset_view: () => {
        viewCalls++
        const items = (viewResult.items as Array<Record<string, unknown>>)
        return envelope([{ ...items[0], nonce: `n-${viewCalls}`, status: viewCalls === 1 ? 'pending_approval' : 'scheduled' }])
      },
      app_confirm_changeset: () => confirmResult,
    })
    initWizard(app as never)
    fireLaunch('inventory_setting', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()

    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    cbA.checked = true
    cbA.onclick!()
    const qty = wizardEl.querySelectorAll('input[type=number]')[0]
    ;(qty as unknown as { valueAsNumber: number }).valueAsNumber = 20

    const schedToggle = findByRole(wizardEl, 'schedToggle')
    schedToggle.checked = true
    schedToggle.onchange!()
    const schedWall = findByRole(wizardEl, 'schedWall')
    schedWall.value = '2026-09-01T09:00'

    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()
    const createCall = calls.find(c => c.name === 'app_create_changeset')!
    expect(createCall.arguments.schedule).toEqual({ wall: '2026-09-01T09:00' })

    findByRole(wizardEl, 'toApproveBtn').onclick!()
    expect(wizardEl.textContent).toContain('將於 2026-09-01T09:00 (Asia/Taipei) 執行')

    findByRole(wizardEl, 'approveBtn').onclick!()
    await flush()
    const confirmCall = calls.find(c => c.name === 'app_confirm_changeset')!
    expect(confirmCall.arguments.expected_execute_at_utc).toBe(1756717200000)
    expect(confirmCall.arguments.nonce).toBe('n-1')

    // Step 4:合成的 scheduled 列 + 取消按鈕
    const rows = wizardEl.querySelectorAll('.bw-ledger-row')
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('已排程 2026-09-01T09:00')
    const cancelBtn = findByRole(rows[0], 'cancelBtn')
    expect(cancelBtn).toBeDefined()
    cancelBtn.onclick!()
    await flush()
    // 取消前先重新 view 取新鮮 nonce(n-2),不重用批准時已消耗的 n-1
    expect(viewCalls).toBe(2)
    const cancelCall = calls.find(c => c.name === 'app_confirm_changeset' && c.arguments.decision === 'cancel')!
    expect(cancelCall.arguments).toMatchObject({ changeset_id: 'cs-s', decision: 'cancel', confirmed_keys: [], nonce: 'n-2' })
    expect(rows[0].textContent).toContain('取消排程')
  })

  it('取消失敗(server 回錯誤信封)不得假成功:顯示錯誤、按鈕恢復可按', async () => {
    const { app, fireLaunch } = makeFakeApp({
      app_get_batch_view: () => invBatchView,
      app_create_changeset: () => envelope([{ changeset_id: 'cs-e' }]),
      app_get_changeset_view: () => envelope([{
        changeset_id: 'cs-e', status: 'pending_approval', nonce: 'n-x', diff_version: 'dv-1',
        schedule: { execute_at_utc: 1756717200000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' },
        diff: { items: [{ item_oid: 'I1', supplier_oid: 'S1', current: 10, target: 20, no_op: false }] },
      }]),
      app_confirm_changeset: (args: Record<string, unknown>) =>
        args.decision === 'cancel'
          ? envelope([], [{ key: 'cs-e', code: 'NOT_CANCELLABLE', message: 'Only a scheduled change-set can be cancelled.' }])
          : envelope([{ changeset_id: 'cs-e', status: 'scheduled' }]),
    })
    initWizard(app as never)
    fireLaunch('inventory_setting', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    cbA.checked = true
    cbA.onclick!()
    ;(wizardEl.querySelectorAll('input[type=number]')[0] as unknown as { valueAsNumber: number }).valueAsNumber = 20
    const schedToggle = findByRole(wizardEl, 'schedToggle')
    schedToggle.checked = true
    schedToggle.onchange!()
    findByRole(wizardEl, 'schedWall').value = '2026-09-01T09:00'
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()
    findByRole(wizardEl, 'toApproveBtn').onclick!()
    findByRole(wizardEl, 'approveBtn').onclick!()
    await flush()
    const rows = wizardEl.querySelectorAll('.bw-ledger-row')
    const cancelBtn = findByRole(rows[0], 'cancelBtn')
    cancelBtn.onclick!()
    await flush()
    // 假成功防線:狀態藥丸仍是「已排程」、按鈕未隱藏且恢復可按
    expect(rows[0].textContent).toContain('已排程')
    expect(cancelBtn.hidden).not.toBe(true)
    expect(cancelBtn.disabled).toBe(false)
  })

  it('勾排程但未填時間:doNext 擋下,不建立 change-set(不靜默轉立即執行)', async () => {
    const { app, calls, fireLaunch } = makeFakeApp({ app_get_batch_view: () => invBatchView })
    initWizard(app as never)
    fireLaunch('inventory_setting', ['P1'])
    findByRole(wizardEl, 'loadBtn').onclick!()
    await flush()
    const cbA = checkboxesFor(wizardEl, 'pkg-oid', 'A')[0]
    cbA.checked = true
    cbA.onclick!()
    ;(wizardEl.querySelectorAll('input[type=number]')[0] as unknown as { valueAsNumber: number }).valueAsNumber = 20
    const schedToggle = findByRole(wizardEl, 'schedToggle')
    schedToggle.checked = true
    schedToggle.onchange!()
    findByRole(wizardEl, 'nextBtn').onclick!()
    await flush()
    expect(calls.some(c => c.name === 'app_create_changeset')).toBe(false)
  })
})
