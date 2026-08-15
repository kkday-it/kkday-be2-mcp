// src/ui/batch-wizard.ts — Task 7 (.superpowers/sdd/task-7-brief.md). Four-step batch wizard panel
// (選擇→檢視→批准→結果) for the two Phase 4a batch action_types (inventory_platform,
// shelf_schedule), driven entirely through the app-only tools Task 5/6 landed
// (app_get_batch_view / app_create_changeset / app_get_changeset_view / app_confirm_changeset).
//
// Visual pass (apple-design refresh): all callServerTool sequencing, connective logic (sibling
// sync, filter/hide-unchecked, UTC conversion, DIFF_STALE reload) is UNCHANGED from the prior
// version — only markup/className/CSS were added. See STYLE below for the injected stylesheet and
// the per-section comments for what got wrapped/restructured purely for presentation.
import { connectApp, renderText } from './panelShared.js'

type ActionType = 'inventory_platform' | 'shelf_schedule'

interface ScheduleEntry { reserve_date_utc: string; reserve_status: boolean }
interface AffectedPkg { prod_oid: string; pkg_oid: string; pkg_name: string }

// Fixed offsets — demo scope only (brief: "禁第三方庫"). DST is NOT modeled; do not reuse this
// for anything beyond the wizard's local<->UTC display/input conversion.
const TZ_OFFSET_HOURS: Record<string, number> = { 'Asia/Taipei': 8, 'Asia/Tokyo': 9, UTC: 0 }

const ACTION_LABELS: Record<ActionType, string> = {
  inventory_platform: '批次庫存平台調整',
  shelf_schedule: '批次上架排程設定',
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

// Local wall-clock (date + hh:mm in `tz`) -> be2's UTC storage format "YYYY-MM-DD HH:mm:ss"
// (src/changeset/types.ts ScheduleEntry / src/changeset/batchValidate.ts RESERVE_DATE_RE).
// Exported for direct unit testing (brief's literal test value: 2026-08-20 10:00 Asia/Taipei ->
// 2026-08-20 02:00:00) without needing to drive the whole panel UI just for arithmetic.
export function toReserveDateUtc(dateStr: string, hh: number, mm: number, tz: string): string {
  const offset = TZ_OFFSET_HOURS[tz] ?? 0
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d, hh - offset, mm, 0))
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())} ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:00`
}

// Step-2 review dual display (spec: GMT+X alongside UTC — the confirm-page renderer
// (src/server/confirmRoutes.ts renderSchedulePage) only shows raw UTC; the wizard panel goes one
// step further per the brief for readability during the guided flow).
export function formatDualDisplay(reserveDateUtc: string, tz: string): string {
  const offset = TZ_OFFSET_HOURS[tz] ?? 0
  const ms = Date.parse(reserveDateUtc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return reserveDateUtc
  const local = new Date(ms + offset * 3600_000)
  const localStr = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`
  const sign = offset >= 0 ? '+' : '-'
  return `${localStr} (GMT${sign}${Math.abs(offset)}) / ${reserveDateUtc} UTC`
}

// Same rule as src/ui/changeset-panel.ts#itemKeyOf (source of truth:
// src/changeset/confirmService.ts#itemKeysOf) — confirmed_keys must match this exactly or the
// server throws CONFIRMED_KEYS_MISMATCH. inventory_platform diff items carry item_oid; shelf_
// schedule ones don't.
function itemKeyOf(d: Record<string, unknown>): string {
  return 'item_oid' in d ? `${d.item_oid}:${d.supplier_oid}` : `${d.prod_oid}:${d.pkg_oid}`
}

// ---------------------------------------------------------------------------------------------
// Injected stylesheet (apple-design pass). A single <style> element, appended once to
// document.head from a template-string constant — no external stylesheet, no innerHTML
// interpolation of any server-sourced value (this string is 100% static). Kept as one constant so
// the whole design system lives in one place; elements below only ever set `.className`.
// ---------------------------------------------------------------------------------------------
const STYLE = `
:root{--bw-tint:#0A84FF;--bw-danger:#FF3B30;--bw-text:#1d1d1f;--bw-muted:#6e6e73;--bw-border:rgba(0,0,0,.08);--bw-bg-page:#f5f5f7}
*{box-sizing:border-box}
html,body{background:var(--bw-bg-page)}
body{font:100%/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--bw-text);max-width:720px;margin:0 auto;padding:1.5rem 1.25rem 3rem}
.bw-title{font-size:1.25rem;font-weight:600;letter-spacing:-0.02em;line-height:1.15;margin:0 0 1rem}
#status{font-size:.8125rem;color:var(--bw-muted);margin-bottom:.5rem}

/* ---- step progress: circle+label with connecting line (spike BAA/Apple style) ---- */
.bw-progress{display:flex;align-items:center;margin:0 0 1.5rem}
.bw-step{display:flex;flex-direction:column;align-items:center;gap:.25rem;flex:0 0 auto}
.bw-step-circle{width:1.75rem;height:1.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.8125rem;font-weight:600;border:1.5px solid #d2d2d7;color:var(--bw-muted);background:#fff;transition:background-color 150ms ease-out,border-color 150ms ease-out,color 150ms ease-out}
.bw-step-current .bw-step-circle{border-color:var(--bw-tint);color:var(--bw-tint)}
.bw-step-done .bw-step-circle{background:var(--bw-tint);border-color:var(--bw-tint);color:#fff}
.bw-step-label{font-size:.75rem;color:var(--bw-muted);white-space:nowrap}
.bw-step-current .bw-step-label{color:var(--bw-text);font-weight:600}
.bw-connector{flex:1 1 auto;height:1.5px;background:#d2d2d7;margin:0 .25rem 1.1rem;transition:background-color 150ms ease-out}
.bw-connector-done{background:var(--bw-tint)}

/* ---- cards ---- */
.bw-card{background:#fff;border:1px solid var(--bw-border);border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 12px rgba(0,0,0,.04);padding:1rem 1.125rem;margin-bottom:1rem}
.bw-card-title{font-size:.8125rem;font-weight:600;color:var(--bw-muted);margin:0 0 .625rem;text-transform:uppercase;letter-spacing:.02em}
.bw-row-inline{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.bw-row-footer{display:flex;justify-content:flex-end;align-items:center;gap:.75rem}
.bw-note{flex:1 1 auto}

/* ---- inputs ---- */
.bw-input,.bw-select{height:2rem;padding:0 .625rem;border-radius:8px;border:1px solid rgba(0,0,0,.14);font:inherit;font-size:.875rem;background:#fff;color:var(--bw-text)}
.bw-input:focus-visible,.bw-select:focus-visible{outline:2px solid var(--bw-tint);outline-offset:1px;border-color:var(--bw-tint)}
input.bw-input[type=text]{flex:1 1 auto;min-width:8rem}
input.bw-input[type=number]{width:4.5rem}

/* ---- buttons ---- */
.bw-btn{height:2rem;padding:0 1.1rem;border-radius:8px;border:1px solid transparent;font:inherit;font-size:.875rem;font-weight:500;cursor:pointer;transition:transform 120ms ease-out,background-color 120ms ease-out,opacity 120ms ease-out}
.bw-btn:active{transform:scale(0.97)}
.bw-btn-primary{background:var(--bw-tint);color:#fff}
.bw-btn-primary:hover{background:#0974e0}
.bw-btn-secondary{background:#f0f0f2;color:var(--bw-text)}
.bw-btn-secondary:hover{background:#e5e5ea}

/* ---- plan table (real grid, not a browser-default <table>) ---- */
.bw-table-toolbar{display:flex;gap:.5rem;margin-bottom:.75rem}
.bw-radio-bar{display:flex;gap:1rem;margin-bottom:.75rem;font-size:.875rem}
.bw-radio-bar label{display:flex;align-items:center;gap:.35rem}
.bw-plan-row,.bw-plan-head{display:grid;grid-template-columns:1.5rem 1fr 6.5rem 8.5rem 6rem;align-items:center;gap:.75rem;padding:.5rem .25rem;border-radius:8px;transition:background-color 120ms ease-out,opacity 150ms ease-out}
.bw-plan-head{font-size:.75rem;color:var(--bw-muted);font-weight:600;padding-bottom:.5rem;border-bottom:1px solid var(--bw-border);margin-bottom:.25rem}
.bw-plan-row:hover{background:#f5f5f7}
.bw-plan-row-checked{background:rgba(10,132,255,.08)}
.bw-plan-row-bundle{opacity:.55}
.bw-plan-name{display:flex;flex-direction:column;gap:.125rem;min-width:0}
.bw-plan-name-top{display:flex;align-items:center;gap:.375rem}
.bw-plan-name-oid{font-size:.75rem;color:var(--bw-muted)}
.bw-bundle-tag{font-size:.6875rem;color:var(--bw-muted);background:#f0f0f2;padding:.05rem .4rem;border-radius:6px}
.bw-co-badge{font-size:.6875rem;background:rgba(10,132,255,.12);color:var(--bw-tint);padding:.1rem .5rem;border-radius:999px;justify-self:start}

/* ---- status badges / dots ---- */
.bw-status-badge{display:flex;align-items:center;gap:.375rem;font-size:.8125rem}
.bw-dot{width:.5rem;height:.5rem;border-radius:50%;flex:0 0 auto}
.bw-dot-green{background:#34c759}
.bw-dot-red{background:var(--bw-danger)}
.bw-dot-gray{background:#c7c7cc}

/* ---- banners ---- */
.bw-banner{border-radius:10px;padding:.625rem .875rem;font-size:.875rem;margin-bottom:1rem}
.bw-banner-danger{background:rgba(255,59,48,.1);color:#b8281f}

/* ---- step2 diff cards ---- */
.bw-diff-card{padding:.625rem 0;border-bottom:1px solid var(--bw-border)}
.bw-diff-card:last-child{border-bottom:none}
.bw-diff-title{font-size:.875rem;font-weight:600;margin-bottom:.375rem}
.bw-diff-row{display:flex;align-items:center;gap:.625rem;flex-wrap:wrap}
.bw-diff-arrow{color:var(--bw-muted)}
.bw-diff-target{font-weight:600;color:var(--bw-tint)}
.bw-diff-side{display:flex;flex-direction:column;gap:.375rem}
.bw-queue-line{display:flex;flex-direction:column}
.bw-time-local{font-size:.875rem}
.bw-time-utc{font-size:.75rem;color:var(--bw-muted);font-family:ui-monospace,SFMono-Regular,monospace}
.bw-queue-empty{font-size:.8125rem;color:var(--bw-muted)}
.bw-noop-badge{font-size:.6875rem;color:var(--bw-muted);margin-top:.375rem}

/* ---- step4 ledger ---- */
.bw-ledger-row{display:flex;align-items:center;gap:.625rem;padding:.5rem .25rem;border-bottom:1px solid var(--bw-border)}
.bw-ledger-row:last-child{border-bottom:none}
.bw-ledger-key{font-size:.875rem}
.bw-ledger-status{font-size:.8125rem;color:var(--bw-muted)}
.bw-ledger-code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.75rem;color:var(--bw-danger)}

/* ---- step transitions: opacity+translateY fade on each full step re-render (only #wizard's
   direct children get recreated on setStep(); in-step interactions like toggling a checkbox
   don't touch wizardEl itself, so this never replays mid-step). ---- */
#wizard>*{animation:bwFadeIn 180ms ease-out}
@keyframes bwFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes bwFadeInReduced{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: reduce){
  #wizard>*{animation:bwFadeInReduced 180ms ease-out}
  .bw-btn,.bw-plan-row,.bw-connector,.bw-step-circle{transition-duration:0ms}
  .bw-btn:active{transform:none}
}
`

let stylesInjected = false
// Idempotent by a module-level flag rather than a `document.getElementById` existence check —
// tests/ui/fakeDom.ts's getElementById auto-vivifies a fresh (unattached) element on first miss,
// which would make an existence check always look "already there" and never actually append.
// A module flag also matches production reality: initWizard() runs exactly once per page load.
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)
}

// Duck-typed subset of @modelcontextprotocol/ext-apps's `App` — the only two members this panel
// touches. Test seam: this lets tests/ui/batchWizard.test.ts drive initWizard() directly with a
// stub, instead of replaying a full MCP `ui/initialize` postMessage handshake (see that test
// file's header comment for why that full replay isn't attempted). A real `App` instance
// satisfies this structurally, so connectApp(...).then(initWizard) below needs no cast.
export interface WizardApp {
  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    isError?: boolean
    structuredContent?: { items?: unknown[]; errors?: Array<{ code?: string; message?: string }> }
  }>
  ontoolresult: ((params: { structuredContent?: { items?: unknown[] } }) => void) | undefined
}

interface RowState {
  checkbox: HTMLInputElement
  badge: HTMLElement
  rowEl: HTMLElement
  prod_oid: string
  pkg_oid: string
  pkg_name: string
  item_oid?: string
  supplier_oid?: string
  is_bundle?: boolean
  queue: ScheduleEntry[]
}

function showFallback(el: HTMLElement, m: string): void { el.hidden = false; el.textContent = m }

// Recomputes a plan row's visual state (checked tint / bundle dim) from its current
// checkbox/is_bundle state. Presentation-only — never touches `checked` itself. Called on initial
// render, inside the row's own onclick, and for every sibling syncSiblings() auto-toggles (so the
// tint follows the same "whole write unit moves together" rule the checked/badge state already
// follows).
function updateRowChecked(r: RowState): void {
  const cls = ['bw-plan-row']
  if (r.checkbox.checked) cls.push('bw-plan-row-checked')
  if (r.is_bundle) cls.push('bw-plan-row-bundle')
  r.rowEl.className = cls.join(' ')
}

function primaryBtn(text: string, role: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = text
  b.className = 'bw-btn bw-btn-primary'
  b.dataset.role = role
  b.onclick = onclick
  return b
}
function secondaryBtn(text: string, role: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = text
  b.className = 'bw-btn bw-btn-secondary'
  b.dataset.role = role
  b.onclick = onclick
  return b
}

export function initWizard(app: WizardApp): void {
  injectStyles()

  const headerEl = document.getElementById('header')!
  const statusEl = document.getElementById('status')!
  const progressEl = document.getElementById('progress')!
  const wizardEl = document.getElementById('wizard')!
  const fallbackEl = document.getElementById('fallback') as HTMLPreElement
  progressEl.className = 'bw-progress'

  let actionType: ActionType = 'inventory_platform'
  let step = 1
  let rows: RowState[] = []
  let radioButtons: HTMLInputElement[] = []
  let noteValue = ''
  let lastTz = 'Asia/Taipei'

  let changesetId: string | undefined
  let currentNonce: string | undefined
  let currentDiffVersion: string | undefined
  let currentDiffItems: Array<Record<string, unknown>> = []

  const STEP_LABELS = ['選擇', '檢視', '批准', '結果']
  function renderProgress(): void {
    progressEl.textContent = ''
    STEP_LABELS.forEach((label, i) => {
      const n = i + 1
      if (i > 0) {
        const connector = document.createElement('span')
        connector.className = `bw-connector${n - 1 < step ? ' bw-connector-done' : ''}`
        progressEl.appendChild(connector)
      }
      const stepEl = document.createElement('span')
      stepEl.className = `bw-step ${n < step ? 'bw-step-done' : n === step ? 'bw-step-current' : 'bw-step-pending'}`
      const circle = document.createElement('span')
      circle.className = 'bw-step-circle'
      renderText(circle, n < step ? '✓' : String(n))
      stepEl.appendChild(circle)
      const labelSpan = document.createElement('span')
      labelSpan.className = 'bw-step-label'
      renderText(labelSpan, label)
      stepEl.appendChild(labelSpan)
      progressEl.appendChild(stepEl)
    })
  }
  function setStep(n: number): void { step = n; renderProgress() }

  // ---- Step 1: 選擇 ----
  function renderStep1(prefillProdOids: string[]): void {
    setStep(1)
    wizardEl.textContent = ''
    rows = []
    radioButtons = []

    const inputCard = document.createElement('div')
    inputCard.className = 'bw-card'
    const inputCardTitle = document.createElement('div')
    inputCardTitle.className = 'bw-card-title'
    renderText(inputCardTitle, '商品')
    inputCard.appendChild(inputCardTitle)
    const inputRow = document.createElement('div')
    inputRow.className = 'bw-row-inline'

    const prodInput = document.createElement('input')
    prodInput.type = 'text'
    prodInput.className = 'bw-input'
    prodInput.placeholder = '商品 oid，逗號或空白分隔'
    prodInput.value = prefillProdOids.join(', ')
    prodInput.dataset.role = 'prodOidsInput'
    inputRow.appendChild(prodInput)

    const loadBtn = primaryBtn('載入', 'loadBtn', () => { void doLoad(prodInput.value) })
    inputRow.appendChild(loadBtn)
    inputCard.appendChild(inputRow)
    wizardEl.appendChild(inputCard)

    const planTableEl = document.createElement('div')
    planTableEl.className = 'bw-card'
    planTableEl.dataset.role = 'planTable'
    wizardEl.appendChild(planTableEl)

    if (actionType === 'shelf_schedule') wizardEl.appendChild(renderDefaultTimeBar())

    const footerCard = document.createElement('div')
    footerCard.className = 'bw-card bw-row-footer'
    const noteInput = document.createElement('input')
    noteInput.type = 'text'
    noteInput.className = 'bw-input bw-note'
    noteInput.placeholder = '備註（選填）'
    noteInput.dataset.role = 'noteInput'
    noteInput.onchange = () => { noteValue = noteInput.value }
    footerCard.appendChild(noteInput)

    const nextBtn = primaryBtn('下一步', 'nextBtn', () => { void doNext() })
    footerCard.appendChild(nextBtn)
    wizardEl.appendChild(footerCard)

    async function doLoad(raw: string): Promise<void> {
      const prodOids = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
      if (prodOids.length === 0) { showFallback(fallbackEl, '請輸入至少一個商品 oid'); return }
      statusEl.textContent = '載入中…'
      try {
        const r = await app.callServerTool({ name: 'app_get_batch_view', arguments: { action_type: actionType, prod_oids: prodOids } })
        if (r.isError) { showFallback(fallbackEl, '載入失敗'); return }
        const products = (r.structuredContent?.items?.[0] as { products?: unknown[] } | undefined)?.products ?? []
        renderPlanTable(planTableEl, products as Array<{ prod_oid: string; name?: string; plans: Array<Record<string, unknown>> }>)
        statusEl.textContent = `已載入 ${products.length} 個商品`
      } catch (e) { showFallback(fallbackEl, '載入失敗：' + String(e)) }
    }

    // 列可見性（review fix 2, spec §5.4）：filter（比對方案名/pkg_oid,即時）與「隱藏未勾選」toggle
    // 兩個條件都成立才顯示。只影響顯示,不動 checked 狀態——buildXxxItems() 仍以 checked 為準,
    // 被 filter 藏起來的已勾選列一樣會進批次（所以配 fix 3 的整組連動,不會出現「看不見但被送出」
    // 的驚喜組合:被藏的列必然是使用者自己勾的或連動標示過的）。
    let filterQuery = ''
    let hideUnchecked = false
    function applyVisibility(): void {
      const q = filterQuery.toLowerCase()
      for (const r of rows) {
        const matchesFilter = q === '' || r.pkg_name.toLowerCase().includes(q) || r.pkg_oid.toLowerCase().includes(q)
        r.rowEl.hidden = !matchesFilter || (hideUnchecked && !r.checkbox.checked)
      }
    }

    function renderPlanTable(container: HTMLElement, products: Array<{ prod_oid: string; name?: string; plans: Array<Record<string, unknown>> }>): void {
      container.textContent = ''
      rows = []
      radioButtons = []
      filterQuery = ''
      hideUnchecked = false

      const cardTitle = document.createElement('div')
      cardTitle.className = 'bw-card-title'
      renderText(cardTitle, '方案清單')
      container.appendChild(cardTitle)

      const filterBar = document.createElement('div')
      filterBar.className = 'bw-table-toolbar'
      const filterInput = document.createElement('input')
      filterInput.type = 'text'
      filterInput.className = 'bw-input'
      ;(filterInput as HTMLInputElement).placeholder = '篩選方案…'
      filterInput.dataset.role = 'filterInput'
      filterInput.oninput = () => { filterQuery = filterInput.value.trim(); applyVisibility() }
      filterBar.appendChild(filterInput)
      const hideBtn = secondaryBtn('隱藏未勾選', 'hideUncheckedBtn', () => {
        hideUnchecked = !hideUnchecked
        hideBtn.textContent = hideUnchecked ? '顯示全部' : '隱藏未勾選'
        applyVisibility()
      })
      filterBar.appendChild(hideBtn)
      container.appendChild(filterBar)

      if (actionType === 'inventory_platform') {
        const radioBar = document.createElement('div')
        radioBar.className = 'bw-radio-bar'
        for (const target of ['BE2', 'BE2_SCM', 'EXTERNAL']) {
          const label = document.createElement('label')
          const r = document.createElement('input')
          r.type = 'radio'; r.name = 'target'; r.value = target
          radioButtons.push(r)
          label.appendChild(r)
          const span = document.createElement('span'); renderText(span, target)
          label.appendChild(span)
          radioBar.appendChild(label)
        }
        container.appendChild(radioBar)
      }

      const headRow = document.createElement('div')
      headRow.className = 'bw-plan-head'
      for (const label of ['', '方案', '供應商', '現況', '']) {
        const cell = document.createElement('span')
        renderText(cell, label)
        headRow.appendChild(cell)
      }
      container.appendChild(headRow)

      for (const prod of products) {
        for (const plan of prod.plans) {
          const row = document.createElement('div')
          const cb = document.createElement('input')
          cb.type = 'checkbox'
          cb.dataset.pkgOid = String(plan.pkg_oid)
          const itemOid = plan.item_oid as string | undefined
          const supplierOid = plan.supplier_oid as string | undefined
          if (itemOid) cb.dataset.itemOid = itemOid
          const isBundle = plan.is_bundle === true
          if (actionType === 'shelf_schedule' && isBundle) cb.disabled = true
          const badge = document.createElement('span')
          renderText(badge, '將一併變更')
          badge.className = 'bw-co-badge'
          badge.dataset.role = 'coBadge'
          badge.hidden = true
          const rs: RowState = {
            checkbox: cb, badge, rowEl: row, prod_oid: prod.prod_oid, pkg_oid: String(plan.pkg_oid),
            pkg_name: (plan.name as string | undefined) ?? String(plan.pkg_oid),
            item_oid: itemOid, supplier_oid: supplierOid, is_bundle: isBundle, queue: [],
          }
          rows.push(rs)
          updateRowChecked(rs)
          cb.onclick = () => {
            if (actionType === 'inventory_platform') syncSiblings(rs)
            updateRowChecked(rs)
            applyVisibility() // hideUnchecked 開啟時,勾/取消勾都可能改變本列(與連動列)的可見性
          }
          row.appendChild(cb)

          // 方案名 + pkg_oid 小字灰 + bundle 小標（僅列名欄,不影響 checkbox 仍是 row 的直接子節點
          // ——tests/ui/batchWizard.test.ts 用 checkbox.parentNode 定位「這一列」）。
          const nameCell = document.createElement('div')
          nameCell.className = 'bw-plan-name'
          const nameTop = document.createElement('div')
          nameTop.className = 'bw-plan-name-top'
          const nameSpan = document.createElement('span')
          renderText(nameSpan, rs.pkg_name)
          nameTop.appendChild(nameSpan)
          if (isBundle) {
            const bundleTag = document.createElement('span')
            bundleTag.className = 'bw-bundle-tag'
            renderText(bundleTag, 'bundle')
            nameTop.appendChild(bundleTag)
          }
          nameCell.appendChild(nameTop)
          const oidSpan = document.createElement('span')
          oidSpan.className = 'bw-plan-name-oid'
          renderText(oidSpan, rs.pkg_oid)
          nameCell.appendChild(oidSpan)
          row.appendChild(nameCell)

          // brief: 方案表格需含「供應商、現況欄」——供應商用 be2 內容(untrusted)一律 renderText 純文字;
          // current_platform 可能 null(讀不到,非「否」),顯示「—」而非空白或 false,避免使用者誤讀成
          // 已確定某個平台(src/tools/batchView.ts resolveCurrentPlatform 的 PLATFORM_READ_UNAVAILABLE
          // 就是為了不讓 unknown 被誤呈現成一個確定值)。
          const supplierSpan = document.createElement('span')
          renderText(supplierSpan, plan.supplier_name ? String(plan.supplier_name) : '—')
          row.appendChild(supplierSpan)

          // 現況欄：色點＋文字。點的顏色是我方純呈現邏輯算出來的(有值=tint、無資料=灰),不是把
          // be2 回傳值重新詮釋成「上/下架」——inventory_platform 這裡沒有布林式開關語意,只有平台
          // 歸屬字串,故不套用「綠=上架/紅=下架」這組語意(那組留給真的有 boolean 狀態的欄位)。
          const statusWrap = document.createElement('span')
          statusWrap.className = 'bw-status-badge'
          const dot = document.createElement('span')
          const statusSpan = document.createElement('span')
          if (actionType === 'inventory_platform') {
            const hasPlatform = plan.current_platform != null
            dot.className = `bw-dot ${hasPlatform ? 'bw-dot-green' : 'bw-dot-gray'}`
            renderText(statusSpan, hasPlatform ? String(plan.current_platform) : '—')
          } else {
            const queueLen = Array.isArray(plan.reserve_queue) ? plan.reserve_queue.length : 0
            dot.className = `bw-dot ${isBundle ? 'bw-dot-gray' : queueLen > 0 ? 'bw-dot-green' : 'bw-dot-gray'}`
            renderText(statusSpan, isBundle ? '(bundle，不可個別排程)' : queueLen > 0 ? `現有 ${queueLen} 筆排程` : '（無排程）')
          }
          statusWrap.appendChild(dot)
          statusWrap.appendChild(statusSpan)
          row.appendChild(statusWrap)

          row.appendChild(badge)
          container.appendChild(row)
        }
      }
    }

    // 寫入單位是 (item_oid, supplier_oid)（src/changeset/types.ts InventoryPlatformItem;
    // batchValidate.ts 的重複鍵檢查同此),所以連動必須同時比對兩者——review fix 1:先前只比
    // item_oid,會把「同 item、不同 supplier」的方案(不同寫入單位)誤連動,靜默把使用者沒選的
    // supplier 納入批次。
    // 對稱雙向（review fix 3）:同一寫入單位要嘛整組進、要嘛整組不進——取消勾選任一列(含被自動
    // 連動的兄弟列)時,整組一起取消,並移除所有「將一併變更」標示,不留「未勾選卻掛著連動標示」
    // 的殘留誤導。
    function syncSiblings(changed: RowState): void {
      if (!changed.item_oid) return
      const on = changed.checkbox.checked
      for (const r of rows) {
        if (r !== changed && r.item_oid === changed.item_oid && r.supplier_oid === changed.supplier_oid) {
          r.checkbox.checked = on
          r.badge.hidden = !on
          updateRowChecked(r)
        }
      }
      // 自己這列的 badge:勾選發起者本人不掛「將一併變更」(那是標示「被連帶」的列);取消時一律清。
      if (!on) changed.badge.hidden = true
    }

    function renderDefaultTimeBar(): HTMLElement {
      const bar = document.createElement('div')
      bar.className = 'bw-card'
      const title = document.createElement('div')
      title.className = 'bw-card-title'
      renderText(title, '預設時間套用')
      bar.appendChild(title)
      const row = document.createElement('div')
      row.className = 'bw-row-inline'
      const date = document.createElement('input'); date.type = 'date'; date.className = 'bw-input'; date.dataset.role = 'defDate'
      const hour = document.createElement('input'); hour.type = 'number'; hour.value = '0'; hour.className = 'bw-input'; hour.dataset.role = 'defHour'
      const minute = document.createElement('input'); minute.type = 'number'; minute.value = '0'; minute.className = 'bw-input'; minute.dataset.role = 'defMinute'
      const tz = document.createElement('select'); tz.className = 'bw-select'; tz.dataset.role = 'defTz'
      for (const z of ['Asia/Taipei', 'Asia/Tokyo', 'UTC']) {
        const opt = document.createElement('option'); opt.value = z; renderText(opt, z); tz.appendChild(opt)
      }
      tz.value = 'Asia/Taipei'
      const status = document.createElement('select'); status.className = 'bw-select'; status.dataset.role = 'defStatus'
      for (const [v, label] of [['true', '上架'], ['false', '下架']]) {
        const opt = document.createElement('option'); opt.value = v; renderText(opt, label); status.appendChild(opt)
      }
      status.value = 'true'
      const applyBtn = secondaryBtn('套用到所有已勾選', 'applyAllBtn', () => {
        lastTz = tz.value
        const utc = toReserveDateUtc(date.value, Number(hour.value), Number(minute.value), tz.value)
        for (const r of rows) {
          if (r.checkbox.checked && !r.is_bundle) r.queue.push({ reserve_date_utc: utc, reserve_status: status.value === 'true' })
        }
      })
      row.appendChild(date); row.appendChild(hour); row.appendChild(minute); row.appendChild(tz); row.appendChild(status); row.appendChild(applyBtn)
      bar.appendChild(row)
      return bar
    }

    function buildInventoryPlatformItems(): Array<{ item_oid: string; supplier_oid: string; target: string; affected_pkgs: AffectedPkg[] }> {
      const target = radioButtons.find(r => r.checked)?.value ?? 'BE2'
      const groups = new Map<string, { item_oid: string; supplier_oid: string; target: string; affected_pkgs: AffectedPkg[] }>()
      for (const r of rows) {
        if (!r.checkbox.checked || !r.item_oid || !r.supplier_oid) continue
        const key = `${r.item_oid}:${r.supplier_oid}`
        let g = groups.get(key)
        if (!g) { g = { item_oid: r.item_oid, supplier_oid: r.supplier_oid, target, affected_pkgs: [] }; groups.set(key, g) }
        g.affected_pkgs.push({ prod_oid: r.prod_oid, pkg_oid: r.pkg_oid, pkg_name: r.pkg_name })
      }
      return [...groups.values()]
    }

    function buildShelfScheduleItems(): Array<{ prod_oid: string; pkg_oid: string; queue: ScheduleEntry[] }> {
      return rows.filter(r => r.checkbox.checked && !r.is_bundle && r.queue.length > 0)
        .map(r => ({ prod_oid: r.prod_oid, pkg_oid: r.pkg_oid, queue: r.queue }))
    }

    async function doNext(): Promise<void> {
      const items = actionType === 'inventory_platform' ? buildInventoryPlatformItems() : buildShelfScheduleItems()
      if (items.length === 0) { showFallback(fallbackEl, '請至少勾選一筆並填妥必要欄位'); return }
      statusEl.textContent = '建立變更中…'
      try {
        const createR = await app.callServerTool({
          name: 'app_create_changeset',
          arguments: { action_type: actionType, items, ...(noteValue ? { note: noteValue } : {}) },
        })
        if (createR.isError) { showFallback(fallbackEl, '建立變更失敗'); return }
        const created = createR.structuredContent?.items?.[0] as { changeset_id?: string } | undefined
        if (!created?.changeset_id) { showFallback(fallbackEl, '建立變更失敗：未取得 changeset_id'); return }
        changesetId = created.changeset_id
        const rec = await loadView()
        if (!rec) return
        renderStep2(rec)
      } catch (e) { showFallback(fallbackEl, '建立變更失敗：' + String(e)) }
    }
  }

  async function loadView(): Promise<Record<string, unknown> | undefined> {
    const r = await app.callServerTool({ name: 'app_get_changeset_view', arguments: { changeset_id: changesetId } })
    if (r.isError) { showFallback(fallbackEl, '讀取變更失敗'); return undefined }
    const rec = (r.structuredContent?.items?.[0] as Record<string, unknown> | undefined) ?? {}
    const diff = rec.diff as { items?: Array<Record<string, unknown>> } | undefined
    currentDiffItems = diff?.items ?? []
    currentNonce = rec.nonce as string | undefined
    currentDiffVersion = rec.diff_version as string | undefined
    return rec
  }

  // 每筆日期項的雙顯示（GMT+X 淡字在上、UTC mono 小字在下）——重用 formatDualDisplay 的既有
  // 時區換算(不重寫時間數學),只是把它回傳的單行字串依既定分隔符拆成兩個獨立元素方便分層上色。
  function renderQueueLines(el: HTMLElement, queue: ScheduleEntry[]): void {
    if (queue.length === 0) {
      const p = document.createElement('div')
      p.className = 'bw-queue-empty'
      renderText(p, '(空，將清除排程)')
      el.appendChild(p)
      return
    }
    for (const e of queue) {
      const line = document.createElement('div')
      line.className = 'bw-queue-line'
      const full = formatDualDisplay(e.reserve_date_utc, lastTz)
      const sepIdx = full.indexOf(' / ')
      const localPart = sepIdx === -1 ? full : full.slice(0, sepIdx)
      const utcPart = sepIdx === -1 ? '' : full.slice(sepIdx + 3)
      const localSpan = document.createElement('span')
      localSpan.className = 'bw-time-local'
      renderText(localSpan, localPart)
      line.appendChild(localSpan)
      if (utcPart) {
        const utcSpan = document.createElement('span')
        utcSpan.className = 'bw-time-utc'
        renderText(utcSpan, utcPart)
        line.appendChild(utcSpan)
      }
      el.appendChild(line)
    }
  }

  function renderDiffCard(d: Record<string, unknown>): HTMLElement {
    const card = document.createElement('div')
    card.className = 'bw-diff-card'
    if (actionType === 'shelf_schedule' && Array.isArray(d.new_queue)) {
      const title = document.createElement('div')
      title.className = 'bw-diff-title'
      renderText(title, d.pkg_name ?? d.pkg_oid)
      card.appendChild(title)

      const row = document.createElement('div')
      row.className = 'bw-diff-row'
      const curSide = document.createElement('div')
      curSide.className = 'bw-diff-side'
      renderQueueLines(curSide, Array.isArray(d.current_queue) ? (d.current_queue as ScheduleEntry[]) : [])
      const arrow = document.createElement('span')
      arrow.className = 'bw-diff-arrow'
      renderText(arrow, '→')
      const newSide = document.createElement('div')
      newSide.className = 'bw-diff-side'
      renderQueueLines(newSide, d.new_queue as ScheduleEntry[])
      row.appendChild(curSide); row.appendChild(arrow); row.appendChild(newSide)
      card.appendChild(row)

      if (d.noop) {
        const noop = document.createElement('div')
        noop.className = 'bw-noop-badge'
        renderText(noop, '此筆現況與目標相同，將不產生實際變更')
        card.appendChild(noop)
      }
      return card
    }
    if (actionType === 'inventory_platform' && 'target' in d) {
      const affected = Array.isArray(d.affected_pkgs) ? (d.affected_pkgs as AffectedPkg[]) : []
      const title = document.createElement('div')
      title.className = 'bw-diff-title'
      renderText(title, affected.length ? affected.map(p => p.pkg_name).join('、') : `${d.item_oid}:${d.supplier_oid}`)
      card.appendChild(title)

      const row = document.createElement('div')
      row.className = 'bw-diff-row'
      const curSpan = document.createElement('span')
      renderText(curSpan, d.current != null ? String(d.current) : '—')
      const arrow = document.createElement('span')
      arrow.className = 'bw-diff-arrow'
      renderText(arrow, '→')
      const targetSpan = document.createElement('span')
      targetSpan.className = 'bw-diff-target'
      renderText(targetSpan, d.target != null ? String(d.target) : '—')
      row.appendChild(curSpan); row.appendChild(arrow); row.appendChild(targetSpan)
      card.appendChild(row)

      if (d.noop) {
        const noop = document.createElement('div')
        noop.className = 'bw-noop-badge'
        renderText(noop, '此筆現況與目標相同，將不產生實際變更')
        card.appendChild(noop)
      }
      return card
    }
    // Fallback for any other/unknown diff shape — raw dump, same safety net the prior version had.
    renderText(card, d)
    return card
  }

  // ---- Step 2: 檢視 ----
  function renderStep2(rec: Record<string, unknown>): void {
    setStep(2)
    wizardEl.textContent = ''
    if (actionType === 'shelf_schedule') {
      const warn = document.createElement('div')
      warn.className = 'bw-banner bw-banner-danger'
      renderText(warn, '原排程將被整組取代（reserve_queue 為整組替換、非合併）')
      wizardEl.appendChild(warn)
    }

    const listCard = document.createElement('div')
    listCard.className = 'bw-card'
    for (const d of currentDiffItems) listCard.appendChild(renderDiffCard(d))
    wizardEl.appendChild(listCard)

    if (rec.note) {
      const noteCard = document.createElement('div')
      noteCard.className = 'bw-card'
      const noteP = document.createElement('p')
      renderText(noteP, `備註：${String(rec.note)}`)
      noteCard.appendChild(noteP)
      wizardEl.appendChild(noteCard)
    }

    const footer = document.createElement('div')
    footer.className = 'bw-row-footer'
    footer.appendChild(primaryBtn('前往批准', 'toApproveBtn', () => renderStep3()))
    wizardEl.appendChild(footer)
  }

  // ---- Step 3: 批准 ----
  function renderStep3(): void {
    setStep(3)
    wizardEl.textContent = ''
    const card = document.createElement('div')
    card.className = 'bw-card'
    const desc = document.createElement('p')
    renderText(desc, '按下後將送出批准並立即執行本次變更。')
    card.appendChild(desc)
    const footer = document.createElement('div')
    footer.className = 'bw-row-footer'
    footer.appendChild(primaryBtn('確認執行', 'approveBtn', () => { void doApprove() }))
    card.appendChild(footer)
    wizardEl.appendChild(card)
  }

  async function doApprove(): Promise<void> {
    if (!changesetId || !currentNonce || !currentDiffVersion) { showFallback(fallbackEl, '缺少批准所需資訊，請回上一步重載'); return }
    statusEl.textContent = '執行中…'
    const confirmedKeys = currentDiffItems.map(itemKeyOf)
    try {
      const r = await app.callServerTool({
        name: 'app_confirm_changeset',
        arguments: { changeset_id: changesetId, decision: 'approve', nonce: currentNonce, diff_version: currentDiffVersion, confirmed_keys: confirmedKeys },
      })
      const env = r.structuredContent
      const err = env?.errors?.[0]
      // Final whole-branch review Important 2: DIFF_STALE used to be a dead end — the panel just
      // showed a message and stopped, with no way for the user to get back to an approvable state
      // short of closing/reopening the wizard. Server now also writes the recomputed diff+version
      // back to the store on staleness detection (confirmService.ts), so a fresh
      // app_get_changeset_view call (via doReload below) picks up a diff/nonce that WILL match on
      // the next approval attempt (barring further live drift). Offer that reload inline instead
      // of a dead-end message.
      if (err?.code === 'DIFF_STALE') { renderStaleNotice(); return }
      if (err) { showFallback(fallbackEl, `批准失敗：${err.code ?? ''} ${err.message ?? ''}`); return }
      const rec = (env?.items?.[0] as { results?: unknown[] } | undefined) ?? {}
      renderStep4((rec.results as Array<Record<string, unknown>> | undefined) ?? [])
    } catch (e) { showFallback(fallbackEl, '送出失敗：' + String(e)) }
  }

  function renderStaleNotice(): void {
    showFallback(fallbackEl, '現況已變，請按下方按鈕重新載入檢視後再次批准')
    const reloadBtn = secondaryBtn('回檢視重載', 'reloadBtn', () => { void doReload() })
    wizardEl.appendChild(reloadBtn)
  }

  async function doReload(): Promise<void> {
    fallbackEl.hidden = true
    statusEl.textContent = '重新載入中…'
    const rec = await loadView()
    if (!rec) return
    renderStep2(rec)
  }

  // ---- Step 4: 結果 ----
  function renderStep4(results: Array<Record<string, unknown>>): void {
    setStep(4)
    wizardEl.textContent = ''
    statusEl.textContent = '完成'
    const card = document.createElement('div')
    card.className = 'bw-card'
    for (const res of results) {
      const row = document.createElement('div')
      row.dataset.itemKey = String(res.item_key)
      row.dataset.status = String(res.status)
      const status = res.status
      const kind = status === 'done' ? 'ok' : status === 'skipped_noop' ? 'skip' : 'error'
      row.className = 'bw-ledger-row'

      const dot = document.createElement('span')
      dot.className = `bw-dot ${kind === 'ok' ? 'bw-dot-green' : kind === 'skip' ? 'bw-dot-gray' : 'bw-dot-red'}`
      row.appendChild(dot)

      let primaryText = String(res.item_key)
      let secondaryText = ''

      const matchedDiff = currentDiffItems.find(d => {
        if ('item_oid' in d) return `${d.item_oid}:${d.supplier_oid}` === res.item_key
        if ('prod_oid' in d && 'pkg_oid' in d) return `${d.prod_oid}:${d.pkg_oid}` === res.item_key
        return false
      })

      if (matchedDiff) {
        if ('item_oid' in matchedDiff) {
          primaryText = `item ${matchedDiff.item_oid} × supplier ${matchedDiff.supplier_oid}`
          const pkgs = Array.isArray(matchedDiff.affected_pkgs) ? (matchedDiff.affected_pkgs as AffectedPkg[]).map(p => p.pkg_name).join('、') : ''
          secondaryText = pkgs ? `${pkgs} (${res.item_key})` : String(res.item_key)
        } else {
          primaryText = String(matchedDiff.pkg_name ?? res.item_key)
          secondaryText = String(res.item_key)
        }
      }

      const keyWrap = document.createElement('div')
      keyWrap.className = 'bw-plan-name'
      
      const primarySpan = document.createElement('span')
      primarySpan.className = 'bw-ledger-key'
      renderText(primarySpan, primaryText)
      keyWrap.appendChild(primarySpan)

      if (secondaryText) {
        const subSpan = document.createElement('span')
        subSpan.className = 'bw-plan-name-oid'
        renderText(subSpan, secondaryText)
        keyWrap.appendChild(subSpan)
      }

      row.appendChild(keyWrap)

      const statusSpan = document.createElement('span')
      statusSpan.className = 'bw-ledger-status'
      renderText(statusSpan, String(res.status))
      row.appendChild(statusSpan)

      if (kind === 'error') {
        const codeSpan = document.createElement('span')
        codeSpan.className = 'bw-ledger-code'
        renderText(codeSpan, String(res.error_code ?? ''))
        row.appendChild(codeSpan)
      }
      card.appendChild(row)
    }
    wizardEl.appendChild(card)
  }

  app.ontoolresult = params => {
    try {
      const env = params.structuredContent
      const rec = (env?.items?.[0] as { action_type?: ActionType; prod_oids?: string[] } | undefined) ?? {}
      actionType = rec.action_type ?? 'inventory_platform'
      headerEl.className = 'bw-title'
      renderText(headerEl, ACTION_LABELS[actionType])
      renderStep1(rec.prod_oids ?? [])
    } catch (e) { showFallback(fallbackEl, '渲染失敗：' + String(e)) }
  }
}

// Test seam (see this file's WizardApp doc comment and tests/ui/batchWizard.test.ts's header):
// only wire up the real connectApp()/MCP-transport path when a real `window` exists. Importing
// this module under a document-only stub (no `window`) must not throw at import time — it must
// stay import-safe so tests can call initWizard() directly with an injected stub app.
if (typeof window !== 'undefined') {
  connectApp('be2-batch-wizard').then(initWizard).catch(e => {
    const fallback = document.getElementById('fallback') as HTMLPreElement
    showFallback(fallback, '無法連上 host：' + String(e))
  })
}
