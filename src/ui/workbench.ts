// src/ui/workbench.ts — 統一工作台面板（版型 B）。左功能列（上下架/庫存/公告）→ 次模式 →
// 商品載入 → 多商品 tab → 步驟條（選擇→檢視→批准→結果）→ 拆批 → 批准。
// 結構移植自 batch-wizard.ts（host bridge、STYLE 常數、step bar、多商品 tab、callServerTool
// 序列、DIFF_STALE 重載），行為對齊 prototype workbench-prototype.html 版型 B。
//
// 各次模式組合對應 WizardDescriptor 的 buildItems / renderDiffCard；公告走 announcement 專屬
// item 形狀（欄位名對齊 announcement-wizard.ts + announcement/create/module.ts itemSchema）。

import { connectApp, renderText } from './panelShared.js'
import { parseOidInput, ingestAnnouncement } from './workbenchLogic.js'
import { inventoryPlatformWizard } from '../modules/product/inventoryPlatform/ui.js'
import { inventorySettingWizard } from '../modules/product/inventorySetting/ui.js'
import { shelfScheduleWizard } from '../modules/product/shelfSchedule/ui.js'
import { shelfToggleProductWizard, shelfTogglePlanWizard } from '../modules/product/shelfToggle/ui.js'
import { shelfToggleBundleWizard } from '../modules/product/shelfToggleBundle/ui.js'
import { itemKey as announcementItemKey } from '../modules/announcement/create/keys.js'
import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../core/changeset/module.js'
import type { AnnouncementCreateItem } from '../core/changeset/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FuncKey = 'shelf' | 'inventory' | 'announce'
type SubMode =
  | 'shelf_toggle_product' | 'shelf_toggle_bundle' | 'shelf_schedule'
  | 'shelf_toggle_plan'
  | 'inventory_setting' | 'inventory_platform'
  | 'announcement'

interface FuncDesc {
  key: FuncKey
  label: string
  subLabel: string
  subModes: Array<{ key: SubMode; label: string }>
  risk?: string
}

const FUNCS: FuncDesc[] = [
  {
    key: 'shelf', label: '商品上下架', subLabel: '商品 / 方案 / 套裝',
    risk: '方案或商品上下架會即時改變前台可售並清快取。',
    subModes: [
      { key: 'shelf_toggle_product', label: '立即上 / 下架' },
      { key: 'shelf_toggle_bundle', label: '套裝上下架' },
      { key: 'shelf_schedule', label: '排程上下架' },
      { key: 'shelf_toggle_plan', label: '方案上下架' },
    ],
  },
  {
    key: 'inventory', label: '商品庫存', subLabel: '逐日數量 / 平台切換',
    risk: '庫存寫入會即時反映前台可售並清 cache。',
    subModes: [
      { key: 'inventory_setting', label: '逐日數量' },
      { key: 'inventory_platform', label: '平台切換' },
    ],
  },
  {
    key: 'announce', label: '商品公告', subLabel: '公告內容',
    subModes: [
      { key: 'announcement', label: '公告' },
    ],
  },
]

// action_type sent to server tools — for announcement we use 'announcement'
function serverActionType(sm: SubMode): string {
  if (sm === 'announcement') return 'announcement'
  return sm
}

// Map sub-modes to WizardDescriptors (announcement has none — it builds items directly)
const WIZARDS: Partial<Record<SubMode, WizardDescriptor>> = {
  shelf_toggle_product: shelfToggleProductWizard,
  shelf_toggle_plan: shelfTogglePlanWizard,
  shelf_toggle_bundle: shelfToggleBundleWizard,
  shelf_schedule: shelfScheduleWizard,
  inventory_setting: inventorySettingWizard,
  inventory_platform: inventoryPlatformWizard,
}

interface ScheduleEntry { reserve_date_utc: string; reserve_status: boolean }

const TZ_OFFSET_HOURS: Record<string, number> = { 'Asia/Taipei': 8, 'Asia/Tokyo': 9, UTC: 0 }
function pad2(n: number): string { return String(n).padStart(2, '0') }

function toUtcDateTime(dateStr: string, timeStr: string, tz: string): string {
  const offset = TZ_OFFSET_HOURS[tz] ?? 0
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d, hh - offset, mm, 0))
  const res = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())} ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:00`
  if (res.includes('NaN')) throw new Error('INVALID_DATE')
  return res
}

function formatDualDisplay(reserveDateUtc: string, tz: string): string {
  const offset = TZ_OFFSET_HOURS[tz] ?? 0
  const ms = Date.parse(reserveDateUtc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return reserveDateUtc
  const local = new Date(ms + offset * 3600_000)
  const localStr = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`
  const sign = offset >= 0 ? '+' : '-'
  return `${localStr} (GMT${sign}${Math.abs(offset)}) / ${reserveDateUtc} UTC`
}

const PLATFORM_LABELS: Record<string, string> = {
  BE2: 'BE2 管理',
  BE2_SCM: 'BE2 / SCM 管理',
  EXTERNAL: '串接外部庫存（包含 rezio）',
}
const platformLabel = (v: string | null | undefined): string => (v == null ? '無法讀取' : (PLATFORM_LABELS[v] ?? v))

// 公告 15 語系（對齊 prototype ANN_LOCALES 與 kkday-announcement-translate skill 契約）
const ANN_LOCALES: Array<{ code: string; name: string }> = [
  { code: 'zh-tw', name: '繁體中文（台灣）' }, { code: 'zh-hk', name: '繁體中文（香港）' },
  { code: 'zh-cn', name: '简体中文' }, { code: 'zh-my', name: '简体中文（马来西亚）' },
  { code: 'en-default', name: 'English（all en markets）' }, { code: 'ja-jp', name: '日本語' }, { code: 'ko-kr', name: '한국어' },
  { code: 'th-th', name: 'ภาษาไทย' }, { code: 'vi-vn', name: 'Tiếng Việt' }, { code: 'id-id', name: 'Bahasa Indonesia' },
  { code: 'ms-my', name: 'Bahasa Melayu' }, { code: 'tl-ph', name: 'Filipino' }, { code: 'fr-fr', name: 'Français' },
  { code: 'es-es', name: 'Español' }, { code: 'hi-in', name: 'हिन्दी' },
]

// ---------------------------------------------------------------------------
// Style — injected once, same pattern as batch-wizard.ts
// ---------------------------------------------------------------------------

const STYLE = `
:root{--bw-tint:#0A84FF;--bw-danger:#FF3B30;--bw-text:#1d1d1f;--bw-muted:#6e6e73;--bw-border:rgba(0,0,0,.08);--bw-bg-page:#f5f5f7}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{background:var(--bw-bg-page)}
body{font:100%/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--bw-text);max-width:760px;margin:0 auto;padding:1.5rem 1.25rem 3rem}
#status{font-size:.8125rem;color:var(--bw-muted);margin-bottom:.5rem}

/* ---- nav: function list ---- */
.wb-nav{display:flex;gap:.5rem;margin-bottom:1rem;flex-wrap:wrap}
.wb-nav-btn{display:flex;flex-direction:column;gap:2px;padding:.625rem 1rem;border-radius:10px;border:1px solid var(--bw-border);background:#fff;cursor:pointer;text-align:left;font-family:inherit;transition:background-color 120ms}
.wb-nav-btn:hover{background:var(--bw-bg-page)}
.wb-nav-btn[aria-pressed=true]{background:var(--bw-tint);color:#fff;border-color:var(--bw-tint)}
.wb-nav-btn[aria-pressed=true]:hover{background:#0974e0}
.wb-nav-title{font-weight:600;font-size:.875rem}
.wb-nav-sub{font-size:.75rem;opacity:.72}
.wb-nav-btn:disabled{opacity:.4;cursor:not-allowed}

/* ---- sub-mode pills ---- */
.wb-submodes{display:flex;gap:4px;margin-bottom:1rem;flex-wrap:wrap}
.wb-submode{padding:.375rem .875rem;border-radius:999px;border:1px solid var(--bw-border);background:#fff;cursor:pointer;font:inherit;font-size:.8125rem;font-weight:600;color:var(--bw-muted);transition:120ms}
.wb-submode:hover{background:var(--bw-bg-page)}
.wb-submode[aria-pressed=true]{background:var(--bw-tint);color:#fff;border-color:var(--bw-tint)}

/* ---- step progress ---- */
.bw-progress{display:flex;align-items:center;margin:0 0 1.5rem}
.bw-step{display:flex;flex-direction:column;align-items:center;gap:.25rem;flex:0 0 auto}
.bw-step-circle{width:1.75rem;height:1.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.8125rem;font-weight:600;border:1.5px solid #d2d2d7;color:var(--bw-muted);background:#fff;transition:150ms}
.bw-step-current .bw-step-circle{border-color:var(--bw-tint);color:var(--bw-tint)}
.bw-step-done .bw-step-circle{background:var(--bw-tint);border-color:var(--bw-tint);color:#fff}
.bw-step-label{font-size:.75rem;color:var(--bw-muted);white-space:nowrap}
.bw-step-current .bw-step-label{color:var(--bw-text);font-weight:600}
.bw-connector{flex:1 1 auto;height:1.5px;background:#d2d2d7;margin:0 .25rem 1.1rem;transition:150ms}
.bw-connector-done{background:var(--bw-tint)}

/* ---- cards ---- */
.bw-card{background:#fff;border:1px solid var(--bw-border);border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 12px rgba(0,0,0,.04);padding:1rem 1.125rem;margin-bottom:1rem}
.bw-card-title{font-size:.8125rem;font-weight:600;color:var(--bw-muted);margin:0 0 .625rem;text-transform:uppercase;letter-spacing:.02em}
.bw-row-inline{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.bw-row-footer{display:flex;justify-content:flex-end;align-items:center;gap:.75rem}

/* ---- tabs ---- */
.bw-tabbar{display:inline-flex;gap:2px;margin-bottom:1rem;padding:3px;background:#e5e5ea;border-radius:10px;overflow-x:auto;max-width:100%}
.bw-tab{display:flex;flex-direction:column;gap:.125rem;padding:.375rem 1rem;border-radius:7px;cursor:pointer;border:none;background:transparent;text-align:center;font-family:inherit;color:var(--bw-muted);transition:150ms}
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
textarea.bw-input{height:auto;padding:.375rem .625rem}
.bw-input:focus-visible,.bw-select:focus-visible{outline:2px solid var(--bw-tint);outline-offset:1px;border-color:var(--bw-tint)}
.bw-input:disabled,.bw-select:disabled{opacity:.5;cursor:not-allowed;background:#f5f5f7}
input.bw-input[type=text]{flex:1 1 auto;min-width:8rem}
input.bw-input[type=number]{width:4.5rem}

/* ---- buttons ---- */
.bw-btn{height:2rem;padding:0 1.1rem;border-radius:8px;border:1px solid transparent;font:inherit;font-size:.875rem;font-weight:500;cursor:pointer;transition:120ms}
.bw-btn:active{transform:scale(0.97)}
.bw-btn-primary{background:var(--bw-tint);color:#fff}
.bw-btn-primary:hover{background:#0974e0}
.bw-btn-secondary{background:#f0f0f2;color:var(--bw-text)}
.bw-btn-secondary:hover{background:#e5e5ea}

/* ---- plan table ---- */
.bw-table-toolbar{display:flex;gap:.5rem;margin-bottom:.75rem}
.bw-radio-bar{display:flex;gap:1rem;margin-bottom:.75rem;font-size:.875rem}
.bw-radio-bar label{display:flex;align-items:center;gap:.35rem}
.bw-plan-row,.bw-plan-head{display:grid;grid-template-columns:1.5rem 1fr 6.5rem 8.5rem 6rem;align-items:center;gap:.75rem;padding:.5rem .25rem;border-radius:8px;transition:120ms}
.bw-plan-head{font-size:.75rem;color:var(--bw-muted);font-weight:600;padding-bottom:.5rem;border-bottom:1px solid var(--bw-border);margin-bottom:.25rem}
.bw-plan-row:hover{background:#f5f5f7}
.bw-plan-row-checked{background:rgba(10,132,255,.08)}
.bw-plan-row-bundle{opacity:.55}
.bw-plan-name{display:flex;flex-direction:column;gap:.125rem;min-width:0}
.bw-plan-name-top{display:flex;align-items:center;gap:.375rem}
.bw-plan-name-oid{font-size:.75rem;color:var(--bw-muted)}
.bw-bundle-tag{font-size:.6875rem;color:var(--bw-muted);background:#f0f0f2;padding:.05rem .4rem;border-radius:6px}
.bw-co-badge{font-size:.6875rem;background:rgba(10,132,255,.12);color:var(--bw-tint);padding:.1rem .5rem;border-radius:999px;justify-self:start}
.bw-status-badge{display:flex;align-items:center;gap:.375rem;font-size:.8125rem}
.bw-dot{width:.5rem;height:.5rem;border-radius:50%;flex:0 0 auto}
.bw-dot-green{background:#34c759}
.bw-dot-red{background:var(--bw-danger)}
.bw-dot-gray{background:#c7c7cc}
.bw-plan-row-wrapper{display:flex;flex-direction:column;margin-bottom:.25rem}
.bw-detail-row{padding:.5rem 1rem .5rem 2.5rem;font-size:.8125rem;color:var(--bw-muted);background:rgba(10,132,255,.04);border-radius:0 0 8px 8px;margin-top:-4px}
.bw-target-preview{color:var(--bw-tint);font-weight:500}
.bw-preview-noop{color:var(--bw-muted);font-weight:400}
.bw-detail-muted{color:#a1a1a6}
.bw-ext-warning{margin-top:.5rem;font-size:.8125rem;color:#b8281f;background:rgba(255,59,48,.1);padding:.375rem .75rem;border-radius:6px}

/* ---- direction bar (shelf toggle forced single direction) ---- */
.wb-dirbar{display:flex;gap:.75rem;align-items:center;margin-bottom:.75rem;flex-wrap:wrap}
.wb-seg{display:inline-flex;background:#e5e5ea;border-radius:999px;padding:3px}
.wb-seg button{border:0;background:transparent;padding:.375rem 1rem;border-radius:999px;font-weight:600;font-size:.8125rem;color:var(--bw-muted);cursor:pointer}
.wb-seg button[aria-pressed=true]{background:#fff;color:var(--bw-text);box-shadow:0 1px 2px rgba(0,0,0,.12)}

/* ---- banners ---- */
.bw-banner{border-radius:10px;padding:.625rem .875rem;font-size:.875rem;margin-bottom:1rem}
.bw-banner-danger{background:rgba(255,59,48,.1);color:#b8281f}
.bw-banner-warn{background:rgba(255,159,10,.12);color:#b35900}

/* ---- diff cards ---- */
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

/* ---- ledger (step 4) ---- */
.bw-ledger-row{display:flex;align-items:center;gap:.625rem;padding:.5rem .25rem;border-bottom:1px solid var(--bw-border)}
.bw-ledger-row:last-child{border-bottom:none}
.bw-ledger-key{font-size:.875rem}
.bw-ledger-row .bw-plan-name{flex:1 1 auto;min-width:0}
.bw-ledger-status{flex:0 0 auto;margin-left:auto;font-size:.75rem;font-weight:600;padding:.2rem .625rem;border-radius:999px;white-space:nowrap}
.bw-ledger-status-ok{background:rgba(48,209,88,.15);color:#1d8a3c}
.bw-ledger-status-skip{background:#f0f0f2;color:var(--bw-muted)}
.bw-ledger-status-error{background:rgba(255,59,48,.12);color:var(--bw-danger)}
.bw-ledger-code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.75rem;color:var(--bw-danger)}

/* announcement form specifics */
.wb-lang-row{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.5rem}
.wb-field{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.75rem}
.wb-field label{font-size:.8125rem;color:var(--bw-muted)}

/* transitions */
#workspace>*{animation:bwFadeIn 180ms ease-out}
@keyframes bwFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){
  #workspace>*{animation:none}
  .bw-btn:active{transform:none}
}
`

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)
}

// ---------------------------------------------------------------------------
// WizardApp — duck-typed subset of ext-apps App (same as batch-wizard.ts)
// ---------------------------------------------------------------------------

export interface WizardApp {
  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    isError?: boolean
    content?: Array<{ type: string; text: string }>
    structuredContent?: { items?: unknown[]; errors?: Array<{ code?: string; message?: string }> }
  }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showFallback(el: HTMLElement, m: string): void { el.hidden = false; el.textContent = m }
function clearFallback(el: HTMLElement): void { el.hidden = true; el.textContent = '' }

function primaryBtn(text: string, role: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = text; b.className = 'bw-btn bw-btn-primary'; b.dataset.role = role; b.onclick = onclick
  return b
}
function secondaryBtn(text: string, role: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = text; b.className = 'bw-btn bw-btn-secondary'; b.dataset.role = role; b.onclick = onclick
  return b
}

// ---------------------------------------------------------------------------
// RowState — per-plan row state (reused from batch-wizard pattern)
// ---------------------------------------------------------------------------
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
  quantityInput?: HTMLInputElement
}

function updateRowChecked(r: RowState, dimBundle: boolean): void {
  const cls = ['bw-plan-row']
  if (r.checkbox.checked) cls.push('bw-plan-row-checked')
  if (r.is_bundle && dimBundle) cls.push('bw-plan-row-bundle')
  r.rowEl.className = cls.join(' ')
}

function renderQueueBadge(r: RowState): void {
  if (r.cleared) { renderText(r.badge, '將清除排程'); r.badge.hidden = false; return }
  if (r.queue.length === 0) { r.badge.hidden = true; return }
  const parts = [...r.queue]
    .sort((a, b) => (a.reserve_date_utc < b.reserve_date_utc ? -1 : 1))
    .map(q => `${q.reserve_date_utc.slice(5, 16)} ${q.reserve_status ? '上架' : '下架'}`)
  renderText(r.badge, `待送(UTC)：${parts.join('、')}`)
  r.badge.hidden = false
}

// ---------------------------------------------------------------------------
// Main: initWorkbench
// ---------------------------------------------------------------------------
export function initWorkbench(app: WizardApp): void {
  injectStyles()

  const navEl = document.getElementById('nav')!
  const statusEl = document.getElementById('status')!
  const workspaceEl = document.getElementById('workspace')!
  const fallbackEl = document.getElementById('fallback') as HTMLPreElement

  // ---- State ----
  let currentFunc: FuncKey = 'shelf'
  let currentSubMode: SubMode = 'shelf_toggle_product'
  let step = 1
  let shelfDir: 'on' | 'off' = 'on'
  let lastTz = 'Asia/Taipei'

  // batch-wizard style changeset state
  let changesetId: string | undefined
  let currentNonce: string | undefined
  let currentDiffVersion: string | undefined
  let currentDiffItems: Array<Record<string, unknown>> = []
  let lastViewRec: Record<string, unknown> | undefined

  // product data rows
  let rows: RowState[] = []
  let radioButtons: HTMLInputElement[] = []
  let loadedProdOids: string[] = []

  // announcement state
  let annState = resetAnnState()
  function resetAnnState() {
    return {
      name: '', isEnabled: true,
      startDate: '', startTime: '00:00', startTz: 'Asia/Taipei',
      endDate: '', endTime: '00:00', endTz: 'Asia/Taipei',
      langContents: new Map<string, string>(),
      selectedLangs: new Set<string>(),
    }
  }

  // ---- Step bar (選擇→檢視→批准→結果) ----
  const progressEl = document.createElement('div')
  progressEl.className = 'bw-progress'
  const STEP_LABELS = ['選擇', '檢視', '批准', '結果']
  function renderProgress(): void {
    progressEl.textContent = ''
    STEP_LABELS.forEach((label, i) => {
      const n = i + 1
      if (i > 0) {
        const c = document.createElement('span')
        c.className = `bw-connector${n - 1 < step ? ' bw-connector-done' : ''}`
        progressEl.appendChild(c)
      }
      const s = document.createElement('span')
      s.className = `bw-step ${n < step ? 'bw-step-done' : n === step ? 'bw-step-current' : 'bw-step-pending'}`
      const circle = document.createElement('span'); circle.className = 'bw-step-circle'
      renderText(circle, n < step ? '✓' : String(n)); s.appendChild(circle)
      const lab = document.createElement('span'); lab.className = 'bw-step-label'
      renderText(lab, label); s.appendChild(lab)
      progressEl.appendChild(s)
    })
  }
  function setStep(n: number): void { step = n; renderProgress() }

  // ---- Nav rendering ----
  function renderNav(): void {
    navEl.textContent = ''
    navEl.className = 'wb-nav'
    for (const f of FUNCS) {
      const btn = document.createElement('button')
      btn.className = 'wb-nav-btn'
      btn.setAttribute('aria-pressed', String(currentFunc === f.key))
      if (step > 1) btn.disabled = true
      const t = document.createElement('span'); t.className = 'wb-nav-title'; renderText(t, f.label)
      const s = document.createElement('span'); s.className = 'wb-nav-sub'; renderText(s, f.subLabel)
      btn.appendChild(t); btn.appendChild(s)
      btn.onclick = () => {
        if (step > 1) return
        currentFunc = f.key
        currentSubMode = f.subModes[0].key
        shelfDir = 'on'
        rows = []; radioButtons = []; loadedProdOids = []
        annState = resetAnnState()
        clearFallback(fallbackEl)
        renderNav()
        renderWorkspace()
      }
      navEl.appendChild(btn)
    }
  }

  // ---- Sub-mode pills ----
  function renderSubModes(container: HTMLElement): void {
    const func = FUNCS.find(f => f.key === currentFunc)!
    if (func.subModes.length <= 1) return // no sub-mode bar for single-mode functions (公告)
    const bar = document.createElement('div')
    bar.className = 'wb-submodes'
    for (const sm of func.subModes) {
      const btn = document.createElement('button')
      btn.className = 'wb-submode'
      btn.setAttribute('aria-pressed', String(currentSubMode === sm.key))
      renderText(btn, sm.label)
      btn.onclick = () => {
        currentSubMode = sm.key
        rows = []; radioButtons = []; loadedProdOids = []
        clearFallback(fallbackEl)
        renderWorkspace()
      }
      bar.appendChild(btn)
    }
    container.appendChild(bar)
  }

  // ---- Main workspace rendering (step 1) ----
  function renderWorkspace(): void {
    setStep(1)
    workspaceEl.textContent = ''
    renderNav()

    workspaceEl.appendChild(progressEl)

    // Sub-mode pills
    renderSubModes(workspaceEl)

    if (currentSubMode === 'announcement') {
      renderAnnouncementStep1()
    } else {
      renderBatchStep1()
    }
  }

  // =====================================================================
  // BATCH FLOW (all non-announcement sub-modes)
  // =====================================================================

  function renderBatchStep1(): void {
    const wizard = WIZARDS[currentSubMode]!

    // Direction bar for shelf toggle modes
    const isShelfToggle = currentSubMode === 'shelf_toggle_product' || currentSubMode === 'shelf_toggle_plan' || currentSubMode === 'shelf_toggle_bundle'
    if (isShelfToggle) {
      const dirBar = document.createElement('div')
      dirBar.className = 'wb-dirbar'
      const lbl = document.createElement('span'); lbl.style.fontSize = '.8125rem'; lbl.style.color = 'var(--bw-muted)'
      renderText(lbl, '這批動作（強制單一方向）')
      dirBar.appendChild(lbl)
      const seg = document.createElement('div'); seg.className = 'wb-seg'
      const upBtn = document.createElement('button'); renderText(upBtn, '全部上架'); upBtn.setAttribute('aria-pressed', String(shelfDir === 'on'))
      const downBtn = document.createElement('button'); renderText(downBtn, '全部下架'); downBtn.setAttribute('aria-pressed', String(shelfDir === 'off'))
      upBtn.onclick = () => { shelfDir = 'on'; upBtn.setAttribute('aria-pressed', 'true'); downBtn.setAttribute('aria-pressed', 'false') }
      downBtn.onclick = () => { shelfDir = 'off'; upBtn.setAttribute('aria-pressed', 'true'); downBtn.setAttribute('aria-pressed', 'false'); /* fix: swap */ upBtn.setAttribute('aria-pressed', 'false'); downBtn.setAttribute('aria-pressed', 'true') }
      seg.appendChild(upBtn); seg.appendChild(downBtn)
      dirBar.appendChild(seg)
      const note = document.createElement('span'); note.style.cssText = 'font-size:.75rem;color:var(--bw-muted)'
      renderText(note, '一次操作不得同時含上架與下架；另一方向請另開一批。')
      dirBar.appendChild(note)
      workspaceEl.appendChild(dirBar)
    }

    // OID input card
    const inputCard = document.createElement('div'); inputCard.className = 'bw-card'
    const inputCardTitle = document.createElement('div'); inputCardTitle.className = 'bw-card-title'
    renderText(inputCardTitle, '商品')
    inputCard.appendChild(inputCardTitle)
    const inputRow = document.createElement('div'); inputRow.className = 'bw-row-inline'
    const prodInput = document.createElement('input') as HTMLInputElement
    prodInput.type = 'text'; prodInput.className = 'bw-input'; prodInput.placeholder = '商品 oid，逗號或空白分隔'
    prodInput.value = loadedProdOids.join(', '); prodInput.dataset.role = 'prodOidsInput'
    inputRow.appendChild(prodInput)
    inputRow.appendChild(primaryBtn('載入', 'loadBtn', () => { void doLoadBatch(prodInput.value) }))
    inputCard.appendChild(inputRow)
    workspaceEl.appendChild(inputCard)

    // Plan table placeholder
    const planTableEl = document.createElement('div'); planTableEl.className = 'bw-card'; planTableEl.dataset.role = 'planTable'
    workspaceEl.appendChild(planTableEl)

    // Schedule bar (shelf_schedule only, reuses batch-wizard pattern)
    if (currentSubMode === 'shelf_schedule') {
      workspaceEl.appendChild(renderDefaultTimeBar())
    }

    // Footer with next button
    const footerCard = document.createElement('div'); footerCard.className = 'bw-card bw-row-footer'
    footerCard.appendChild(primaryBtn('下一步：檢視', 'nextBtn', () => { void doNextBatch() }))
    workspaceEl.appendChild(footerCard)

    // ---- doLoad ----
    async function doLoadBatch(raw: string): Promise<void> {
      const prodOids = parseOidInput(raw)
      if (prodOids.length === 0) { showFallback(fallbackEl, '請輸入至少一個商品 oid'); return }
      loadedProdOids = prodOids
      statusEl.textContent = '載入中…'
      clearFallback(fallbackEl)
      try {
        const r = await app.callServerTool({
          name: 'app_get_batch_view',
          arguments: { action_type: serverActionType(currentSubMode), prod_oids: prodOids },
        })
        if (r.isError) { showFallback(fallbackEl, '載入失敗'); return }
        const sc = r.structuredContent as { items?: unknown[]; errors?: Array<{ code?: string; message?: string }> } | undefined
        const item0 = sc?.items?.[0] as { products?: unknown[] } | undefined
        const products = (item0?.products ?? []) as Array<{ prod_oid: string; name?: string; not_found?: boolean; is_active?: boolean; plans: Array<Record<string, unknown>> }>
        const nfErrors = (sc?.errors ?? []).filter(e => e.code === 'PRODUCT_NOT_FOUND')
        if (nfErrors.length > 0) showFallback(fallbackEl, nfErrors.map(e => e.message).join('\n'))
        else clearFallback(fallbackEl)
        renderPlanTable(planTableEl, products)
        statusEl.textContent = `已載入 ${products.length} 個商品`
      } catch (e) { showFallback(fallbackEl, '載入失敗：' + String(e)) }
    }

    // ---- Plan table rendering ----
    let activeProdOid: string | undefined
    let notFoundDivs: Array<{ prod_oid: string; el: HTMLElement }> = []

    function applyVisibility(): void {
      for (const r of rows) {
        const inActiveTab = !activeProdOid || r.prod_oid === activeProdOid
        r.wrapperEl.hidden = !inActiveTab
      }
      for (const nf of notFoundDivs) nf.el.hidden = !activeProdOid || nf.prod_oid !== activeProdOid
    }

    function renderPlanTable(container: HTMLElement, products: Array<{ prod_oid: string; name?: string; not_found?: boolean; is_active?: boolean; plans: Array<Record<string, unknown>> }>): void {
      container.textContent = ''
      rows = []; radioButtons = []; notFoundDivs = []
      activeProdOid = products.length > 1 ? products[0]?.prod_oid : undefined

      const cardTitle = document.createElement('div'); cardTitle.className = 'bw-card-title'
      renderText(cardTitle, '方案清單'); container.appendChild(cardTitle)

      // Multi-product tabs
      if (products.length > 1) {
        const tabbar = document.createElement('div'); tabbar.className = 'bw-tabbar'
        for (const prod of products) {
          const isNF = prod.not_found === true
          const tab = document.createElement('button')
          tab.className = `bw-tab ${prod.prod_oid === activeProdOid ? 'bw-tab-active' : ''}${isNF ? ' bw-tab-danger' : ''}`
          const nameSpan = document.createElement('span'); nameSpan.className = 'bw-tab-name'
          renderText(nameSpan, isNF ? '找不到商品' : (prod.name ?? prod.prod_oid))
          const oidSpan = document.createElement('span'); oidSpan.className = 'bw-tab-oid'
          renderText(oidSpan, isNF ? prod.prod_oid : `${prod.prod_oid} · ${prod.plans.length} 方案`)
          tab.appendChild(nameSpan); tab.appendChild(oidSpan)
          tab.onclick = () => {
            activeProdOid = prod.prod_oid
            for (const t of tabbar.querySelectorAll('.bw-tab')) t.className = t.className.replace(' bw-tab-active', '')
            tab.className += ' bw-tab-active'
            applyVisibility()
          }
          tabbar.appendChild(tab)
        }
        container.appendChild(tabbar)
      }

      // Shelf_toggle_product: product-level checkbox (using is_active from batch_view)
      if (currentSubMode === 'shelf_toggle_product') {
        // For product-level toggling, we add a product-level checkbox row
        // Product rows have no pkg_oid — buildItems filters them
        for (const prod of products) {
          if (prod.not_found) {
            const msgDiv = document.createElement('div'); msgDiv.className = 'bw-not-found-msg'
            renderText(msgDiv, '查無此商品'); container.appendChild(msgDiv)
            notFoundDivs.push({ prod_oid: prod.prod_oid, el: msgDiv })
            continue
          }
          const wrapper = document.createElement('div'); wrapper.className = 'bw-plan-row-wrapper'
          const row = document.createElement('div'); row.className = 'bw-plan-row'
          const cb = document.createElement('input'); cb.type = 'checkbox'
          // Determine if eligible: product's current state differs from target direction
          const targetActive = shelfDir === 'on'
          const eligible = prod.is_active !== targetActive
          if (!eligible) cb.disabled = true
          const badge = document.createElement('span'); badge.className = 'bw-co-badge'; badge.hidden = true
          const rs: RowState = {
            checkbox: cb, badge, rowEl: row, wrapperEl: wrapper,
            prod_oid: prod.prod_oid, pkg_oid: '', pkg_name: prod.name ?? prod.prod_oid,
            is_bundle: false, is_active: prod.is_active, queue: [],
          }
          rows.push(rs)
          cb.onclick = () => { updateRowChecked(rs, false) }
          row.appendChild(cb)
          const nameCell = document.createElement('div'); nameCell.className = 'bw-plan-name'
          const nameSpan = document.createElement('span'); renderText(nameSpan, `整個商品 — ${rs.pkg_name}`)
          nameCell.appendChild(nameSpan)
          const oidSpan = document.createElement('span'); oidSpan.className = 'bw-plan-name-oid'; renderText(oidSpan, prod.prod_oid)
          nameCell.appendChild(oidSpan)
          row.appendChild(nameCell)
          // status
          const statusWrap = document.createElement('span'); statusWrap.className = 'bw-status-badge'
          if (!eligible) {
            renderText(statusWrap, `已是${prod.is_active ? '上架' : '下架'}`)
          } else {
            renderText(statusWrap, `→ 切為${targetActive ? '上架' : '下架'}`)
          }
          row.appendChild(statusWrap)
          row.appendChild(badge)
          wrapper.appendChild(row)
          container.appendChild(wrapper)
        }
      } else {
        // All other modes: plan-level rows (same pattern as batch-wizard.ts)

        // Radio bar for inventory_platform target
        if (currentSubMode === 'inventory_platform') {
          const radioBar = document.createElement('div'); radioBar.className = 'bw-radio-bar'
          const extWarning = document.createElement('div'); extWarning.className = 'bw-ext-warning'; extWarning.hidden = true
          renderText(extWarning, '串接外部庫存（B2D/B2S/rezio 等）開啟前請先與 IT 確認')
          for (const target of ['BE2', 'BE2_SCM', 'EXTERNAL']) {
            const label = document.createElement('label')
            const r = document.createElement('input'); r.type = 'radio'; r.name = 'target'; r.value = target
            r.onchange = () => { extWarning.hidden = r.value !== 'EXTERNAL' }
            radioButtons.push(r)
            label.appendChild(r)
            const span = document.createElement('span'); renderText(span, platformLabel(target))
            label.appendChild(span)
            radioBar.appendChild(label)
          }
          container.appendChild(radioBar)
          container.appendChild(extWarning)
        }

        const headRow = document.createElement('div'); headRow.className = 'bw-plan-head'
        for (const label of ['', '方案', '供應商', '現況', '']) {
          const cell = document.createElement('span'); renderText(cell, label); headRow.appendChild(cell)
        }
        container.appendChild(headRow)

        for (const prod of products) {
          if (prod.not_found) {
            const msgDiv = document.createElement('div'); msgDiv.className = 'bw-not-found-msg'
            renderText(msgDiv, '查無此商品，請確認 prod_oid'); container.appendChild(msgDiv)
            notFoundDivs.push({ prod_oid: prod.prod_oid, el: msgDiv })
          }
          for (const plan of prod.plans) {
            const wrapper = document.createElement('div'); wrapper.className = 'bw-plan-row-wrapper'
            const row = document.createElement('div')
            const cb = document.createElement('input'); cb.type = 'checkbox'
            cb.dataset.pkgOid = String(plan.pkg_oid)
            const itemOid = plan.item_oid as string | undefined
            const supplierOid = plan.supplier_oid as string | undefined
            const isBundle = plan.is_bundle === true
            if (currentSubMode === 'shelf_schedule' && isBundle) cb.disabled = true
            // shelf_toggle_plan: exclude bundles (plan only = non-bundle with pkg_oid)
            if (currentSubMode === 'shelf_toggle_plan' && isBundle) cb.disabled = true
            // shelf_toggle_bundle: only bundles
            if (currentSubMode === 'shelf_toggle_bundle' && !isBundle) cb.disabled = true
            const badge = document.createElement('span'); badge.className = 'bw-co-badge'; badge.hidden = true
            renderText(badge, '將一併變更')
            const rs: RowState = {
              checkbox: cb, badge, rowEl: row, wrapperEl: wrapper,
              prod_oid: prod.prod_oid, pkg_oid: String(plan.pkg_oid),
              pkg_name: (plan.name as string | undefined) ?? String(plan.pkg_oid),
              item_oid: itemOid, supplier_oid: supplierOid,
              supplier_name: plan.supplier_name as string | undefined,
              is_bundle: isBundle, is_active: plan.is_active as boolean | undefined,
              current_platform: plan.current_platform as string | null | undefined,
              inventory_mode: plan.inventory_mode as string | undefined, queue: [],
            }
            rows.push(rs)
            updateRowChecked(rs, currentSubMode === 'shelf_schedule')
            cb.onclick = () => {
              clearFallback(fallbackEl)
              if (currentSubMode === 'inventory_platform') syncSiblings(rs)
              updateRowChecked(rs, currentSubMode === 'shelf_schedule')
            }
            row.appendChild(cb)

            // Name + pkg_oid
            const nameCell = document.createElement('div'); nameCell.className = 'bw-plan-name'
            const nameTop = document.createElement('div'); nameTop.className = 'bw-plan-name-top'
            const nameSpan = document.createElement('span'); renderText(nameSpan, rs.pkg_name); nameTop.appendChild(nameSpan)
            if (isBundle) {
              const bundleTag = document.createElement('span'); bundleTag.className = 'bw-bundle-tag'
              renderText(bundleTag, 'bundle'); nameTop.appendChild(bundleTag)
            }
            nameCell.appendChild(nameTop)
            const oidSpan = document.createElement('span'); oidSpan.className = 'bw-plan-name-oid'
            renderText(oidSpan, rs.pkg_oid); nameCell.appendChild(oidSpan)
            row.appendChild(nameCell)

            // Supplier
            const supplierSpan = document.createElement('span')
            renderText(supplierSpan, plan.supplier_name ? String(plan.supplier_name) : '—')
            row.appendChild(supplierSpan)

            // Status
            const statusWrap = document.createElement('span'); statusWrap.className = 'bw-status-badge'
            if (currentSubMode === 'inventory_setting') {
              if (plan.inventory_mode !== 'item_by_amount') {
                cb.disabled = true
                renderText(statusWrap, '目前不支援（僅套餐總量模式）')
                statusWrap.style.fontSize = '0.6875rem'; statusWrap.style.color = 'var(--bw-muted)'
              } else {
                const input = document.createElement('input')
                input.type = 'number'; input.min = '0'; input.step = '1'; input.className = 'bw-input'
                input.style.width = '100%'
                input.placeholder = plan.current_quantity != null ? String(plan.current_quantity) : '未設'
                rs.quantityInput = input
                statusWrap.appendChild(input)
              }
            } else if (currentSubMode === 'inventory_platform') {
              const dot = document.createElement('span')
              const hasPlatform = plan.current_platform != null
              dot.className = `bw-dot ${hasPlatform ? 'bw-dot-green' : 'bw-dot-gray'}`
              statusWrap.appendChild(dot)
              const sSpan = document.createElement('span')
              renderText(sSpan, hasPlatform ? String(plan.current_platform) : '—')
              statusWrap.appendChild(sSpan)
            } else if (currentSubMode === 'shelf_schedule') {
              const dot = document.createElement('span')
              const queueLen = Array.isArray(plan.reserve_queue) ? (plan.reserve_queue as unknown[]).length : 0
              dot.className = `bw-dot ${isBundle ? 'bw-dot-gray' : queueLen > 0 ? 'bw-dot-green' : 'bw-dot-gray'}`
              statusWrap.appendChild(dot)
              const sSpan = document.createElement('span')
              renderText(sSpan, isBundle ? '(bundle，不可個別排程)' : queueLen > 0 ? `現有 ${queueLen} 筆排程` : '（無排程）')
              statusWrap.appendChild(sSpan)
            } else {
              // shelf_toggle_plan / shelf_toggle_bundle: show active status
              const dot = document.createElement('span')
              const active = plan.is_active as boolean | undefined
              dot.className = `bw-dot ${active ? 'bw-dot-green' : 'bw-dot-red'}`
              statusWrap.appendChild(dot)
              const sSpan = document.createElement('span')
              renderText(sSpan, active ? '上架' : '下架')
              statusWrap.appendChild(sSpan)
            }
            row.appendChild(statusWrap)
            row.appendChild(badge)
            wrapper.appendChild(row)
            container.appendChild(wrapper)
          }
        }
      }
      applyVisibility()
    }

    function syncSiblings(changed: RowState): void {
      if (!changed.item_oid) return
      const on = changed.checkbox.checked
      for (const r of rows) {
        if (r !== changed && r.item_oid === changed.item_oid && r.supplier_oid === changed.supplier_oid) {
          r.checkbox.checked = on; r.badge.hidden = !on
          updateRowChecked(r, currentSubMode === 'shelf_schedule')
        }
      }
      if (!on) changed.badge.hidden = true
    }

    function renderDefaultTimeBar(): HTMLElement {
      const bar = document.createElement('div'); bar.className = 'bw-card'
      const title = document.createElement('div'); title.className = 'bw-card-title'
      renderText(title, '預設時間套用'); bar.appendChild(title)
      const row = document.createElement('div'); row.className = 'bw-row-inline'
      const date = document.createElement('input'); date.type = 'date'; date.className = 'bw-input'; date.dataset.role = 'defDate'
      const hour = document.createElement('input') as HTMLInputElement; hour.type = 'number'; hour.value = '0'; hour.className = 'bw-input'
      const minute = document.createElement('input') as HTMLInputElement; minute.type = 'number'; minute.value = '0'; minute.className = 'bw-input'
      const tz = document.createElement('select') as HTMLSelectElement; tz.className = 'bw-select'
      for (const z of ['Asia/Taipei', 'Asia/Tokyo', 'UTC']) { const opt = document.createElement('option'); opt.value = z; renderText(opt, z); tz.appendChild(opt) }
      tz.value = 'Asia/Taipei'
      const status = document.createElement('select') as HTMLSelectElement; status.className = 'bw-select'
      for (const [v, label] of [['true', '上架'], ['false', '下架'], ['clear', '取消排程']]) {
        const opt = document.createElement('option'); opt.value = v; renderText(opt, label); status.appendChild(opt)
      }
      status.value = 'true'
      status.onchange = () => {
        const isClear = status.value === 'clear'
        date.disabled = isClear; hour.disabled = isClear; minute.disabled = isClear; tz.disabled = isClear
      }
      const applyBtn = secondaryBtn('套用到所有已勾選', 'applyAllBtn', () => {
        clearFallback(fallbackEl); lastTz = tz.value
        const isClear = status.value === 'clear'
        if (!isClear) {
          const hh = Number(hour.value); const mm = Number(minute.value)
          if (!date.value || !Number.isInteger(hh) || hh < 0 || hh > 23 || !Number.isInteger(mm) || mm < 0 || mm > 59) {
            showFallback(fallbackEl, '請先選擇日期並確認時間（時 0–23、分 0–59）'); return
          }
          let utc: string
          try { utc = toUtcDateTime(date.value, `${hh}:${mm}`, tz.value).slice(0, 19) } catch { showFallback(fallbackEl, '時間格式錯誤'); return }
          // toUtcDateTime returns full datetime; use toReserveDateUtc-compat string
          for (const r of rows) {
            if (r.checkbox.checked && !r.is_bundle) {
              const existing = r.queue.find(q => q.reserve_date_utc === utc)
              if (existing) existing.reserve_status = status.value === 'true'
              else r.queue.push({ reserve_date_utc: utc, reserve_status: status.value === 'true' })
              r.cleared = false
              renderQueueBadge(r)
            }
          }
        } else {
          for (const r of rows) {
            if (r.checkbox.checked && !r.is_bundle) { r.queue = []; r.cleared = true; renderQueueBadge(r) }
          }
        }
      })
      row.appendChild(date); row.appendChild(hour); row.appendChild(minute); row.appendChild(tz); row.appendChild(status); row.appendChild(applyBtn)
      bar.appendChild(row); return bar
    }

    // ---- doNext: build items → create changeset ----
    async function doNextBatch(): Promise<void> {
      const wiz = WIZARDS[currentSubMode]
      if (!wiz) { showFallback(fallbackEl, '此次模式無對應精靈'); return }

      const target = currentSubMode === 'inventory_platform'
        ? (radioButtons.find(r => r.checked)?.value ?? 'BE2')
        : (shelfDir === 'on' ? 'on' : 'off')

      const rowInputs: WizardRowInput[] = rows.map(r => ({
        checked: r.checkbox.checked, is_bundle: r.is_bundle ?? false,
        prod_oid: r.prod_oid, pkg_oid: r.pkg_oid, pkg_name: r.pkg_name,
        item_oid: r.item_oid, supplier_oid: r.supplier_oid,
        queue: r.queue, cleared: r.cleared ?? false,
        quantity: r.quantityInput ? (Number.isNaN(r.quantityInput.valueAsNumber) ? undefined : r.quantityInput.valueAsNumber) : undefined,
      }))

      const items = wiz.buildItems(rowInputs, { target }) as Array<Record<string, unknown>>
      if (items.length === 0) { showFallback(fallbackEl, '請至少勾選一筆並填妥必要欄位'); return }
      // 單一 change-set 上限 20 筆（server createChangesetCore 的硬性 zod .max(20)）。超過時明確擋下
      // 並請使用者分批，而非讓 server 端 zod 丟出難懂的錯誤。（自動拆成多個 change-set 的流程未實作。）
      if (items.length > 20) { showFallback(fallbackEl, `本次共 ${items.length} 筆，一次最多送出 20 筆；請減少勾選後分批送出。`); return }

      clearFallback(fallbackEl)
      statusEl.textContent = '建立變更中…'
      try {
        const createR = await app.callServerTool({
          name: 'app_create_changeset',
          arguments: { action_type: serverActionType(currentSubMode), items },
        })
        if (createR.isError) {
          const errText = tryParseErrorText(createR)
          showFallback(fallbackEl, errText ? `建立變更失敗：${errText}` : '建立變更失敗'); return
        }
        const created = createR.structuredContent?.items?.[0] as { changeset_id?: string } | undefined
        if (!created?.changeset_id) { showFallback(fallbackEl, '建立變更失敗：未取得 changeset_id'); return }
        changesetId = created.changeset_id
        const rec = await loadView()
        if (!rec) return
        renderStep2(rec)
      } catch (e) { showFallback(fallbackEl, '建立變更失敗：' + String(e)) }
    }
  }

  // =====================================================================
  // ANNOUNCEMENT FLOW
  // =====================================================================

  function renderAnnouncementStep1(): void {
    // OID input card
    const inputCard = document.createElement('div'); inputCard.className = 'bw-card'
    const title = document.createElement('div'); title.className = 'bw-card-title'; renderText(title, '商品')
    inputCard.appendChild(title)
    const inputRow = document.createElement('div'); inputRow.className = 'bw-row-inline'
    const prodInput = document.createElement('input') as HTMLInputElement
    prodInput.type = 'text'; prodInput.className = 'bw-input'; prodInput.placeholder = '商品 oid，逗號或空白分隔'
    prodInput.value = loadedProdOids.join(', '); prodInput.dataset.role = 'prodOidsInput'
    inputRow.appendChild(prodInput)
    inputRow.appendChild(primaryBtn('載入', 'loadBtn', () => { void doLoadAnn(prodInput.value) }))
    inputCard.appendChild(inputRow)
    workspaceEl.appendChild(inputCard)

    // Product list
    const listCard = document.createElement('div'); listCard.className = 'bw-card'; listCard.dataset.role = 'prodList'; listCard.hidden = true
    workspaceEl.appendChild(listCard)

    // Announcement form (shown after load)
    const formCard = document.createElement('div'); formCard.className = 'bw-card'; formCard.hidden = true; formCard.dataset.role = 'annForm'
    workspaceEl.appendChild(formCard)

    async function doLoadAnn(raw: string): Promise<void> {
      const prodOids = parseOidInput(raw)
      if (prodOids.length === 0) { showFallback(fallbackEl, '請輸入至少一個商品 oid'); return }
      statusEl.textContent = '載入中…'; clearFallback(fallbackEl)
      try {
        const r = await app.callServerTool({ name: 'app_get_announcement_view', arguments: { prod_oids: prodOids } })
        if (r.isError) { showFallback(fallbackEl, '載入失敗'); return }
        const products = (r.structuredContent?.items?.[0] as { products?: Array<Record<string, unknown>> } | undefined)?.products ?? []
        loadedProdOids = products.map(p => String(p.prod_oid))
        renderProdList(listCard, products)
        renderAnnForm(formCard)
        statusEl.textContent = `已載入 ${products.length} 個商品`
      } catch (e) { showFallback(fallbackEl, '載入失敗：' + String(e)) }
    }

    function renderProdList(container: HTMLElement, products: Array<Record<string, unknown>>): void {
      container.hidden = false; container.textContent = ''
      const t = document.createElement('div'); t.className = 'bw-card-title'; renderText(t, '將對這些商品建立公告'); container.appendChild(t)
      for (const p of products) {
        const line = document.createElement('div'); line.style.cssText = 'font-size:.875rem;padding:.25rem 0'
        const ex = p.existing_count == null ? '（既有公告數未知）' : `（既有公告 ${Number(p.existing_count)} 筆）`
        renderText(line, `${p.name ?? p.prod_oid}  ${p.prod_oid} ${ex}`)
        container.appendChild(line)
      }
    }

    function renderAnnForm(container: HTMLElement): void {
      container.hidden = false; container.textContent = ''
      const a = annState

      // Name
      const nameWrap = document.createElement('div'); nameWrap.className = 'wb-field'
      const nameLabel = document.createElement('label'); renderText(nameLabel, '公告標題（≤254）'); nameWrap.appendChild(nameLabel)
      const nameInput = document.createElement('input') as HTMLInputElement
      nameInput.type = 'text'; nameInput.className = 'bw-input'; nameInput.value = a.name; nameInput.dataset.role = 'nameInput'
      nameInput.oninput = () => { a.name = nameInput.value }
      nameWrap.appendChild(nameInput); container.appendChild(nameWrap)

      // isEnabled
      const enWrap = document.createElement('div'); enWrap.className = 'wb-field'
      const enLabel = document.createElement('label'); renderText(enLabel, '啟用'); enWrap.appendChild(enLabel)
      const enInput = document.createElement('input') as HTMLInputElement
      enInput.type = 'checkbox'; enInput.checked = a.isEnabled; enInput.dataset.role = 'enabledInput'
      enInput.onchange = () => { a.isEnabled = enInput.checked }
      enWrap.appendChild(enInput); container.appendChild(enWrap)

      // Start time
      const startWrap = document.createElement('div'); startWrap.className = 'wb-field'
      const startLabel = document.createElement('label'); renderText(startLabel, '開始時間'); startWrap.appendChild(startLabel)
      const startRow = document.createElement('div'); startRow.className = 'bw-row-inline'
      const startDate = mkInput('date', 'startDate'); startDate.value = a.startDate; startDate.oninput = () => { a.startDate = startDate.value }
      const startTime = mkInput('time', 'startTime'); startTime.value = a.startTime; startTime.oninput = () => { a.startTime = startTime.value }
      const startTz = mkTz('startTz'); startTz.value = a.startTz; startTz.onchange = () => { a.startTz = startTz.value }
      startRow.appendChild(startDate); startRow.appendChild(startTime); startRow.appendChild(startTz)
      startWrap.appendChild(startRow); container.appendChild(startWrap)

      // End time
      const endWrap = document.createElement('div'); endWrap.className = 'wb-field'
      const endLabel = document.createElement('label'); renderText(endLabel, '結束時間（選填）'); endWrap.appendChild(endLabel)
      const endRow = document.createElement('div'); endRow.className = 'bw-row-inline'
      const endDate = mkInput('date', 'endDate'); endDate.value = a.endDate; endDate.oninput = () => { a.endDate = endDate.value }
      const endTime = mkInput('time', 'endTime'); endTime.value = a.endTime; endTime.oninput = () => { a.endTime = endTime.value }
      const endTz = mkTz('endTz'); endTz.value = a.endTz; endTz.onchange = () => { a.endTz = endTz.value }
      endRow.appendChild(endDate); endRow.appendChild(endTime); endRow.appendChild(endTz)
      endWrap.appendChild(endRow); container.appendChild(endWrap)

      // Paste area for announcement content (ingestAnnouncement)
      const pasteWrap = document.createElement('div'); pasteWrap.className = 'wb-field'
      const pasteLabel = document.createElement('label'); renderText(pasteLabel, '公告內容（貼上 kkday-announcement-translate skill 的回覆）')
      pasteWrap.appendChild(pasteLabel)
      const pasteArea = document.createElement('textarea') as HTMLTextAreaElement
      pasteArea.className = 'bw-input'; pasteArea.rows = 3; pasteArea.placeholder = '把 Claude 的回覆貼在這裡'; pasteArea.style.width = '100%'
      pasteWrap.appendChild(pasteArea)
      const pasteBtn = secondaryBtn('以新貼上的內容取代', 'annReplaceBtn', () => {
        const result = ingestAnnouncement(pasteArea.value)
        if (!result) { showFallback(fallbackEl, '內容格式不符：需含 be2-announcement-content JSON'); return }
        clearFallback(fallbackEl)
        a.langContents.clear(); a.selectedLangs.clear()
        for (const l of result.langs) { a.langContents.set(l.langCode, l.content); a.selectedLangs.add(l.langCode) }
        renderLangList()
      })
      pasteWrap.appendChild(pasteBtn)
      container.appendChild(pasteWrap)

      // Lang list container
      const langContainer = document.createElement('div'); langContainer.dataset.role = 'langList'
      container.appendChild(langContainer)

      function renderLangList(): void {
        langContainer.textContent = ''
        const langTitle = document.createElement('div'); langTitle.className = 'bw-card-title'; renderText(langTitle, '語系與內文')
        langContainer.appendChild(langTitle)
        for (const loc of ANN_LOCALES) {
          const lr = document.createElement('div'); lr.className = 'wb-lang-row'
          const top = document.createElement('div'); top.className = 'bw-row-inline'
          const cb = document.createElement('input') as HTMLInputElement
          cb.type = 'checkbox'; cb.checked = a.selectedLangs.has(loc.code)
          const content = a.langContents.get(loc.code) ?? ''
          if (!content) cb.disabled = true
          cb.onchange = () => { cb.checked ? a.selectedLangs.add(loc.code) : a.selectedLangs.delete(loc.code) }
          const cbLabel = document.createElement('span'); renderText(cbLabel, `${loc.code} — ${loc.name}`)
          top.appendChild(cb); top.appendChild(cbLabel); lr.appendChild(top)
          if (content) {
            const contentDiv = document.createElement('div'); contentDiv.style.cssText = 'font-size:.8125rem;color:var(--bw-muted);padding-left:1.5rem'
            renderText(contentDiv, content); lr.appendChild(contentDiv)
          }
          langContainer.appendChild(lr)
        }
        const selectedCount = [...a.selectedLangs].filter(c => (a.langContents.get(c) ?? '').trim()).length
        const countNote = document.createElement('div'); countNote.style.cssText = 'font-size:.75rem;color:var(--bw-muted);margin-top:.5rem'
        renderText(countNote, `已選 ${selectedCount} 語系`); langContainer.appendChild(countNote)
      }

      if (a.langContents.size > 0) renderLangList()

      // Footer
      const footer = document.createElement('div'); footer.className = 'bw-row-footer'
      footer.appendChild(primaryBtn('下一步：檢視', 'nextAnnBtn', () => { void doNextAnn() }))
      container.appendChild(footer)
    }

    async function doNextAnn(): Promise<void> {
      const a = annState
      if (!a.name.trim()) { showFallback(fallbackEl, '請填公告標題'); return }
      if (!a.startDate) { showFallback(fallbackEl, '請選開始日期'); return }
      let start_time: string
      try { start_time = toUtcDateTime(a.startDate, a.startTime || '00:00', a.startTz) } catch { showFallback(fallbackEl, '開始時間格式錯誤'); return }
      let end_time: string | null = null
      if (a.endDate) {
        try { end_time = toUtcDateTime(a.endDate, a.endTime || '00:00', a.endTz) } catch { showFallback(fallbackEl, '結束時間格式錯誤'); return }
      }
      const langs: string[] = []
      const contents: Array<{ lang: string; content: string }> = []
      for (const loc of ANN_LOCALES) {
        if (a.selectedLangs.has(loc.code)) {
          const c = (a.langContents.get(loc.code) ?? '').trim()
          if (c) { langs.push(loc.code); contents.push({ lang: loc.code, content: c }) }
        }
      }
      if (langs.length === 0) { showFallback(fallbackEl, '請至少選一個語系'); return }
      if (loadedProdOids.length === 0) { showFallback(fallbackEl, '請先載入商品'); return }

      // Build announcement item — fields align with AnnouncementCreateItem / announcement module itemSchema
      const item: AnnouncementCreateItem = {
        prod_oids: loadedProdOids,
        name: a.name.trim(),
        is_enabled: a.isEnabled,
        start_time,
        end_time,
        langs,
        contents,
      }
      clearFallback(fallbackEl)
      statusEl.textContent = '建立變更中…'
      try {
        const createR = await app.callServerTool({
          name: 'app_create_changeset',
          arguments: { action_type: 'announcement', items: [item] },
        })
        if (createR.isError) {
          const errText = tryParseErrorText(createR)
          showFallback(fallbackEl, errText ? `建立變更失敗：${errText}` : '建立變更失敗'); return
        }
        const created = createR.structuredContent?.items?.[0] as { changeset_id?: string } | undefined
        if (!created?.changeset_id) { showFallback(fallbackEl, '建立變更失敗：未取得 changeset_id'); return }
        changesetId = created.changeset_id
        const rec = await loadView()
        if (!rec) return
        renderStep2(rec)
      } catch (e) { showFallback(fallbackEl, '建立變更失敗：' + String(e)) }
    }
  }

  // =====================================================================
  // Shared: loadView, renderStep2, renderStep3, renderStep4
  // =====================================================================

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

  function renderQueueLines(el: HTMLElement, queue: ScheduleEntry[], emptyLabel = '(空，將清除排程)'): void {
    if (queue.length === 0) {
      const p = document.createElement('div'); p.className = 'bw-queue-empty'; renderText(p, emptyLabel); el.appendChild(p); return
    }
    for (const e of queue) {
      const line = document.createElement('div'); line.className = 'bw-queue-line'
      const full = formatDualDisplay(e.reserve_date_utc, lastTz)
      const sepIdx = full.indexOf(' / ')
      const localPart = sepIdx === -1 ? full : full.slice(0, sepIdx)
      const utcPart = sepIdx === -1 ? '' : full.slice(sepIdx + 3)
      const localSpan = document.createElement('span'); localSpan.className = 'bw-time-local'; renderText(localSpan, localPart); line.appendChild(localSpan)
      if (utcPart) { const utcSpan = document.createElement('span'); utcSpan.className = 'bw-time-utc'; renderText(utcSpan, utcPart); line.appendChild(utcSpan) }
      el.appendChild(line)
    }
  }

  function renderDiffCard(d: Record<string, unknown>): HTMLElement {
    const domHelpers: DomHelpers = {
      el(tag: string, className?: string) { const e = document.createElement(tag); if (className) e.className = className; return e },
      text: renderText,
      renderQueueLines: (el: HTMLElement, q: unknown[], emptyLabel?: string) => renderQueueLines(el, q as ScheduleEntry[], emptyLabel),
    }
    const wiz = WIZARDS[currentSubMode]
    if (wiz) return wiz.renderDiffCard(d, domHelpers)
    // Announcement diff: inline rendering (no WizardDescriptor)
    if (currentSubMode === 'announcement') {
      const card = domHelpers.el('div', 'bw-diff-card')
      const nm = domHelpers.el('div', 'bw-diff-title'); renderText(nm, `公告：${d.name}`); card.appendChild(nm)
      const pr = domHelpers.el('div')
      const names = (d.product_names as string[] | undefined) ?? []
      renderText(pr, `商品：${names.length ? names.join('、') : (d.prod_oids as string[])?.join('、') ?? ''}`)
      card.appendChild(pr)
      const tm = domHelpers.el('div'); renderText(tm, `生效：${d.start_time}${d.end_time ? ' ~ ' + d.end_time : ''}（UTC）`); card.appendChild(tm)
      const lg = domHelpers.el('div'); renderText(lg, `語系：${((d.langs as string[]) ?? []).join(', ')}`); card.appendChild(lg)
      for (const c of ((d.contents as Array<{ lang: string; content: string }>) ?? [])) {
        const cl = domHelpers.el('div'); renderText(cl, `${c.lang}: ${c.content}`); card.appendChild(cl)
      }
      return card
    }
    // Fallback: raw dump
    const card = document.createElement('div'); card.className = 'bw-diff-card'; renderText(card, d); return card
  }

  // ---- Step 2: 檢視 ----
  function renderStep2(rec: Record<string, unknown>): void {
    setStep(2)
    lastViewRec = rec
    workspaceEl.textContent = ''
    renderNav()
    workspaceEl.appendChild(progressEl)

    // Warning for announcement
    if (currentSubMode === 'announcement') {
      const warn = document.createElement('div'); warn.className = 'bw-banner bw-banner-danger'
      renderText(warn, '商品公告會即時對前台顯示，請確認內容與生效時間後再批准。'); workspaceEl.appendChild(warn)
      // en-default warning
      if (currentDiffItems.some(d => !((d.langs as string[] | undefined) ?? []).includes('en-default'))) {
        const note = document.createElement('div'); note.className = 'bw-banner bw-banner-warn'
        renderText(note, '提醒：未含 en-default 語系（en-xx fallback 文案來源）；此為提醒、不阻擋批准。')
        workspaceEl.appendChild(note)
      }
    } else {
      // Warning text from WizardDescriptor
      const wiz = WIZARDS[currentSubMode]
      if (wiz?.step2WarningText) {
        const warn = document.createElement('div'); warn.className = 'bw-banner bw-banner-danger'
        renderText(warn, wiz.step2WarningText); workspaceEl.appendChild(warn)
      }
    }

    // 本次批次筆數（已在 doNextBatch 以 ≤20 為前提擋過，此處恆為單一 change-set）
    const batchSummary = document.createElement('div')
    batchSummary.style.cssText = 'font-size:.875rem;color:var(--bw-muted);margin-bottom:.75rem'
    renderText(batchSummary, `本次 = ${currentDiffItems.length} 筆變更（1 個 change-set）`)
    workspaceEl.appendChild(batchSummary)

    // Diff cards
    const listCard = document.createElement('div'); listCard.className = 'bw-card'
    for (const d of currentDiffItems) listCard.appendChild(renderDiffCard(d))
    workspaceEl.appendChild(listCard)

    if (rec.note) {
      const noteCard = document.createElement('div'); noteCard.className = 'bw-card'
      const noteP = document.createElement('p'); renderText(noteP, `備註：${String(rec.note)}`); noteCard.appendChild(noteP)
      workspaceEl.appendChild(noteCard)
    }

    const footer = document.createElement('div'); footer.className = 'bw-row-footer'
    footer.appendChild(secondaryBtn('← 返回選擇', 'backToStep1Btn', () => {
      // Reject on back navigation (same as batch-wizard)
      if (changesetId && currentNonce && currentDiffVersion) {
        app.callServerTool({
          name: 'app_confirm_changeset',
          arguments: { changeset_id: changesetId, decision: 'reject', nonce: currentNonce, diff_version: currentDiffVersion, confirmed_keys: [] },
        }).catch(() => {})
      }
      renderWorkspace()
    }))
    footer.appendChild(primaryBtn('前往批准', 'toApproveBtn', () => renderStep3()))
    workspaceEl.appendChild(footer)
  }

  // ---- Step 3: 批准 ----
  function renderStep3(): void {
    setStep(3)
    workspaceEl.textContent = ''
    renderNav()
    workspaceEl.appendChild(progressEl)

    const card = document.createElement('div'); card.className = 'bw-card'
    const desc = document.createElement('p')
    renderText(desc, '按下後將送出批准並立即執行本次變更。')
    card.appendChild(desc)
    const footer = document.createElement('div'); footer.className = 'bw-row-footer'
    footer.appendChild(secondaryBtn('← 回檢視', 'backToStep2Btn', () => {
      if (lastViewRec) renderStep2(lastViewRec)
    }))
    footer.appendChild(primaryBtn('確認執行', 'approveBtn', () => { void doApprove() }))
    card.appendChild(footer)
    workspaceEl.appendChild(card)
  }

  async function doApprove(): Promise<void> {
    if (!changesetId || !currentNonce || !currentDiffVersion) { showFallback(fallbackEl, '缺少批准所需資訊，請回上一步重載'); return }
    statusEl.textContent = '執行中…'
    let confirmedKeys: string[]
    if (currentSubMode === 'announcement') {
      // For announcement, use the same itemKey as announcement-wizard.ts
      confirmedKeys = currentDiffItems.map(d => {
        const fakeItem: AnnouncementCreateItem = {
          prod_oids: (d.prod_oids as string[]) ?? [],
          name: String(d.name ?? ''),
          is_enabled: Boolean(d.is_enabled),
          start_time: String(d.start_time ?? ''),
          end_time: (d.end_time as string | null) ?? null,
          langs: (d.langs as string[]) ?? [],
          contents: (d.contents as Array<{ lang: string; content: string }>) ?? [],
        }
        return announcementItemKey(fakeItem)
      })
    } else {
      const wiz = WIZARDS[currentSubMode]!
      confirmedKeys = currentDiffItems.map(wiz.itemKey)
    }
    try {
      const r = await app.callServerTool({
        name: 'app_confirm_changeset',
        arguments: { changeset_id: changesetId, decision: 'approve', nonce: currentNonce, diff_version: currentDiffVersion, confirmed_keys: confirmedKeys },
      })
      const env = r.structuredContent
      const err = env?.errors?.[0]
      if (err?.code === 'DIFF_STALE') { renderStaleNotice(); return }
      if (err) { showFallback(fallbackEl, `批准失敗：${err.code ?? ''} ${err.message ?? ''}`); return }
      const rec = (env?.items?.[0] as { results?: unknown[] } | undefined) ?? {}
      renderStep4((rec.results as Array<Record<string, unknown>> | undefined) ?? [])
    } catch (e) { showFallback(fallbackEl, '送出失敗：' + String(e)) }
  }

  function renderStaleNotice(): void {
    showFallback(fallbackEl, '現況已變，請按下方按鈕重新載入檢視後再次批准')
    const backBtn = workspaceEl.querySelector('[data-role=backToStep2Btn]') as HTMLButtonElement | null
    if (backBtn) {
      backBtn.textContent = '回檢視重載'; backBtn.dataset.role = 'reloadBtn'
      backBtn.onclick = () => { void doReload() }
    }
  }

  async function doReload(): Promise<void> {
    fallbackEl.hidden = true; statusEl.textContent = '重新載入中…'
    const rec = await loadView()
    if (!rec) return
    renderStep2(rec)
  }

  // ---- Step 4: 結果 ----
  function renderStep4(results: Array<Record<string, unknown>>): void {
    setStep(4)
    workspaceEl.textContent = ''; statusEl.textContent = '完成'
    renderNav()
    workspaceEl.appendChild(progressEl)

    const card = document.createElement('div'); card.className = 'bw-card'
    if (results.length === 0) {
      const p = document.createElement('div'); renderText(p, '（無結果）'); card.appendChild(p)
    }
    for (const res of results) {
      const row = document.createElement('div'); row.className = 'bw-ledger-row'
      const status = String(res.status)
      let kind = 'error'
      if (status === 'done' || status === 'scheduled') kind = 'ok'
      else if (status === 'skipped_noop' || status === 'cancelled') kind = 'skip'

      const dot = document.createElement('span')
      dot.className = `bw-dot ${kind === 'ok' ? 'bw-dot-green' : kind === 'skip' ? 'bw-dot-gray' : 'bw-dot-red'}`
      row.appendChild(dot)

      const keyWrap = document.createElement('div'); keyWrap.className = 'bw-plan-name'
      const keySpan = document.createElement('span'); keySpan.className = 'bw-ledger-key'
      renderText(keySpan, String(res.item_key ?? '')); keyWrap.appendChild(keySpan)
      row.appendChild(keyWrap)

      const statusSpan = document.createElement('span')
      let statusLabel = ''
      if (status === 'done') statusLabel = '已完成'
      else if (status === 'skipped_noop') statusLabel = '無變更，略過'
      else if (status === 'scheduled') statusLabel = '已排程'
      else if (status === 'cancelled') statusLabel = '取消排程'
      else statusLabel = `失敗（${status}）`
      statusSpan.className = `bw-ledger-status bw-ledger-status-${kind}`
      renderText(statusSpan, statusLabel); row.appendChild(statusSpan)

      if (kind === 'error' && res.error_code) {
        const codeSpan = document.createElement('span'); codeSpan.className = 'bw-ledger-code'
        renderText(codeSpan, String(res.error_code)); row.appendChild(codeSpan)
      }
      card.appendChild(row)
    }
    workspaceEl.appendChild(card)

    const btnRow = document.createElement('div'); btnRow.className = 'bw-row-footer'
    btnRow.appendChild(secondaryBtn('開始新操作', 'newBatchBtn', () => {
      changesetId = undefined; currentNonce = undefined; currentDiffVersion = undefined
      currentDiffItems = []; lastViewRec = undefined
      clearFallback(fallbackEl)
      annState = resetAnnState()
      renderWorkspace()
    }))
    workspaceEl.appendChild(btnRow)
  }

  // ---- Error parsing helper (same as batch-wizard) ----
  function tryParseErrorText(r: { content?: Array<{ type: string; text: string }>; structuredContent?: { errors?: Array<{ code?: string; message?: string }> } }): string | undefined {
    const sErr = r.structuredContent?.errors?.[0]
    if (sErr?.code && sErr?.message) return `${sErr.code} — ${sErr.message}`
    try {
      const raw = r.content?.[0]?.text
      if (raw) {
        const parsed = JSON.parse(raw)
        const errs = parsed.errors
        if (Array.isArray(errs) && errs.length > 0 && errs[0]?.code && errs[0]?.message) return `${errs[0].code} — ${errs[0].message}`
      }
    } catch {}
    return undefined
  }

  // ---- Input helpers ----
  function mkInput(type: string, role: string): HTMLInputElement {
    const i = document.createElement('input') as HTMLInputElement
    i.type = type; i.className = 'bw-input'; i.dataset.role = role; return i
  }
  function mkTz(role: string): HTMLSelectElement {
    const s = document.createElement('select') as HTMLSelectElement
    s.className = 'bw-select'; s.dataset.role = role
    for (const z of Object.keys(TZ_OFFSET_HOURS)) { const o = document.createElement('option'); o.value = z; renderText(o, z); s.appendChild(o) }
    s.value = 'Asia/Taipei'; return s
  }

  // ---- Initial render ----
  renderWorkspace()
}

// ---------------------------------------------------------------------------
// Bootstrap (same pattern as batch-wizard.ts / announcement-wizard.ts)
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  connectApp('be2-workbench').then(a => initWorkbench(a as unknown as WizardApp)).catch(e => {
    const fb = document.getElementById('fallback')!
    fb.hidden = false; fb.textContent = '無法連上 host：' + String(e)
  })
}
