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
import { inventoryPlatformWizard } from '../modules/product/inventoryPlatform/ui.js'
import { shelfScheduleWizard } from '../modules/product/shelfSchedule/ui.js'
import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../core/changeset/module.js'

type ActionType = 'inventory_platform' | 'shelf_schedule'

const WIZARDS: Record<ActionType, WizardDescriptor> = {
  inventory_platform: inventoryPlatformWizard,
  shelf_schedule: shelfScheduleWizard
}

interface ScheduleEntry { reserve_date_utc: string; reserve_status: boolean }
interface AffectedPkg { prod_oid: string; pkg_oid: string; pkg_name: string }

// Fixed offsets — demo scope only (brief: "禁第三方庫"). DST is NOT modeled; do not reuse this
// for anything beyond the wizard's local<->UTC display/input conversion.
const TZ_OFFSET_HOURS: Record<string, number> = { 'Asia/Taipei': 8, 'Asia/Tokyo': 9, UTC: 0 }

// 供應商庫存管理的人話標籤（對齊 be2/BAA 的 radio 文案；值仍是 enum 碼）
const PLATFORM_LABELS: Record<string, string> = {
  BE2: 'BE2 管理',
  BE2_SCM: 'BE2 / SCM 管理',
  EXTERNAL: '串接外部庫存（包含 rezio）',
}
const platformLabel = (v: string | null | undefined): string => (v == null ? '無法讀取' : (PLATFORM_LABELS[v] ?? v))

// formatDualDisplay 的既有時區換算(不重寫時間數學),只是把它回傳的單行字串依既定分隔符拆成兩個獨立元素方便分層上色。
function pad2(n: number): string { return String(n).padStart(2, '0') }

export function toReserveDateUtc(dateStr: string, hh: number, mm: number, tz: string): string {
  const offset = TZ_OFFSET_HOURS[tz] ?? 0
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d, hh - offset, mm, 0))
  const res = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())} ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:00`
  if (res.includes('NaN')) throw new Error('INVALID_DATE')
  return res
}

export function formatDualDisplay(reserveDateUtc: string, tz: string): string {
  const offset = TZ_OFFSET_HOURS[tz] ?? 0
  const ms = Date.parse(reserveDateUtc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return reserveDateUtc
  const local = new Date(ms + offset * 3600_000)
  const localStr = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`
  const sign = offset >= 0 ? '+' : '-'
  return `${localStr} (GMT${sign}${Math.abs(offset)}) / ${reserveDateUtc} UTC`
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
/* 列/行元素帶 display:grid/flex 的 class 會蓋掉 UA 的 [hidden]{display:none}——tabs/篩選/隱藏未勾選
   全靠 hidden 屬性運作，必須用 !important 奪回（fakeDom 測試只驗 .hidden 屬性，抓不到這個真瀏覽器 bug）。 */
[hidden]{display:none!important}
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

/* ---- tabs ---- */
.bw-tabbar{display:inline-flex;gap:2px;margin-bottom:1rem;padding:3px;background:#e5e5ea;border-radius:10px;overflow-x:auto;max-width:100%}
.bw-tab{display:flex;flex-direction:column;gap:.125rem;padding:.375rem 1rem;border-radius:7px;cursor:pointer;border:none;background:transparent;text-align:center;font-family:inherit;color:var(--bw-muted);transition:background-color 150ms ease-out,box-shadow 150ms ease-out,color 150ms ease-out}
.bw-tab:hover{background:rgba(0,0,0,.04)}
.bw-tab-active{background:#fff;color:var(--bw-tint);box-shadow:0 1px 3px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.04)}
.bw-tab-active:hover{background:#fff}
.bw-tab-danger{color:var(--bw-danger)}
.bw-tab-active.bw-tab-danger{color:var(--bw-danger)}
.bw-tab-name{font-size:.8125rem;font-weight:600;color:inherit}
.bw-tab-oid{font-size:.6875rem;opacity:0.8;color:inherit}
.bw-not-found-msg{padding:1rem .5rem;color:var(--bw-danger);font-size:.875rem;text-align:center}

/* ---- inputs ---- */
.bw-input,.bw-select{height:2rem;padding:0 .625rem;border-radius:8px;border:1px solid rgba(0,0,0,.14);font:inherit;font-size:.875rem;background:#fff;color:var(--bw-text)}
.bw-input:focus-visible,.bw-select:focus-visible{outline:2px solid var(--bw-tint);outline-offset:1px;border-color:var(--bw-tint)}
.bw-input:disabled,.bw-select:disabled{opacity:.5;cursor:not-allowed;background:#f5f5f7}
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

/* ---- progressive disclosure details ---- */
.bw-plan-row-wrapper{display:flex;flex-direction:column;margin-bottom:.25rem}
.bw-detail-row{padding:.5rem 1rem .5rem 2.5rem;font-size:.8125rem;color:var(--bw-muted);background:rgba(10,132,255,.04);border-radius:0 0 8px 8px;margin-top:-4px}
.bw-target-preview{color:var(--bw-tint);font-weight:500}
.bw-preview-noop{color:var(--bw-muted);font-weight:400}
.bw-detail-muted{color:#a1a1a6}
.bw-ext-warning{margin-top:.5rem;font-size:.8125rem;color:#b8281f;background:rgba(255,59,48,.1);padding:.375rem .75rem;border-radius:6px}

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
.bw-ledger-row .bw-plan-name{flex:1 1 auto;min-width:0}
.bw-ledger-status{flex:0 0 auto;margin-left:auto;font-size:.75rem;font-weight:600;padding:.2rem .625rem;border-radius:999px;white-space:nowrap}
.bw-ledger-status-ok{background:rgba(48,209,88,.15);color:#1d8a3c}
.bw-ledger-status-skip{background:#f0f0f2;color:var(--bw-muted)}
.bw-ledger-status-error{background:rgba(255,59,48,.12);color:var(--bw-danger)}
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
    content?: Array<{ type: string; text: string }>
    structuredContent?: { items?: unknown[]; errors?: Array<{ code?: string; message?: string }> }
  }>
  ontoolresult: ((params: { structuredContent?: { items?: unknown[] } }) => void) | undefined
}

interface RowState {
  checkbox: HTMLInputElement
  badge: HTMLElement
  rowEl: HTMLElement
  wrapperEl: HTMLElement
  detailEl?: HTMLElement
  prod_oid: string
  pkg_oid: string
  pkg_name: string
  item_oid?: string
  supplier_oid?: string
  supplier_name?: string
  is_bundle?: boolean
  is_active?: boolean
  current_platform?: string | null
  inventory_mode?: string
  queue: ScheduleEntry[]
  cleared?: boolean
}

function showFallback(el: HTMLElement, m: string): void { el.hidden = false; el.textContent = m }
function clearFallback(el: HTMLElement): void { el.hidden = true; el.textContent = '' }

// 待送佇列可視化（shelf_schedule 專用；platform 模式的同一顆 badge 由 syncSiblings 顯示
// 「將一併變更」，兩者不同 actionType 不會互踩）：套用後把該列累積的排程明細直接寫在列上——
// 之前只有「將清除排程」有提示，多筆/重套時使用者看不到自己排了什麼，錯套只能整頁重載。
// 時間顯示沿用 store 的 UTC 字串（切到分鐘），前綴標明 UTC；本地時間對照在步驟 2 的
// 雙時區 diff 卡（formatDualDisplay）有完整呈現，這裡以精簡可掃視為先。
function renderQueueBadge(r: RowState): void {
  if (r.cleared) { renderText(r.badge, '將清除排程'); r.badge.hidden = false; return }
  if (r.queue.length === 0) { r.badge.hidden = true; return }
  const parts = [...r.queue]
    .sort((a, b) => (a.reserve_date_utc < b.reserve_date_utc ? -1 : 1))
    .map(q => `${q.reserve_date_utc.slice(5, 16)} ${q.reserve_status ? '上架' : '下架'}`)
  renderText(r.badge, `待送(UTC)：${parts.join('、')}`)
  r.badge.hidden = false
}

// Recomputes a plan row's visual state (checked tint / bundle dim) from its current
// checkbox/is_bundle state. Presentation-only — never touches `checked` itself. Called on initial
// render, inside the row's own onclick, and for every sibling syncSiblings() auto-toggles (so the
// tint follows the same "whole write unit moves together" rule the checked/badge state already
// follows).
function updateRowChecked(r: RowState, dimBundle: boolean): void {
  const cls = ['bw-plan-row']
  if (r.checkbox.checked) cls.push('bw-plan-row-checked')
  // bundle 調暗只屬於排程模式（reserve-active 不支援 bundle）；庫存平台切換對 bundle 完全可寫
  // （live 驗證：bundle 方案帶 item_oid+supplier_mapping，寫入單位不區分 bundle），不可誤暗示不可用。
  if (r.is_bundle && dimBundle) cls.push('bw-plan-row-bundle')
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
  let step1Nodes: Node[] = []
  let lastViewRec: Record<string, unknown> | undefined
  let lastLoadedProdOids: string[] = []

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
    step1Nodes = []

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

    step1Nodes = Array.from(wizardEl.childNodes)

    async function doLoad(raw: string): Promise<void> {
      const prodOids = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
      if (prodOids.length === 0) { showFallback(fallbackEl, '請輸入至少一個商品 oid'); return }
      lastLoadedProdOids = prodOids
      statusEl.textContent = '載入中…'
      try {
        const r = await app.callServerTool({ name: 'app_get_batch_view', arguments: { action_type: actionType, prod_oids: prodOids } })
        if (r.isError) { showFallback(fallbackEl, '載入失敗'); return }
        const structuredContent = r.structuredContent as { items?: unknown[], errors?: Array<{code?: string, message?: string}> } | undefined
        const products = (structuredContent?.items?.[0] as { products?: unknown[] } | undefined)?.products ?? []
        
        const nfErrors = (structuredContent?.errors ?? []).filter(e => e.code === 'PRODUCT_NOT_FOUND')
        if (nfErrors.length > 0) {
          showFallback(fallbackEl, nfErrors.map(e => e.message).join('\n'))
        } else {
          clearFallback(fallbackEl)
        }
        
        renderPlanTable(planTableEl, products as Array<{ prod_oid: string; name?: string; not_found?: boolean; plans: Array<Record<string, unknown>> }>)
        statusEl.textContent = `已載入 ${products.length} 個商品`
      } catch (e) { showFallback(fallbackEl, '載入失敗：' + String(e)) }
    }

    let filterQuery = ''
    let hideUnchecked = false
    let showInactive = false
    let activeProdOid: string | undefined
    let notFoundDivs: Array<{ prod_oid: string; el: HTMLElement }> = []
    function applyVisibility(): void {
      const q = filterQuery.toLowerCase()
      for (const r of rows) {
        const matchesFilter = q === '' || r.pkg_name.toLowerCase().includes(q) || r.pkg_oid.toLowerCase().includes(q)
        const inActiveTab = !activeProdOid || r.prod_oid === activeProdOid
        const isActiveFilter = showInactive || r.is_active !== false
        r.wrapperEl.hidden = !inActiveTab || !matchesFilter || !isActiveFilter || (hideUnchecked && !r.checkbox.checked)
      }
      for (const nf of notFoundDivs) {
        nf.el.hidden = !activeProdOid || nf.prod_oid !== activeProdOid
      }
    }

    function renderPlanTable(container: HTMLElement, products: Array<{ prod_oid: string; name?: string; not_found?: boolean; plans: Array<Record<string, unknown>> }>): void {
      container.textContent = ''
      rows = []
      radioButtons = []
      notFoundDivs = []
      filterQuery = ''
      hideUnchecked = false
      showInactive = false
      activeProdOid = products.length > 1 ? products[0]?.prod_oid : undefined

      const cardTitle = document.createElement('div')
      cardTitle.className = 'bw-card-title'
      renderText(cardTitle, '方案清單')
      container.appendChild(cardTitle)

      if (products.length > 1) {
        const tabbar = document.createElement('div')
        tabbar.className = 'bw-tabbar'
        for (const prod of products) {
          const isNotFound = prod.not_found === true
          const tab = document.createElement('button')
          tab.className = `bw-tab ${prod.prod_oid === activeProdOid ? 'bw-tab-active' : ''}${isNotFound ? ' bw-tab-danger' : ''}`
          const nameSpan = document.createElement('span')
          nameSpan.className = 'bw-tab-name'
          renderText(nameSpan, isNotFound ? '找不到商品' : (prod.name ?? prod.prod_oid))
          const oidSpan = document.createElement('span')
          oidSpan.className = 'bw-tab-oid'
          const planCount = Array.isArray(prod.plans) ? prod.plans.length : 0
          renderText(oidSpan, isNotFound ? prod.prod_oid : `${prod.prod_oid} · ${planCount} 方案`)
          tab.appendChild(nameSpan)
          tab.appendChild(oidSpan)
          tab.onclick = () => {
            activeProdOid = prod.prod_oid
            for (const t of tabbar.querySelectorAll('.bw-tab')) {
              t.className = t.className.includes('bw-tab-danger') ? 'bw-tab bw-tab-danger' : 'bw-tab'
            }
            tab.className += ' bw-tab-active'
            applyVisibility()
          }
          tabbar.appendChild(tab)
        }
        container.appendChild(tabbar)
      }

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
      
      if (actionType === 'inventory_platform') {
        const inactiveLabel = document.createElement('label')
        inactiveLabel.className = 'bw-row-inline'
        inactiveLabel.style.fontSize = '.875rem'
        const inactiveCb = document.createElement('input')
        inactiveCb.type = 'checkbox'
        inactiveCb.checked = false
        inactiveCb.dataset.role = 'showInactiveBtn'
        inactiveCb.onchange = () => { showInactive = inactiveCb.checked; applyVisibility() }
        inactiveLabel.appendChild(inactiveCb)
        const inactiveSpan = document.createElement('span')
        renderText(inactiveSpan, '顯示下架方案')
        inactiveLabel.appendChild(inactiveSpan)
        filterBar.appendChild(inactiveLabel)
      }
      container.appendChild(filterBar)

      if (actionType === 'inventory_platform') {
        const radioBar = document.createElement('div')
        radioBar.className = 'bw-radio-bar'

        const extWarning = document.createElement('div')
        extWarning.className = 'bw-ext-warning'
        extWarning.dataset.role = 'extWarning'
        extWarning.hidden = true
        renderText(extWarning, '串接外部庫存（B2D/B2S/rezio 等）開啟前請先與 IT 確認')

        for (const target of ['BE2', 'BE2_SCM', 'EXTERNAL']) {
          const label = document.createElement('label')
          const r = document.createElement('input')
          r.type = 'radio'; r.name = 'target'; r.value = target
          r.onchange = () => { 
            clearFallback(fallbackEl)
            extWarning.hidden = r.value !== 'EXTERNAL'
            for (const row of rows) updateDetail(row)
          }
          radioButtons.push(r)
          label.appendChild(r)
          const span = document.createElement('span'); renderText(span, platformLabel(target))
          label.appendChild(span)
          radioBar.appendChild(label)
        }
        container.appendChild(radioBar)
        container.appendChild(extWarning)
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
        if (prod.not_found) {
          const msgDiv = document.createElement('div')
          msgDiv.className = 'bw-not-found-msg'
          renderText(msgDiv, '查無此商品，請確認 prod_oid')
          container.appendChild(msgDiv)
          notFoundDivs.push({ prod_oid: prod.prod_oid, el: msgDiv })
        }
        for (const plan of prod.plans) {
          const wrapper = document.createElement('div')
          wrapper.className = 'bw-plan-row-wrapper'

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
            checkbox: cb, badge, rowEl: row, wrapperEl: wrapper, prod_oid: prod.prod_oid, pkg_oid: String(plan.pkg_oid),
            pkg_name: (plan.name as string | undefined) ?? String(plan.pkg_oid),
            item_oid: itemOid, supplier_oid: supplierOid, supplier_name: plan.supplier_name as string | undefined, 
            is_bundle: isBundle, is_active: plan.is_active as boolean | undefined, 
            current_platform: plan.current_platform as string | null | undefined, 
            inventory_mode: plan.inventory_mode as string | undefined, queue: [],
          }
          rows.push(rs)
          updateRowChecked(rs, actionType === 'shelf_schedule')
          cb.onclick = () => {
            clearFallback(fallbackEl)
            if (actionType === 'inventory_platform') syncSiblings(rs)
            updateRowChecked(rs, actionType === 'shelf_schedule')
            updateDetail(rs)
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
          wrapper.appendChild(row)
          container.appendChild(wrapper)
        }
      }
      // 初始渲染就套用一次可見性——多商品時預設只顯示第一個 tab 的方案；
      // 少了這行,非 active 商品的列會全部可見直到第一次點 tab/filter 才被隱藏。
      applyVisibility()
    }

    // 寫入單位是 (item_oid, supplier_oid)（src/changeset/types.ts InventoryPlatformItem;
    // batchValidate.ts 的重複鍵檢查同此),所以連動必須同時比對兩者——review fix 1:先前只比
    // item_oid,會把「同 item、不同 supplier」的方案(不同寫入單位)誤連動,靜默把使用者沒選的
    // supplier 納入批次。
    // 對稱雙向（review fix 3）:同一寫入單位要嘛整組進、要嘛整組不進——取消勾選任一列(含被自動
    // 連動的兄弟列)時,整組一起取消,並移除所有「將一併變更」標示,不留「未勾選卻掛著連動標示」
    // 的殘留誤導。
    function updateDetail(r: RowState): void {
      if (actionType !== 'inventory_platform') return
      if (r.checkbox.checked) {
        if (!r.detailEl) {
          r.detailEl = document.createElement('div')
          r.detailEl.className = 'bw-detail-row'
          r.wrapperEl.appendChild(r.detailEl)
        }
        r.detailEl.textContent = ''
        
        const suppLabel = document.createElement('span')
        const suppText = r.supplier_oid ? `${r.supplier_oid} ${r.supplier_name ?? ''}`.trim() : '—'
        renderText(suppLabel, `供應商: ${suppText} ｜ `)
        r.detailEl.appendChild(suppLabel)

        const curLabel = document.createElement('span')
        const curPlatformText = platformLabel(r.current_platform)
        const isCurNull = r.current_platform == null
        if (isCurNull) curLabel.className = 'bw-detail-muted'
        renderText(curLabel, `目前平台: ${curPlatformText}`)
        r.detailEl.appendChild(curLabel)

        const previewLabel = document.createElement('span')
        const target = radioButtons.find(b => b.checked)?.value ?? 'BE2'
        if (r.current_platform === target) {
          previewLabel.className = 'bw-target-preview bw-preview-noop'
          renderText(previewLabel, ` → ${platformLabel(target)} (相同，將略過)`)
        } else {
          previewLabel.className = 'bw-target-preview'
          renderText(previewLabel, ` → ${platformLabel(target)}`)
        }
        r.detailEl.appendChild(previewLabel)

        if (r.inventory_mode) {
          const modeLabel = document.createElement('span')
          modeLabel.className = 'bw-detail-muted'
          renderText(modeLabel, ` ｜ 庫存模式: ${r.inventory_mode}`)
          r.detailEl.appendChild(modeLabel)
        }
      } else {
        if (r.detailEl) {
          r.wrapperEl.removeChild(r.detailEl)
          r.detailEl = undefined
        }
      }
    }

    function syncSiblings(changed: RowState): void {
      if (!changed.item_oid) return
      const on = changed.checkbox.checked
      for (const r of rows) {
        if (r !== changed && r.item_oid === changed.item_oid && r.supplier_oid === changed.supplier_oid) {
          r.checkbox.checked = on
          r.badge.hidden = !on
          updateRowChecked(r, actionType === 'shelf_schedule')
          updateDetail(r)
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
      for (const [v, label] of [['true', '上架'], ['false', '下架'], ['clear', '取消排程']]) {
        const opt = document.createElement('option'); opt.value = v; renderText(opt, label); status.appendChild(opt)
      }
      status.value = 'true'
      status.onchange = () => {
        const isClear = status.value === 'clear'
        date.disabled = isClear; hour.disabled = isClear; minute.disabled = isClear; tz.disabled = isClear;
      }
      const applyBtn = secondaryBtn('套用到所有已勾選', 'applyAllBtn', () => {
        clearFallback(fallbackEl)
        lastTz = tz.value
        const isClear = status.value === 'clear'
        
        let utc = ''
        if (!isClear) {
          const hh = Number(hour.value)
          const mm = Number(minute.value)
          if (!date.value || !Number.isInteger(hh) || hh < 0 || hh > 23 || !Number.isInteger(mm) || mm < 0 || mm > 59) {
            showFallback(fallbackEl, '請先選擇日期並確認時間（時 0–23、分 0–59）')
            return
          }
          try {
            utc = toReserveDateUtc(date.value, hh, mm, tz.value)
          } catch (e) {
            if (e instanceof Error && e.message === 'INVALID_DATE') {
              showFallback(fallbackEl, '請先選擇日期並確認時間（時 0–23、分 0–59）')
              return
            }
            throw e
          }
        }
        
        for (const r of rows) {
          if (r.checkbox.checked && !r.is_bundle) {
            if (isClear) {
              r.queue = []
              r.cleared = true
            } else {
              // 同一時間戳重複套用 = 取代，不累加（2026-08-18 demo 前實際咬到：「上架」套錯
              // 改「下架」再套，佇列殘留舊上架排序後仍是第一筆 → 131105 預檢反覆擋，使用者
              // 只能整頁重載）。不同時間戳維持累加——「今天下架、下週上架」是合法多筆排程。
              const existing = r.queue.find(q => q.reserve_date_utc === utc)
              if (existing) existing.reserve_status = status.value === 'true'
              else r.queue.push({ reserve_date_utc: utc, reserve_status: status.value === 'true' })
              r.cleared = false
            }
            renderQueueBadge(r)
          }
        }
      })
      row.appendChild(date); row.appendChild(hour); row.appendChild(minute); row.appendChild(tz); row.appendChild(status); row.appendChild(applyBtn)
      bar.appendChild(row)
      return bar
    }

    async function doNext(): Promise<void> {
      const target = radioButtons.find(r => r.checked)?.value
      const rowInputs: WizardRowInput[] = rows.map(r => ({
        checked: r.checkbox.checked, is_bundle: r.is_bundle ?? false,
        prod_oid: r.prod_oid, pkg_oid: r.pkg_oid, pkg_name: r.pkg_name,
        item_oid: r.item_oid, supplier_oid: r.supplier_oid,
        queue: r.queue, cleared: r.cleared ?? false
      }))
      const items = WIZARDS[actionType].buildItems(rowInputs, { target }) as Array<Record<string, unknown>>
      if (items.length === 0) {
        const checkedNonBundleCount = rows.filter(r => r.checkbox.checked && !r.is_bundle).length
        const totalCheckedCount = rows.filter(r => r.checkbox.checked).length
        if (actionType === 'shelf_schedule' && checkedNonBundleCount > 0) {
          showFallback(fallbackEl, `已勾選 ${checkedNonBundleCount} 筆但尚未套用——請先按『套用到所有已勾選』設定時間或取消排程`)
        } else if (totalCheckedCount === 0) {
          showFallback(fallbackEl, '請至少勾選一筆方案')
        } else {
          showFallback(fallbackEl, '請至少勾選一筆並填妥必要欄位')
        }
        return
      }
      clearFallback(fallbackEl)
      statusEl.textContent = '建立變更中…'
      try {
        const createR = await app.callServerTool({
          name: 'app_create_changeset',
          arguments: { action_type: actionType, items, ...(noteValue ? { note: noteValue } : {}) },
        })
        
        let parsedErrCode: string | undefined
        let parsedErrMessage: string | undefined
        try {
          const raw = createR.content?.[0]?.text
          if (raw) {
            const parsed = JSON.parse(raw)
            const errs = parsed.errors
            if (Array.isArray(errs) && errs.length > 0 && errs[0]?.code && errs[0]?.message) {
              parsedErrCode = errs[0].code
              parsedErrMessage = errs[0].message
            }
          }
        } catch (e) {}

        if (createR.isError) {
          if (parsedErrCode && parsedErrMessage) {
            showFallback(fallbackEl, `建立變更失敗：${parsedErrCode} — ${parsedErrMessage}`)
          } else {
            showFallback(fallbackEl, '建立變更失敗')
          }
          return
        }
        
        const created = createR.structuredContent?.items?.[0] as { changeset_id?: string } | undefined
        if (!created?.changeset_id) {
          if (parsedErrCode && parsedErrMessage) {
            showFallback(fallbackEl, `建立變更失敗：${parsedErrCode} — ${parsedErrMessage}`)
          } else {
            showFallback(fallbackEl, '建立變更失敗：未取得 changeset_id')
          }
          return
        }
        
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
  function renderQueueLines(el: HTMLElement, queue: ScheduleEntry[], emptyLabel = '(空，將清除排程)'): void {
    if (queue.length === 0) {
      const p = document.createElement('div')
      p.className = 'bw-queue-empty'
      renderText(p, emptyLabel)
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
    const domHelpers: DomHelpers = {
      el(tag: string, className?: string) {
        const e = document.createElement(tag)
        if (className) e.className = className
        return e
      },
      text: renderText,
      renderQueueLines: (el: HTMLElement, q: unknown[], emptyLabel?: string) => renderQueueLines(el, q as ScheduleEntry[], emptyLabel)
    }

    if (actionType === 'shelf_schedule' && Array.isArray(d.new_queue)) {
      return WIZARDS[actionType].renderDiffCard(d, domHelpers)
    }
    if (actionType === 'inventory_platform' && 'target' in d) {
      return WIZARDS[actionType].renderDiffCard(d, domHelpers)
    }
    // Fallback for any other/unknown diff shape — raw dump, same safety net the prior version had.
    const card = document.createElement('div')
    card.className = 'bw-diff-card'
    renderText(card, d)
    return card
  }

  // ---- Step 2: 檢視 ----
  function renderStep2(rec: Record<string, unknown>): void {
    setStep(2)
    lastViewRec = rec
    wizardEl.textContent = ''
    const warningText = WIZARDS[actionType].step2WarningText
    if (warningText) {
      const warn = document.createElement('div')
      warn.className = 'bw-banner bw-banner-danger'
      renderText(warn, warningText)
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
    footer.appendChild(secondaryBtn('← 返回選擇', 'backToStep1Btn', () => {
      if (changesetId && currentNonce && currentDiffVersion) {
        app.callServerTool({
          name: 'app_confirm_changeset',
          arguments: { changeset_id: changesetId, decision: 'reject', nonce: currentNonce, diff_version: currentDiffVersion, confirmed_keys: [] }
        }).catch(() => {})
      }
      setStep(1)
      wizardEl.textContent = ''
      step1Nodes.forEach(n => wizardEl.appendChild(n))
    }))
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
    footer.appendChild(secondaryBtn('← 回檢視', 'backToStep2Btn', () => {
      if (lastViewRec) renderStep2(lastViewRec)
    }))
    footer.appendChild(primaryBtn('確認執行', 'approveBtn', () => { void doApprove() }))
    card.appendChild(footer)
    wizardEl.appendChild(card)
  }

  async function doApprove(): Promise<void> {
    if (!changesetId || !currentNonce || !currentDiffVersion) { showFallback(fallbackEl, '缺少批准所需資訊，請回上一步重載'); return }
    statusEl.textContent = '執行中…'
    const confirmedKeys = currentDiffItems.map(WIZARDS[actionType].itemKey)
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
    const backBtn = wizardEl.querySelector('[data-role=backToStep2Btn]') as HTMLButtonElement
    if (backBtn) {
      backBtn.textContent = '回檢視重載'
      backBtn.dataset.role = 'reloadBtn'
      backBtn.onclick = () => { void doReload() }
    }
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

    const verifyNodes: Array<{ 
      res: Record<string, unknown>;
      matchedDiff: Record<string, unknown> | undefined;
      verifyDiv: HTMLElement;
    }> = []

    for (const res of results) {
      const row = document.createElement('div')
      row.dataset.itemKey = String(res.item_key)
      row.dataset.status = String(res.status)
      const status = res.status
      const kind = status === 'done' ? 'ok' : status === 'skipped_noop' ? 'skip' : 'error'
      row.className = 'bw-ledger-row'
      row.style.flexWrap = 'wrap'

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
      const statusLabel = kind === 'ok' ? '已完成' : kind === 'skip' ? '無變更，略過' : `失敗（${String(res.status)}）`
      statusSpan.className = `bw-ledger-status bw-ledger-status-${kind === 'ok' ? 'ok' : kind === 'skip' ? 'skip' : 'error'}`
      renderText(statusSpan, statusLabel)
      row.appendChild(statusSpan)

      if (kind === 'error') {
        const codeSpan = document.createElement('span')
        codeSpan.className = 'bw-ledger-code'
        renderText(codeSpan, String(res.error_code ?? ''))
        row.appendChild(codeSpan)
      }

      if (kind === 'ok') {
        const verifyDiv = document.createElement('div')
        verifyDiv.className = 'bw-noop-badge'
        verifyDiv.style.marginTop = '0.125rem'
        verifyDiv.style.flex = '0 0 100%'
        verifyDiv.style.marginLeft = '1.125rem'
        row.appendChild(verifyDiv)
        verifyNodes.push({ res, matchedDiff, verifyDiv })
      }

      card.appendChild(row)
    }
    wizardEl.appendChild(card)

    const btnRow = document.createElement('div')
    btnRow.className = 'bw-row-footer'
    const newBatchBtn = secondaryBtn('開始新批次', 'newBatchBtn', () => {
      changesetId = undefined
      currentNonce = undefined
      currentDiffVersion = undefined
      currentDiffItems = []
      lastViewRec = undefined
      clearFallback(fallbackEl)
      renderStep1(lastLoadedProdOids)
      const loadBtn = wizardEl.querySelector('[data-role=loadBtn]') as HTMLButtonElement
      if (loadBtn) loadBtn.click()
    })
    btnRow.appendChild(newBatchBtn)
    const reverifyBtn = secondaryBtn('重新驗證', 'reverifyBtn', () => { void doVerify() })
    btnRow.appendChild(reverifyBtn)
    wizardEl.appendChild(btnRow)

    void doVerify()

    async function doVerify(): Promise<void> {
      if (verifyNodes.length === 0) return
      reverifyBtn.disabled = true
      for (const v of verifyNodes) {
        v.verifyDiv.textContent = '驗證中…'
        v.verifyDiv.style.color = 'var(--bw-muted)'
      }

      const prodOids = new Set<string>()
      for (const d of currentDiffItems) {
        if ('affected_pkgs' in d && Array.isArray(d.affected_pkgs)) {
          for (const pkg of d.affected_pkgs as AffectedPkg[]) {
            if (pkg.prod_oid) prodOids.add(pkg.prod_oid)
          }
        } else if ('prod_oid' in d) {
          prodOids.add(String(d.prod_oid))
        }
      }

      try {
        const r = await app.callServerTool({
          name: 'app_get_batch_view',
          arguments: { action_type: actionType, prod_oids: Array.from(prodOids) }
        })
        if (r.isError) throw new Error('isError')
        
        const items = r.structuredContent?.items as Array<{ products?: Array<{ prod_oid: string; plans: Array<Record<string, unknown>> }> }> | undefined
        const products = items?.[0]?.products ?? []
        const livePlans = new Map<string, Record<string, unknown>>()
        for (const prod of products) {
          if (Array.isArray(prod.plans)) {
            for (const plan of prod.plans) {
              if (actionType === 'inventory_platform') {
                livePlans.set(`${plan.item_oid}:${plan.supplier_oid}`, plan)
              } else {
                livePlans.set(`${prod.prod_oid}:${plan.pkg_oid}`, plan)
              }
            }
          }
        }

        for (const v of verifyNodes) {
          let verified = false
          const diff = v.matchedDiff
          if (!diff) continue
          
          const plan = livePlans.get(String(v.res.item_key))
          if (actionType === 'inventory_platform') {
            if (plan && plan.current_platform != null && plan.current_platform === diff.target) {
              verified = true
            }
          } else {
            if (plan) {
              const liveQ = Array.isArray(plan.reserve_queue) ? plan.reserve_queue : []
              const sanitize = (q: any[]) => q.map((e: any) => ({
                reserve_date_utc: String(e.reserve_date_utc ?? e.reserve_date),
                reserve_status: Boolean(e.reserve_status)
              })).sort((a: any, b: any) => a.reserve_date_utc.localeCompare(b.reserve_date_utc))
              
              const diffQ = Array.isArray(diff.new_queue) ? diff.new_queue : []
              if (JSON.stringify(sanitize(liveQ)) === JSON.stringify(sanitize(diffQ))) {
                verified = true
              }
            }
          }

          if (verified) {
            v.verifyDiv.textContent = '✓ 已驗證：be2 現況與目標一致'
            v.verifyDiv.style.color = '#34c759'
          } else {
            v.verifyDiv.textContent = '⏳ 尚未觀察到落地（可能為讀取延遲）'
            v.verifyDiv.style.color = '#ff9500'
          }
        }
      } catch (e) {
        for (const v of verifyNodes) {
          v.verifyDiv.textContent = '（無法自動驗證：讀取失敗，可稍後按重新驗證）'
          v.verifyDiv.style.color = 'var(--bw-muted)'
        }
      } finally {
        reverifyBtn.disabled = false
      }
    }
  }

  app.ontoolresult = params => {
    try {
      const env = params.structuredContent
      const rec = (env?.items?.[0] as { action_type?: ActionType; prod_oids?: string[] } | undefined) ?? {}
      actionType = rec.action_type ?? 'inventory_platform'
      headerEl.className = 'bw-title'
      renderText(headerEl, WIZARDS[actionType].label)
      renderStep1(rec.prod_oids ?? [])
    } catch (e) { showFallback(fallbackEl, '渲染失敗：' + String(e)) }
  }
}

// Test seam (see this file's WizardApp doc comment and tests/ui/batchWizard.test.ts's header):
// only wire up the real connectApp()/MCP-transport path when a real `window` exists. Importing
// this module under a document-only stub (no `window`) must not throw at import time — it must
// stay import-safe so tests can call initWizard() directly with an injected stub app.
if (typeof window !== 'undefined') {
  connectApp('be2-batch-wizard').then(a => initWizard(a as unknown as WizardApp)).catch(e => {
    const fallback = document.getElementById('fallback') as HTMLPreElement
    showFallback(fallback, '無法連上 host：' + String(e))
  })
}
