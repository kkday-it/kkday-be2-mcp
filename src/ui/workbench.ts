// src/ui/workbench.ts — be2 統一工作台面板（版型 B）。
//
// 版型 B 結構：左側「深色」導覽列（商品上下架 / 商品庫存 / 商品公告）＋ 品牌 ＋ 身分頁腳；
// 主區為步驟條（選擇→檢視→批准→結果，可回退）。選擇頁為兩欄：左編輯區 + 右「本次變更」
// 常駐即時摘要（大數字 + 依商品可折疊清單 + 檢視全部）。
//
// 上下架採「單一方向」分段（全部上架/全部下架）+ 多商品頁籤 + 單一整合清單（整個商品列 + 各方案列
// 同框）+ 底部全域「排程」勾選 + 時間。庫存保留「逐日數量」與「平台切換」兩子模式（小分段切換）。
//
// 真實工具 wiring（沿用、未 mock）：connectApp host bridge、app_get_batch_view（載入商品→方案+現況）、
// app_create_changeset（建 draft）、app_get_changeset_view（diff+nonce）、app_confirm_changeset（nonce 批准）、
// buildActionChunks（>20 筆拆多個 change-set，逐批 create→view→confirm）、各 module 的 WizardDescriptor
// （buildItems/renderDiffCard/itemKey）、公告 item 形狀（AnnouncementCreateItem + announcementItemKey）、
// resultNameByKey（結果 item_key → 商品名·方案名）、parseOidInput/ingestAnnouncement、toUtcDateTime。
//
// 上下架 → 後端 action_type 路由：整個商品→shelf_toggle_product；一般方案→shelf_toggle_plan；
// 組合方案(is_bundle)→shelf_toggle_bundle（各自一組 change-set）；全域排程 ON → 只有一般方案可排程 →
// shelf_schedule（單一時間轉成一筆 reserve_queue {reserve_date_utc, reserve_status: 方向==上架}）。

import { connectApp, renderText } from './panelShared.js'
import { parseOidInput, buildActionChunks, ingestAnnouncement } from './workbenchLogic.js'
import { inventoryPlatformWizard } from '../modules/product/inventoryPlatform/ui.js'
import { inventorySettingWizard } from '../modules/product/inventorySetting/ui.js'
import { shelfScheduleWizard } from '../modules/product/shelfSchedule/ui.js'
import { shelfToggleProductWizard, shelfTogglePlanWizard } from '../modules/product/shelfToggle/ui.js'
import { shelfToggleBundleWizard } from '../modules/product/shelfToggleBundle/ui.js'
import { itemKey as announcementItemKey } from '../modules/announcement/create/keys.js'
import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../core/changeset/module.js'
import type { AnnouncementCreateItem } from '../core/changeset/types.js'

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type FuncKey = 'shelf' | 'inventory' | 'announce'
type InvMode = 'inventory_setting' | 'inventory_platform'
type ChunkActionType =
  | 'shelf_toggle_product' | 'shelf_toggle_plan' | 'shelf_toggle_bundle' | 'shelf_schedule'
  | 'inventory_setting' | 'inventory_platform' | 'announcement'

interface FuncDesc { key: FuncKey; label: string; sub: string; risk: string }
const FUNCS: FuncDesc[] = [
  { key: 'shelf', label: '商品上下架', sub: '商品 / 方案 · 排程', risk: '方案或商品上下架會即時改變前台可售並清快取。' },
  { key: 'inventory', label: '商品庫存', sub: '逐日數量 / 平台切換', risk: '庫存寫入會即時反映前台可售並清 cache。' },
  { key: 'announce', label: '商品公告', sub: '公告內容 · 多語系', risk: '' },
]

const STEP_LABELS = ['選擇', '檢視', '批准', '結果']
const BATCH_CAP = 20

// WizardDescriptor per non-announcement action_type
const WIZARDS: Partial<Record<ChunkActionType, WizardDescriptor>> = {
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

function formatDualDisplay(reserveDateUtc: string, tz: string): { local: string; utc: string } {
  const offset = TZ_OFFSET_HOURS[tz] ?? 0
  const ms = Date.parse(reserveDateUtc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return { local: reserveDateUtc, utc: '' }
  const local = new Date(ms + offset * 3600_000)
  const localStr = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`
  const sign = offset >= 0 ? '+' : '-'
  return { local: `${localStr} (GMT${sign}${Math.abs(offset)})`, utc: `${reserveDateUtc} UTC` }
}

const PLATFORM_LABELS: Record<string, string> = {
  BE2: 'BE2 管理', BE2_SCM: 'BE2 / SCM 管理', EXTERNAL: '串接外部庫存（含 rezio）',
}
const platformLabel = (v: string | null | undefined): string => (v == null ? '無法讀取' : (PLATFORM_LABELS[v] ?? v))

// 公告 15 語系（對齊 kkday-announcement-translate skill 契約；順序照 canonical）
const ANN_LOCALES: Array<{ code: string; name: string }> = [
  { code: 'zh-tw', name: '繁體中文（台灣）' }, { code: 'zh-hk', name: '繁體中文（香港）' },
  { code: 'zh-cn', name: '简体中文' }, { code: 'zh-my', name: '简体中文（马来西亚）' },
  { code: 'en-default', name: 'English（all en markets）' }, { code: 'ja-jp', name: '日本語' }, { code: 'ko-kr', name: '한국어' },
  { code: 'th-th', name: 'ภาษาไทย' }, { code: 'vi-vn', name: 'Tiếng Việt' }, { code: 'id-id', name: 'Bahasa Indonesia' },
  { code: 'ms-my', name: 'Bahasa Melayu' }, { code: 'tl-ph', name: 'Filipino' }, { code: 'fr-fr', name: 'Français' },
  { code: 'es-es', name: 'Español' }, { code: 'hi-in', name: 'हिन्दी' },
]

// ---------------------------------------------------------------------------
// Style — ported from workbench-prototype.html (版型 B), injected once.
// ---------------------------------------------------------------------------
const STYLE = `
:root{
  --ground:#F4F5F7;--surface:#FFFFFF;--surface-2:#FAFBFC;
  --border:#E4E7EC;--border-strong:#D0D5DD;
  --ink:#191C22;--muted:#667085;--faint:#98A2B3;
  --accent:#E85D04;--accent-ink:#B84a03;--accent-wash:#FDEEE2;
  --good:#1F9D6B;--good-wash:#E7F6EF;
  --crit:#D92D20;--crit-wash:#FEE4E2;
  --nav:#1D2430;--nav-ink:#C7CDD6;
  --r:10px;--r-sm:6px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;
}
*{box-sizing:border-box}
html,body{background:var(--ground)}
body{margin:0;color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4,h5{margin:0;text-wrap:balance}
button{font-family:inherit;cursor:pointer}
[hidden]{display:none!important}
.tnum{font-variant-numeric:tabular-nums}
.oid{font-family:var(--mono);color:var(--faint);font-size:12px}.mono{font-family:var(--mono)}
.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
.muted{color:var(--muted)}.mt8{margin-top:8px}.mt12{margin-top:12px}.mt16{margin-top:16px}

#status{display:none}
#fallback{white-space:pre-wrap}
.wb-banner{background:var(--crit-wash);color:#912018;border:1px solid #FDA29B;border-radius:var(--r-sm);padding:10px 12px;font-size:13px;margin:0 0 12px}

/* 單欄、窄框友善（MCP Apps 面板約 600–720px）：品牌條 → 功能頁籤 → 步驟條 → 內容 */
.wrap{max-width:760px;margin:16px auto;padding:0 14px}
.panel{border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)}
.brandbar{background:var(--nav);color:#fff;padding:7px 14px;font-size:12px;font-weight:800;letter-spacing:.02em;display:flex;align-items:center;gap:8px}
.brandbar small{font-weight:500;color:var(--nav-ink);font-size:11px}
.brandbar .foot{margin-left:auto;font-weight:500;color:var(--nav-ink);font-size:11px}
.functabs{display:flex;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto}
.functab{flex:1 1 0;min-width:max-content;display:flex;flex-direction:column;gap:1px;align-items:center;justify-content:center;text-align:center;background:transparent;border:0;border-bottom:2px solid transparent;padding:9px 12px;color:var(--muted);font-weight:600}
.functab .t{font-size:13px}.functab .s{font-size:11px;opacity:.72;font-weight:500}
.functab:hover{background:var(--surface-2);color:var(--ink)}
.functab[aria-pressed=true]{color:var(--accent-ink);border-bottom-color:var(--accent);background:var(--accent-wash)}
.functab:disabled{opacity:.4;cursor:not-allowed}

.main{display:flex;flex-direction:column;min-width:0}
.steprail{display:flex;border-bottom:1px solid var(--border);background:var(--surface-2)}
.steprail .st{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;color:var(--muted);padding:11px 4px;border-bottom:2px solid transparent;background:transparent;border-top:0;border-left:0;border-right:0}
.steprail .st .n{width:20px;height:20px;border-radius:50%;background:#E4E7EC;color:var(--muted);display:grid;place-items:center;font-size:11px;font-weight:700}
.steprail .st.on{color:var(--ink);border-bottom-color:var(--accent);font-weight:700}
.steprail .st.on .n{background:var(--accent);color:#fff}
.steprail .st.done{color:var(--good)}.steprail .st.done .n{background:var(--good);color:#fff}
.steprail .st.clk{cursor:pointer}.steprail .st.clk:hover{background:#EFF1F4}

.work{padding:16px 18px;min-width:0}
.page{padding:18px 18px}

/* 頂部 compact 小計（取代側欄大摘要） */
.summarybar{margin:14px 18px 0;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface-2);overflow:hidden}
.summaryhd{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;background:transparent;border:0;text-align:left;cursor:pointer;font-size:13px;color:var(--ink)}
.summaryhd .car{color:var(--faint);font-size:12px;width:12px}
.summaryhd .cntbig{font-weight:800;color:var(--accent-ink)}
.summaryhd .go{margin-left:auto;color:var(--accent-ink);font-weight:700;font-size:12px;border:0;background:transparent;padding:2px 4px}
.summaryhd .go:disabled{color:var(--faint);cursor:not-allowed}
.summarybody{padding:2px 12px 8px;border-top:1px solid var(--border)}

.loader{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);padding:14px}
.loader .addrow{display:flex;gap:8px;align-items:center;margin-top:8px}
.loader input[type=text]{flex:1;font-family:inherit;font-size:13px;border:1px solid var(--border-strong);border-radius:var(--r-sm);padding:8px 10px;background:var(--surface)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border-strong);border-radius:999px;padding:4px 6px 4px 11px;font-size:12px;font-weight:600}
.chip .x{border:0;background:transparent;color:var(--faint);font-size:15px;line-height:1;padding:0 2px}.chip .x:hover{color:var(--crit)}
.btn{border:1px solid var(--border-strong);background:var(--surface);color:var(--ink);padding:8px 14px;border-radius:var(--r-sm);font-weight:600;font-size:13px}
.btn:hover{background:var(--surface-2)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{background:var(--accent-ink)}
.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}
.btn.sm{padding:5px 10px;font-size:12px}.btn:disabled{opacity:.45;cursor:not-allowed}

.dirbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px}
.seg{display:inline-flex;background:#EDEFF2;border-radius:999px;padding:3px}
.seg button{border:0;background:transparent;padding:6px 16px;border-radius:999px;font-weight:600;font-size:13px;color:var(--muted)}
.seg button[aria-pressed=true]{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.12)}

.tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--border);margin-top:16px}
.tab{flex:none;display:flex;align-items:center;gap:7px;background:transparent;border:1px solid transparent;border-bottom:0;padding:9px 13px;border-radius:var(--r-sm) var(--r-sm) 0 0;color:var(--muted);font-size:13px;font-weight:600;position:relative;top:1px}
.tab:hover{background:var(--surface-2);color:var(--ink)}
.tab[aria-pressed=true]{background:var(--surface);border-color:var(--border);color:var(--ink)}
.tab .dotp{width:7px;height:7px;border-radius:50%}.dotp.on{background:var(--good)}.dotp.off{background:var(--faint)}
.tab .cnt{background:var(--accent);color:#fff;border-radius:999px;font-size:10px;padding:0 6px;line-height:16px;min-width:16px;text-align:center}
.tab.nf{color:var(--crit)}

.panebox{border:1px solid var(--border);border-radius:var(--r-sm);padding:4px 0;margin-top:0}
.selrow{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border)}.selrow:last-child{border-bottom:0}
.selrow.lead{background:var(--surface-2)}
.selrow label{display:flex;align-items:center;gap:10px;flex:1;cursor:pointer;font-size:13px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px}
.pill.on{background:var(--good-wash);color:var(--good)}.pill.off{background:#F2F4F7;color:var(--muted)}.pill.sched{background:var(--accent-wash);color:var(--accent-ink)}
.to{color:var(--muted);font-size:12px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border);font-size:13px}
th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600}
.scroll-x{overflow-x:auto}
input[type=text],input[type=number],input[type=datetime-local],input[type=date],input[type=time],textarea,select{font-family:inherit;font-size:13px;line-height:1.4;color:var(--ink);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--r-sm);padding:8px 10px}
input[type=text],input[type=number],input[type=datetime-local],input[type=date],input[type=time],select{height:38px}
select{appearance:none;-webkit-appearance:none;padding-right:30px;cursor:pointer}
input:focus-visible,textarea:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.chk{width:15px;height:15px;accent-color:var(--accent);margin:0;flex:none}

.riskbar{display:flex;gap:8px;align-items:flex-start;background:var(--crit-wash);border:1px solid #FDA29B;border-radius:var(--r-sm);padding:10px 12px;color:var(--crit);font-size:13px;margin-top:14px}
.schedbox{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--accent-wash);border:1px dashed var(--accent);border-radius:var(--r-sm);padding:10px 12px;margin-top:14px}
.spread{display:flex;justify-content:space-between;align-items:center;gap:12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fld{margin-top:14px}.annpane{padding:14px}
.sublabel{font-size:11px;color:var(--muted);margin-bottom:4px}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:6px}
@media (max-width:760px){.grid3{grid-template-columns:1fr}}
.anntbl td{vertical-align:top}.anntbl tr.annoff{opacity:.42}
.empty{color:var(--faint);text-align:center;padding:26px 8px;font-size:13px}
.sumgrp{margin-top:6px}
.grphd{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;background:transparent;border:0;border-bottom:1px solid var(--border);padding:7px 0;font-weight:700;font-size:12px;color:var(--muted);cursor:pointer;text-align:left}
.grphd:hover{color:var(--ink)}
.sumitem{display:flex;gap:8px;align-items:center;padding:5px 0 5px 6px;border-bottom:1px dashed var(--border);font-size:12px}
.sumitem .d{width:7px;height:7px;border-radius:50%;flex:none;background:var(--accent)}

.rvhead{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.batchcard{border:1px solid var(--border);border-radius:var(--r);margin-top:14px;overflow:hidden}
.batchhd{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);cursor:pointer}
.batchhd .lbl{display:flex;align-items:center;gap:10px}
.batchhd .bn{background:var(--ink);color:#fff;border-radius:var(--r-sm);font-size:11px;font-weight:700;padding:2px 8px}
.batchbody{padding:6px 0}
.rvgrp{padding:6px 14px}.rvgrp h5{font-size:12px;margin:0 0 4px;color:var(--muted)}
.rvitem{display:flex;gap:10px;align-items:flex-start;padding:5px 0 5px 8px;font-size:13px;border-bottom:1px dashed var(--border)}.rvitem:last-child{border-bottom:0}
.rvitem .d{width:8px;height:8px;border-radius:50%;flex:none;margin-top:5px}
.d.ok{background:var(--good)}.d.sched{background:var(--accent)}.d.err{background:var(--crit)}.d.pend{background:var(--faint)}.d.skip{background:var(--faint)}
.barfoot{display:flex;justify-content:space-between;gap:8px;margin-top:18px}

/* diff card internals (module renderDiffCard emits bw-* classes) */
.bw-diff-card{padding:.4rem 0}
.bw-diff-title{font-weight:600;font-size:13px;margin-bottom:3px}
.bw-diff-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.bw-diff-arrow{color:var(--muted)}.bw-diff-target{font-weight:700;color:var(--accent-ink)}
.bw-diff-side{display:flex;flex-direction:column;gap:3px}
.bw-queue-line{display:flex;flex-direction:column}.bw-time-local{font-size:13px}.bw-time-utc{font-size:11px;color:var(--muted);font-family:var(--mono)}
.bw-queue-empty{font-size:12px;color:var(--muted)}.bw-noop-badge{font-size:11px;color:var(--muted);margin-top:4px}
.ledger-status{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap;margin-left:auto}
.ls-ok{background:var(--good-wash);color:var(--good)}.ls-skip{background:#F2F4F7;color:var(--muted)}.ls-err{background:var(--crit-wash);color:var(--crit)}.ls-sched{background:var(--accent-wash);color:var(--accent-ink)}
.ext-warning{margin-top:8px;font-size:12px;color:#b8281f;background:rgba(255,59,48,.1);padding:6px 10px;border-radius:6px}

@media (prefers-reduced-motion:no-preference){.functab,.btn,.chip,.tab{transition:.12s ease}}
@media (max-width:520px){.functab .s{display:none}.brandbar .foot{display:none}}
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
// WizardApp — duck-typed subset of ext-apps App
// ---------------------------------------------------------------------------
export interface WizardApp {
  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    isError?: boolean
    content?: Array<{ type: string; text: string }>
    structuredContent?: { items?: unknown[]; errors?: Array<{ code?: string; message?: string }> }
  }>
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function el(tag: string, cls?: string): HTMLElement { const e = document.createElement(tag); if (cls) e.className = cls; return e }
function txt(node: HTMLElement, s: unknown): void { renderText(node, s) }
function btn(label: string, cls: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.className = cls; txt(b, label); b.onclick = onclick; return b
}
function warnSvg(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('fill', 'none')
  const p1 = document.createElementNS(ns, 'path'); p1.setAttribute('d', 'M8 1.5 15 14H1L8 1.5Z'); p1.setAttribute('stroke', 'currentColor'); p1.setAttribute('stroke-width', '1.4'); p1.setAttribute('stroke-linejoin', 'round')
  const p2 = document.createElementNS(ns, 'path'); p2.setAttribute('d', 'M8 6v3.5M8 11.2v.3'); p2.setAttribute('stroke', 'currentColor'); p2.setAttribute('stroke-width', '1.4'); p2.setAttribute('stroke-linecap', 'round')
  svg.appendChild(p1); svg.appendChild(p2); return svg as SVGElement
}

// ---------------------------------------------------------------------------
// Loaded product data model (from app_get_batch_view / app_get_announcement_view)
// ---------------------------------------------------------------------------
interface PlanData {
  pkg_oid: string; name?: string; item_oid?: string; supplier_oid?: string; supplier_name?: string
  is_active?: boolean; is_bundle?: boolean
  current_platform?: string | null; inventory_mode?: string; current_quantity?: number | null
  reserve_queue?: ScheduleEntry[]
}
interface ProductData { prod_oid: string; name?: string; is_active?: boolean; not_found?: boolean; existing_count?: number | null; plans: PlanData[] }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function initWorkbench(app: WizardApp): void {
  injectStyles()

  const hostNav = document.getElementById('nav')!
  const statusEl = document.getElementById('status')!
  const workspaceEl = document.getElementById('workspace')!
  const fallbackEl = document.getElementById('fallback') as HTMLPreElement

  hostNav.hidden = true
  statusEl.hidden = true

  // ---- shell skeleton — 單欄、窄框友善（品牌條 → 功能頁籤 → 步驟條 → 內容）----
  const wrap = el('div', 'wrap')
  const panel = el('div', 'panel')
  const brandbar = el('div', 'brandbar')
  brandbar.appendChild(document.createTextNode('be2 工作台'))
  const brandSub = el('small'); txt(brandSub, '· 批次 · 排程 · 送審'); brandbar.appendChild(brandSub)
  const brandFoot = el('span', 'foot'); txt(brandFoot, '寫入一律人工批准'); brandbar.appendChild(brandFoot)
  const funcTabsEl = el('div', 'functabs')
  const mainEl = el('div', 'main')
  panel.appendChild(brandbar); panel.appendChild(funcTabsEl); panel.appendChild(mainEl)
  wrap.appendChild(panel)
  workspaceEl.textContent = ''
  workspaceEl.appendChild(wrap)

  function setStatus(s: string): void { statusEl.textContent = s }
  function showFallback(m: string): void { fallbackEl.hidden = false; fallbackEl.textContent = m }
  function clearFallback(): void { fallbackEl.hidden = true; fallbackEl.textContent = '' }

  // =====================================================================
  // State
  // =====================================================================
  const S = {
    func: 'shelf' as FuncKey,
    invMode: 'inventory_setting' as InvMode,
    step: 1,                       // 1 選擇 / 2 檢視 / 3 批准 / 4 結果
    products: [] as ProductData[],
    loadedProdOids: [] as string[],
    oidDraft: '',                  // 尚未載入的輸入框內容
    activeIdx: 0,
    // shelf
    shelfDir: 'up' as 'up' | 'down',
    shelfSelProduct: new Set<string>(),   // prod_oid
    shelfSelPlan: new Set<string>(),      // pkg_oid（含 bundle）
    shelfSched: false,
    shelfSchedAt: '',                     // datetime-local "YYYY-MM-DDTHH:MM"
    shelfSchedTz: 'Asia/Taipei',
    // inventory_setting: key `${item_oid}:${supplier_oid}` -> raw string
    invQty: new Map<string, string>(),
    // inventory_platform
    platSel: new Set<string>(),           // pkg_oid
    platTarget: 'BE2' as string,
    // announcement
    ann: {
      name: '', isEnabled: true,
      startDate: '', startTime: '00:00', startTz: 'Asia/Taipei',
      endDate: '', endTime: '00:00', endTz: 'Asia/Taipei',
      paste: '',
      langContents: new Map<string, string>(),
      selectedLangs: new Set<string>(),
    },
    // ui collapse
    summaryOpen: false,
    sideOpen: new Set<string>(),
    grpCollapsed: new Set<string>(),
    batchCollapsed: false,
    // chunk / server flow
    pendingChunks: [] as Array<{ action_type: ChunkActionType; items: Array<Record<string, unknown>> }>,
    chunkIndex: 0,
    accumResults: [] as Array<Record<string, unknown>>,
    changesetId: undefined as string | undefined,
    nonce: undefined as string | undefined,
    diffVersion: undefined as string | undefined,
    diffItems: [] as Array<Record<string, unknown>>,
    currentChunkActionType: '' as ChunkActionType | '',
    lastTz: 'Asia/Taipei',
  }

  // item_key → 「商品名 · 方案名」（結果頁把純數字 key 顯示成人看得懂）
  let resultNameByKey = new Map<string, string>()

  const funcDesc = (): FuncDesc => FUNCS.find(f => f.key === S.func)!
  const dirActive = (): boolean => S.shelfDir === 'up'
  const dirLabel = (): string => (S.shelfDir === 'up' ? '上架' : '下架')

  function resetEdits(): void {
    S.shelfSelProduct = new Set(); S.shelfSelPlan = new Set()
    S.shelfSched = false; S.shelfSchedAt = ''
    S.invQty = new Map(); S.platSel = new Set(); S.platTarget = 'BE2'
    S.sideOpen = new Set(); S.grpCollapsed = new Set(); S.batchCollapsed = false
  }
  function resetAnn(): void {
    S.ann = {
      name: '', isEnabled: true,
      startDate: '', startTime: '00:00', startTz: 'Asia/Taipei',
      endDate: '', endTime: '00:00', endTz: 'Asia/Taipei',
      paste: '', langContents: new Map(), selectedLangs: new Set(),
    }
  }
  function resetServerFlow(): void {
    S.pendingChunks = []; S.chunkIndex = 0; S.accumResults = []
    S.changesetId = undefined; S.nonce = undefined; S.diffVersion = undefined
    S.diffItems = []; S.currentChunkActionType = ''
  }

  // =====================================================================
  // 本次變更（live summary）— 顯示用，實際 items 於 doNext 才由 module buildItems 產生
  // =====================================================================
  interface Change { grp: string; label: string; sched?: boolean }
  function changesList(): Change[] {
    const out: Change[] = []
    if (S.products.length === 0) return out
    if (S.func === 'shelf') {
      if (S.shelfSched) {
        const when = S.shelfSchedAt ? S.shelfSchedAt.replace('T', ' ') : '（未設時間）'
        for (const p of S.products) {
          for (const pl of p.plans) {
            if (pl.is_bundle) continue
            if (S.shelfSelPlan.has(pl.pkg_oid)) out.push({ grp: p.name ?? p.prod_oid, label: `${pl.name ?? pl.pkg_oid} → 排程 ${dirLabel()} @ ${when}`, sched: true })
          }
        }
      } else {
        for (const p of S.products) {
          if (S.shelfSelProduct.has(p.prod_oid)) out.push({ grp: p.name ?? p.prod_oid, label: `整個商品 → ${dirLabel()}` })
          for (const pl of p.plans) {
            if (S.shelfSelPlan.has(pl.pkg_oid)) out.push({ grp: p.name ?? p.prod_oid, label: `${pl.name ?? pl.pkg_oid}${pl.is_bundle ? '（組合方案）' : ''} → ${dirLabel()}` })
          }
        }
      }
    } else if (S.func === 'inventory' && S.invMode === 'inventory_setting') {
      for (const p of S.products) {
        for (const pl of p.plans) {
          if (!pl.item_oid || !pl.supplier_oid) continue
          const raw = S.invQty.get(`${pl.item_oid}:${pl.supplier_oid}`)
          if (raw != null && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
            const cur = pl.current_quantity != null ? String(pl.current_quantity) : '未設'
            out.push({ grp: p.name ?? p.prod_oid, label: `${pl.name ?? pl.pkg_oid} 庫存 → ${raw.trim()}（原 ${cur}）` })
          }
        }
      }
    } else if (S.func === 'inventory' && S.invMode === 'inventory_platform') {
      const seen = new Set<string>()
      for (const p of S.products) {
        for (const pl of p.plans) {
          if (!S.platSel.has(pl.pkg_oid) || !pl.item_oid || !pl.supplier_oid) continue
          const k = `${pl.item_oid}:${pl.supplier_oid}`
          if (seen.has(k)) continue
          seen.add(k)
          out.push({ grp: p.name ?? p.prod_oid, label: `${pl.name ?? pl.pkg_oid} 平台 → ${platformLabel(S.platTarget)}` })
        }
      }
    } else if (S.func === 'announce') {
      if (annValid()) {
        out.push({ grp: `公告：${S.ann.name || '未命名'}`, label: `${S.loadedProdOids.length} 個商品 · ${annSelectedCodes().length} 語系 · ${S.ann.isEnabled ? '啟用' : '停用'}` })
      }
    }
    return out
  }
  function changesCount(): number { return changesList().length }
  function groupBy(arr: Change[]): Map<string, string[]> {
    const g = new Map<string, string[]>()
    for (const c of arr) { const a = g.get(c.grp) ?? []; a.push(c.label); g.set(c.grp, a) }
    return g
  }

  function annSelectedCodes(): string[] {
    return ANN_LOCALES.filter(l => S.ann.selectedLangs.has(l.code) && (S.ann.langContents.get(l.code) ?? '').trim()).map(l => l.code)
  }
  function annValid(): boolean {
    const a = S.ann
    return S.loadedProdOids.length > 0 && a.name.trim() !== '' && a.startDate !== '' && annSelectedCodes().length > 0
  }

  // =====================================================================
  // Render root
  // =====================================================================
  function render(): void {
    clampIdx()
    renderFuncTabs()
    mainEl.textContent = ''
    mainEl.appendChild(renderSteprail())
    // 錯誤 banner 常駐在步驟條之下、內容之上
    fallbackEl.remove()
    fallbackEl.style.margin = '12px 18px 0'
    mainEl.appendChild(fallbackEl)
    if (S.step === 1) mainEl.appendChild(renderSelect())
    else if (S.step === 2) mainEl.appendChild(renderReview())
    else if (S.step === 3) mainEl.appendChild(renderApprove())
    else mainEl.appendChild(renderResult())
  }
  function clampIdx(): void { if (S.activeIdx >= S.products.length) S.activeIdx = Math.max(0, S.products.length - 1) }

  // 功能列 → 頂部橫向頁籤（warm 橘 active）
  function renderFuncTabs(): void {
    funcTabsEl.textContent = ''
    for (const f of FUNCS) {
      const b = el('button', 'functab') as HTMLButtonElement
      b.setAttribute('aria-pressed', String(S.func === f.key))
      if (S.step > 1) b.disabled = true
      const t = el('span', 't'); txt(t, f.label)
      const s = el('span', 's'); txt(s, f.sub)
      b.appendChild(t); b.appendChild(s)
      b.onclick = () => {
        if (S.step > 1) return
        S.func = f.key; S.activeIdx = 0
        S.products = []; S.loadedProdOids = []; S.oidDraft = ''
        S.shelfDir = 'up'; S.invMode = 'inventory_setting'
        resetEdits(); resetAnn(); clearFallback()
        render()
      }
      funcTabsEl.appendChild(b)
    }
  }

  function renderSteprail(): HTMLElement {
    const rail = el('div', 'steprail')
    const n = changesCount()
    STEP_LABELS.forEach((label, i) => {
      const idx = i + 1
      const b = el('button', 'st') as HTMLButtonElement
      if (idx === S.step) b.classList.add('on')
      else if (idx < S.step) b.classList.add('done')
      // 可回退：已完成步驟可點；選擇頁有變更時「檢視」可點前進
      const canBack = idx < S.step
      const canFwdView = idx === 2 && S.step === 1 && n > 0
      if (canBack || canFwdView) { b.classList.add('clk'); b.onclick = () => railGoto(idx) }
      const circle = el('span', 'n'); txt(circle, idx < S.step ? '✓' : String(idx)); b.appendChild(circle)
      const lab = el('span'); txt(lab, label); b.appendChild(lab)
      if (idx === 2 && n > 0 && S.step === 1) { const c = el('span', 'oid'); txt(c, `(${n})`); b.appendChild(c) }
      rail.appendChild(b)
    })
    return rail
  }
  function railGoto(idx: number): void {
    if (idx === S.step) return
    if (idx > S.step) { if (idx === 2 && S.step === 1) void doNext(); return }
    // going back
    if (S.step === 4) { startNew(); return }
    if (S.step === 2 || S.step === 3) {
      // 有開啟的 change-set → 回選擇需先 reject（維持 draft-only 不變式）
      if (idx === 1) { rejectOpen(); S.step = 1; clearFallback(); render(); return }
      if (idx === 2 && S.step === 3) { S.step = 2; render(); return }
    }
  }

  // =====================================================================
  // STEP 1 — 選擇（兩欄）
  // =====================================================================
  function renderSelect(): HTMLElement {
    const container = el('div')
    container.appendChild(renderSummaryBar())   // 頂部 compact 小計
    container.appendChild(renderWork())         // 單欄內容
    return container
  }

  function renderWork(): HTMLElement {
    const f = funcDesc()
    const work = el('div', 'work')
    const eyebrow = el('div', 'eyebrow'); txt(eyebrow, `${f.sub} · 支援批次`); work.appendChild(eyebrow)
    const h = el('h2'); h.style.cssText = 'font-size:19px;margin-bottom:2px'; txt(h, f.label); work.appendChild(h)

    // 庫存子模式分段
    if (S.func === 'inventory') work.appendChild(renderInvModeToggle())

    // 商品載入
    const loaderWrap = el('div', 'mt12'); loaderWrap.appendChild(renderLoader()); work.appendChild(loaderWrap)

    if (S.products.length === 0) {
      const empty = el('div', 'empty'); txt(empty, `載入商品後，這裡會出現「${f.label}」的批次編輯內容`); work.appendChild(empty)
      return work
    }

    if (S.func === 'announce') { work.appendChild(renderAnnounceBlock()); return work }

    // 上下架方向分段
    if (S.func === 'shelf') work.appendChild(renderDirBar())

    // 多商品頁籤
    work.appendChild(renderTabs())

    // 主清單
    const oid = S.products[S.activeIdx]?.prod_oid
    const active = S.products.find(p => p.prod_oid === oid)
    if (active) {
      if (S.func === 'shelf') work.appendChild(renderShelfList(active))
      else if (S.invMode === 'inventory_setting') work.appendChild(renderInvSettingPane(active))
      else work.appendChild(renderInvPlatformPane(active))
    }

    // 排程（僅上下架）
    if (S.func === 'shelf') work.appendChild(renderSchedBox())

    // 高風險提示
    if (f.risk) {
      const rb = el('div', 'riskbar'); rb.appendChild(warnSvg())
      const d = el('div'); const b = el('b'); txt(b, '高風險：立即影響前台。'); d.appendChild(b); d.appendChild(document.createTextNode(f.risk))
      rb.appendChild(d); work.appendChild(rb)
    }
    // 底部主 CTA（窄框免捲回頂部）
    const foot = el('div', 'barfoot')
    foot.appendChild(el('span'))
    const n = changesCount()
    const next = btn(n > BATCH_CAP ? `檢視全部（${n} 筆 · ${Math.ceil(n / BATCH_CAP)} 批）→` : '檢視全部 →', 'btn primary', () => { void doNext() }) as HTMLButtonElement
    next.disabled = n === 0
    foot.appendChild(next)
    work.appendChild(foot)
    return work
  }

  function renderInvModeToggle(): HTMLElement {
    const bar = el('div', 'dirbar')
    const lbl = el('span', 'eyebrow'); txt(lbl, '庫存作業'); bar.appendChild(lbl)
    const seg = el('div', 'seg')
    const mk = (mode: InvMode, label: string): HTMLButtonElement => {
      const b = el('button') as HTMLButtonElement
      b.setAttribute('aria-pressed', String(S.invMode === mode)); txt(b, label)
      b.onclick = () => {
        if (S.invMode === mode) return
        S.invMode = mode; resetEdits(); clearFallback()
        if (S.loadedProdOids.length > 0) void doLoad(S.loadedProdOids)  // 換 action_type 重載現況
        else render()
      }
      return b
    }
    seg.appendChild(mk('inventory_setting', '逐日數量')); seg.appendChild(mk('inventory_platform', '平台切換'))
    bar.appendChild(seg)
    return bar
  }

  function renderLoader(): HTMLElement {
    const box = el('div', 'loader')
    const head = el('div', 'spread')
    const eb = el('div', 'eyebrow'); txt(eb, '批次載入商品（可多個）'); head.appendChild(eb)
    box.appendChild(head)
    const addrow = el('div', 'addrow')
    const input = el('input') as HTMLInputElement
    input.type = 'text'; input.placeholder = '輸入商品 oid，逗號或空白分隔…'; input.value = S.oidDraft
    input.oninput = () => { S.oidDraft = input.value }
    input.onkeydown = (e) => { if ((e as KeyboardEvent).key === 'Enter') { void doLoad(parseOidInput(input.value)) } }
    addrow.appendChild(input)
    addrow.appendChild(btn('載入', 'btn primary sm', () => { void doLoad(parseOidInput(input.value)) }))
    if (S.loadedProdOids.length > 0) addrow.appendChild(btn('清空', 'btn ghost sm', () => { S.products = []; S.loadedProdOids = []; S.oidDraft = ''; resetEdits(); render() }))
    box.appendChild(addrow)
    // chips
    const chips = el('div', 'chips')
    if (S.products.length === 0) {
      const m = el('span', 'muted'); m.style.fontSize = '12px'; txt(m, '尚未載入商品——先載入，下方才會出現可編輯內容。'); chips.appendChild(m)
    } else {
      for (const p of S.products) {
        const chip = el('span', 'chip')
        chip.appendChild(document.createTextNode(p.name ?? p.prod_oid))
        const oid = el('span', 'oid'); txt(oid, `#${p.prod_oid}`); chip.appendChild(oid)
        chips.appendChild(chip)
      }
    }
    box.appendChild(chips)
    return box
  }

  function renderTabs(): HTMLElement {
    const tabs = el('div', 'tabs'); tabs.setAttribute('role', 'tablist')
    S.products.forEach((p, i) => {
      const b = el('button', 'tab' + (p.not_found ? ' nf' : '')) as HTMLButtonElement
      b.setAttribute('role', 'tab'); b.setAttribute('aria-pressed', String(i === S.activeIdx))
      const dot = el('span', `dotp ${p.is_active ? 'on' : 'off'}`); b.appendChild(dot)
      b.appendChild(document.createTextNode(p.not_found ? '找不到商品' : (p.name ?? p.prod_oid)))
      const c = selCountForProduct(p)
      if (c > 0) { const cnt = el('span', 'cnt tnum'); txt(cnt, String(c)); b.appendChild(cnt) }
      b.onclick = () => { S.activeIdx = i; render() }
      tabs.appendChild(b)
    })
    return tabs
  }
  function selCountForProduct(p: ProductData): number {
    if (S.func === 'shelf') {
      if (S.shelfSched) return p.plans.filter(pl => !pl.is_bundle && S.shelfSelPlan.has(pl.pkg_oid)).length
      return (S.shelfSelProduct.has(p.prod_oid) ? 1 : 0) + p.plans.filter(pl => S.shelfSelPlan.has(pl.pkg_oid)).length
    }
    if (S.func === 'inventory' && S.invMode === 'inventory_setting') {
      return p.plans.filter(pl => pl.item_oid && pl.supplier_oid && (S.invQty.get(`${pl.item_oid}:${pl.supplier_oid}`) ?? '').trim() !== '').length
    }
    if (S.func === 'inventory' && S.invMode === 'inventory_platform') {
      return p.plans.filter(pl => S.platSel.has(pl.pkg_oid)).length
    }
    return 0
  }

  function renderDirBar(): HTMLElement {
    const bar = el('div', 'dirbar')
    const eb = el('span', 'eyebrow'); txt(eb, '這批動作（強制單一方向）'); bar.appendChild(eb)
    const seg = el('div', 'seg')
    const up = el('button') as HTMLButtonElement; up.setAttribute('aria-pressed', String(dirActive())); txt(up, '全部上架')
    const down = el('button') as HTMLButtonElement; down.setAttribute('aria-pressed', String(!dirActive())); txt(down, '全部下架')
    up.onclick = () => { if (S.shelfDir !== 'up') { S.shelfDir = 'up'; S.shelfSelProduct = new Set(); S.shelfSelPlan = new Set(); render() } }
    down.onclick = () => { if (S.shelfDir !== 'down') { S.shelfDir = 'down'; S.shelfSelProduct = new Set(); S.shelfSelPlan = new Set(); render() } }
    seg.appendChild(up); seg.appendChild(down); bar.appendChild(seg)
    const note = el('span', 'muted'); note.style.fontSize = '12px'; txt(note, '一次操作不得同時含上架與下架；另一方向請另開一批。'); bar.appendChild(note)
    return bar
  }

  // 上下架整合清單：整個商品列 + 各方案列同框
  function renderShelfList(p: ProductData): HTMLElement {
    const box = el('div', 'panebox')
    if (p.not_found) { const m = el('div', 'empty'); txt(m, '查無此商品，請確認 prod_oid'); box.appendChild(m); return box }
    const targetActive = dirActive()

    // 整個商品列
    const lead = el('div', 'selrow lead')
    if (S.shelfSched) {
      // 排程模式：無商品層排程 → 灰掉
      const lab = el('label'); lab.style.opacity = '.5'
      const cb = el('input') as HTMLInputElement; cb.type = 'checkbox'; cb.className = 'chk'; cb.disabled = true
      const span = el('span'); const b = el('b'); txt(b, '整個商品'); span.appendChild(b); span.appendChild(document.createTextNode(` — ${p.name ?? p.prod_oid} `))
      const oid = el('span', 'oid'); txt(oid, `#${p.prod_oid}`); span.appendChild(oid)
      lab.appendChild(cb); lab.appendChild(span); lead.appendChild(lab)
      const hint = el('span', 'to'); txt(hint, 'be2 無商品層排程'); lead.appendChild(hint)
    } else {
      const eligible = p.is_active !== targetActive
      const lab = el('label'); if (!eligible) lab.style.opacity = '.5'
      const cb = el('input') as HTMLInputElement; cb.type = 'checkbox'; cb.className = 'chk'
      cb.checked = S.shelfSelProduct.has(p.prod_oid); cb.disabled = !eligible
      cb.onchange = () => { if (cb.checked) S.shelfSelProduct.add(p.prod_oid); else S.shelfSelProduct.delete(p.prod_oid); render() }
      const span = el('span'); const b = el('b'); txt(b, '整個商品'); span.appendChild(b); span.appendChild(document.createTextNode(` — ${p.name ?? p.prod_oid} `))
      const oid = el('span', 'oid'); txt(oid, `#${p.prod_oid}`); span.appendChild(oid)
      lab.appendChild(cb); lab.appendChild(span); lead.appendChild(lab)
      if (eligible) { const to = el('span', 'to'); const bb = el('b'); txt(bb, dirLabel()); to.appendChild(document.createTextNode('→ 切為 ')); to.appendChild(bb); lead.appendChild(to) }
      else { const pill = el('span', `pill ${p.is_active ? 'on' : 'off'}`); txt(pill, `已是${p.is_active ? '上架' : '下架'}`); lead.appendChild(pill) }
    }
    box.appendChild(lead)

    // 方案列
    for (const pl of p.plans) {
      const rowEl = el('div', 'selrow')
      const isBundle = pl.is_bundle === true
      let eligible: boolean; let disabled: boolean
      if (S.shelfSched) { eligible = !isBundle; disabled = isBundle }         // 排程：組合方案不可
      else { eligible = pl.is_active !== targetActive; disabled = !eligible } // 立即：現況異於方向才可
      const lab = el('label'); if (disabled) lab.style.opacity = '.5'
      const cb = el('input') as HTMLInputElement; cb.type = 'checkbox'; cb.className = 'chk'
      cb.checked = S.shelfSelPlan.has(pl.pkg_oid); cb.disabled = disabled
      cb.onchange = () => { if (cb.checked) S.shelfSelPlan.add(pl.pkg_oid); else S.shelfSelPlan.delete(pl.pkg_oid); render() }
      const span = el('span'); span.appendChild(document.createTextNode((pl.name ?? pl.pkg_oid) + ' '))
      if (isBundle) { const tag = el('span', 'oid'); txt(tag, '· 組合方案'); span.appendChild(tag) }
      const oid = el('span', 'oid'); txt(oid, ` 方案 #${pl.pkg_oid}`); span.appendChild(oid)
      lab.appendChild(cb); lab.appendChild(span); rowEl.appendChild(lab)
      if (S.shelfSched && isBundle) { const pill = el('span', 'pill off'); txt(pill, '不支援排程'); rowEl.appendChild(pill) }
      else if (eligible) { const to = el('span', 'to'); const bb = el('b'); txt(bb, dirLabel()); to.appendChild(document.createTextNode(S.shelfSched ? '→ 排程 ' : '→ 切為 ')); to.appendChild(bb); rowEl.appendChild(to) }
      else { const pill = el('span', `pill ${pl.is_active ? 'on' : 'off'}`); txt(pill, `已是${pl.is_active ? '上架' : '下架'}`); rowEl.appendChild(pill) }
      box.appendChild(rowEl)
    }
    return box
  }

  function renderSchedBox(): HTMLElement {
    const box = el('div', 'schedbox')
    const lab = el('label', 'row')
    const cb = el('input') as HTMLInputElement; cb.type = 'checkbox'; cb.className = 'chk'; cb.checked = S.shelfSched
    cb.onchange = () => { S.shelfSched = cb.checked; S.shelfSelProduct = new Set(); S.shelfSelPlan = new Set(); render() }
    const b = el('b'); txt(b, '排程')
    lab.appendChild(cb); lab.appendChild(b); lab.appendChild(document.createTextNode('（不立即執行，到點自動送出）')); box.appendChild(lab)
    const dt = el('input') as HTMLInputElement; dt.type = 'datetime-local'; dt.value = S.shelfSchedAt; dt.disabled = !S.shelfSched
    if (!S.shelfSched) dt.style.opacity = '.5'
    dt.onchange = () => { S.shelfSchedAt = dt.value }
    box.appendChild(dt)
    const tz = el('select') as HTMLSelectElement; tz.disabled = !S.shelfSched
    for (const z of Object.keys(TZ_OFFSET_HOURS)) { const o = el('option') as HTMLOptionElement; o.value = z; txt(o, z); if (z === S.shelfSchedTz) o.selected = true; tz.appendChild(o) }
    tz.onchange = () => { S.shelfSchedTz = tz.value }
    box.appendChild(tz)
    const note = el('span', 'muted'); note.style.fontSize = '12px'; txt(note, S.shelfSched ? '僅一般方案可排程；商品/組合方案不排程' : '留白＝立即執行')
    box.appendChild(note)
    return box
  }

  // 庫存逐日數量
  function renderInvSettingPane(p: ProductData): HTMLElement {
    const box = el('div', 'panebox'); box.style.padding = '4px 0'
    if (p.not_found) { const m = el('div', 'empty'); txt(m, '查無此商品'); box.appendChild(m); return box }
    for (const pl of p.plans) {
      const rowEl = el('div', 'selrow')
      const span = el('span'); span.style.flex = '1'
      span.appendChild(document.createTextNode((pl.name ?? pl.pkg_oid) + ' '))
      const oid = el('span', 'oid'); txt(oid, pl.supplier_name ? `· ${pl.supplier_name}` : `方案 #${pl.pkg_oid}`); span.appendChild(oid)
      rowEl.appendChild(span)
      const supported = pl.inventory_mode === 'item_by_amount' && pl.item_oid && pl.supplier_oid
      if (!supported) {
        const pill = el('span', 'pill off'); txt(pill, pl.item_oid ? '僅支援套餐總量模式' : '無供應商'); rowEl.appendChild(pill)
      } else {
        const key = `${pl.item_oid}:${pl.supplier_oid}`
        const cur = el('span', 'muted'); cur.style.fontSize = '12px'; txt(cur, `現有 ${pl.current_quantity != null ? pl.current_quantity : '未設'} →`); rowEl.appendChild(cur)
        const input = el('input') as HTMLInputElement
        input.type = 'number'; input.min = '0'; input.step = '1'; input.className = 'tnum'; input.style.width = '80px'
        input.value = S.invQty.get(key) ?? ''; input.placeholder = '—'
        input.oninput = () => { S.invQty.set(key, input.value) }
        input.onchange = () => { S.invQty.set(key, input.value); render() }
        rowEl.appendChild(input)
      }
      box.appendChild(rowEl)
    }
    return box
  }

  // 庫存平台切換
  function renderInvPlatformPane(p: ProductData): HTMLElement {
    const wrap = el('div')
    // 目標平台
    const bar = el('div', 'dirbar')
    const eb = el('span', 'eyebrow'); txt(eb, '目標平台'); bar.appendChild(eb)
    const sel = el('select') as HTMLSelectElement
    for (const t of ['BE2', 'BE2_SCM', 'EXTERNAL']) { const o = el('option') as HTMLOptionElement; o.value = t; txt(o, platformLabel(t)); if (t === S.platTarget) o.selected = true; sel.appendChild(o) }
    sel.onchange = () => { S.platTarget = sel.value; render() }
    bar.appendChild(sel)
    wrap.appendChild(bar)
    if (S.platTarget === 'EXTERNAL') { const w = el('div', 'ext-warning'); txt(w, '串接外部庫存（B2D/B2S/rezio 等）開啟前請先與 IT 確認'); wrap.appendChild(w) }

    const box = el('div', 'panebox')
    if (p.not_found) { const m = el('div', 'empty'); txt(m, '查無此商品'); box.appendChild(m); wrap.appendChild(box); return wrap }
    for (const pl of p.plans) {
      const rowEl = el('div', 'selrow')
      const supported = !!(pl.item_oid && pl.supplier_oid)
      const lab = el('label'); if (!supported) lab.style.opacity = '.5'
      const cb = el('input') as HTMLInputElement; cb.type = 'checkbox'; cb.className = 'chk'
      cb.checked = S.platSel.has(pl.pkg_oid); cb.disabled = !supported
      cb.onchange = () => { syncPlatformSiblings(pl, cb.checked); render() }
      const span = el('span'); span.appendChild(document.createTextNode((pl.name ?? pl.pkg_oid) + ' '))
      const oid = el('span', 'oid'); txt(oid, pl.supplier_name ? `· ${pl.supplier_name}` : `方案 #${pl.pkg_oid}`); span.appendChild(oid)
      lab.appendChild(cb); lab.appendChild(span); rowEl.appendChild(lab)
      const cur = el('span', 'row')
      const dot = el('span'); dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${pl.current_platform ? 'var(--good)' : 'var(--faint)'}`
      cur.appendChild(dot)
      const cs = el('span', 'muted'); cs.style.fontSize = '12px'; txt(cs, platformLabel(pl.current_platform)); cur.appendChild(cs)
      rowEl.appendChild(cur)
      box.appendChild(rowEl)
    }
    wrap.appendChild(box)
    return wrap
  }
  function syncPlatformSiblings(changed: PlanData, on: boolean): void {
    if (!changed.item_oid || !changed.supplier_oid) return
    for (const p of S.products) {
      for (const pl of p.plans) {
        if (pl.item_oid === changed.item_oid && pl.supplier_oid === changed.supplier_oid) {
          if (on) S.platSel.add(pl.pkg_oid); else S.platSel.delete(pl.pkg_oid)
        }
      }
    }
  }

  // 公告表單
  function renderAnnounceBlock(): HTMLElement {
    const a = S.ann
    const pane = el('div', 'panebox annpane'); pane.style.marginTop = '16px'

    // 內部名稱
    const f1 = el('div', 'fld'); const e1 = el('div', 'eyebrow'); txt(e1, '公告標題（≤254）'); f1.appendChild(e1)
    const nameInput = el('input') as HTMLInputElement; nameInput.type = 'text'; nameInput.value = a.name; nameInput.style.cssText = 'width:100%;margin-top:6px'; nameInput.placeholder = '僅供內部識別'
    nameInput.oninput = () => { a.name = nameInput.value }; nameInput.onchange = () => { render() }
    f1.appendChild(nameInput); pane.appendChild(f1)

    // 啟用
    const f2 = el('div', 'fld'); const e2 = el('div', 'eyebrow'); txt(e2, '啟用'); f2.appendChild(e2)
    const enLab = el('label', 'row'); enLab.style.marginTop = '6px'
    const en = el('input') as HTMLInputElement; en.type = 'checkbox'; en.className = 'chk'; en.checked = a.isEnabled
    en.onchange = () => { a.isEnabled = en.checked }
    const enTxt = el('span', 'muted'); enTxt.style.fontSize = '13px'; txt(enTxt, '建立後立即啟用；取消＝建為停用')
    enLab.appendChild(en); enLab.appendChild(enTxt); f2.appendChild(enLab); pane.appendChild(f2)

    // 顯示期間
    const f3 = el('div', 'fld'); const e3 = el('div', 'eyebrow'); txt(e3, '顯示期間'); f3.appendChild(e3)
    const grid = el('div', 'grid3')
    const startCell = el('div'); const sl = el('div', 'sublabel'); txt(sl, '開始'); startCell.appendChild(sl)
    const sRow = el('div', 'row')
    const sDate = el('input') as HTMLInputElement; sDate.type = 'date'; sDate.value = a.startDate; sDate.oninput = () => { a.startDate = sDate.value }; sDate.onchange = () => render()
    const sTime = el('input') as HTMLInputElement; sTime.type = 'time'; sTime.value = a.startTime; sTime.oninput = () => { a.startTime = sTime.value }
    sRow.appendChild(sDate); sRow.appendChild(sTime); startCell.appendChild(sRow)
    const endCell = el('div'); const elb = el('div', 'sublabel'); txt(elb, '結束（選填）'); endCell.appendChild(elb)
    const eRow = el('div', 'row')
    const eDate = el('input') as HTMLInputElement; eDate.type = 'date'; eDate.value = a.endDate; eDate.oninput = () => { a.endDate = eDate.value }
    const eTime = el('input') as HTMLInputElement; eTime.type = 'time'; eTime.value = a.endTime; eTime.oninput = () => { a.endTime = eTime.value }
    eRow.appendChild(eDate); eRow.appendChild(eTime); endCell.appendChild(eRow)
    const tzCell = el('div'); const tl = el('div', 'sublabel'); txt(tl, '時區'); tzCell.appendChild(tl)
    const tz = el('select') as HTMLSelectElement
    for (const z of Object.keys(TZ_OFFSET_HOURS)) { const o = el('option') as HTMLOptionElement; o.value = z; txt(o, z); if (z === a.startTz) o.selected = true; tz.appendChild(o) }
    tz.onchange = () => { a.startTz = tz.value; a.endTz = tz.value }
    tzCell.appendChild(tz)
    grid.appendChild(startCell); grid.appendChild(endCell); grid.appendChild(tzCell); f3.appendChild(grid); pane.appendChild(f3)

    // 內容貼上
    const f4 = el('div', 'fld'); const e4 = el('div', 'eyebrow'); txt(e4, '公告內容'); f4.appendChild(e4)
    const hint = el('div', 'muted'); hint.style.cssText = 'font-size:12px;margin:4px 0'
    txt(hint, '先在你自己的 Claude 用 kkday-announcement-translate skill 翻譯，把整段回覆（含 ```json 區塊）貼進來。')
    f4.appendChild(hint)
    const ta = el('textarea') as HTMLTextAreaElement; ta.rows = 3; ta.style.width = '100%'; ta.placeholder = '把 Claude 的回覆貼在這裡'; ta.value = a.paste
    ta.oninput = () => { a.paste = ta.value }
    f4.appendChild(ta)
    const btnRow = el('div', 'row'); btnRow.style.marginTop = '8px'
    btnRow.appendChild(btn('以新貼上的內容取代', 'btn sm', () => {
      const result = ingestAnnouncement(a.paste)
      if (!result) { showFallback('內容格式不符：需含 kkday-announcement-translate skill 的 ```json 區塊（type=be2-announcement-content + langs[]）'); return }
      clearFallback()
      a.langContents = new Map(); a.selectedLangs = new Set()
      for (const l of result.langs) { a.langContents.set(l.langCode, l.content); a.selectedLangs.add(l.langCode) }
      render()
    }))
    const hasContent = a.langContents.size > 0
    if (hasContent) btnRow.appendChild(btn('清除內容', 'btn ghost sm', () => { a.langContents = new Map(); a.selectedLangs = new Set(); a.paste = ''; render() }))
    f4.appendChild(btnRow)

    // 15 語系表
    if (hasContent) {
      const sx = el('div', 'scroll-x'); sx.style.marginTop = '12px'
      const table = el('table', 'anntbl')
      const thead = el('thead'); const htr = el('tr')
      for (const [w, t] of [['30px', ''], ['', '語系'], ['', '內容（純文字）']] as Array<[string, string]>) { const th = el('th'); if (w) th.style.width = w; txt(th, t); htr.appendChild(th) }
      thead.appendChild(htr); table.appendChild(thead)
      const tbody = el('tbody')
      for (const loc of ANN_LOCALES) {
        const c = a.langContents.get(loc.code) ?? ''
        const on = a.selectedLangs.has(loc.code)
        const tr = el('tr', on ? '' : 'annoff')
        const td0 = el('td')
        const cb = el('input') as HTMLInputElement; cb.type = 'checkbox'; cb.className = 'chk'; cb.checked = on; cb.disabled = c === ''
        cb.onchange = () => { if (cb.checked) a.selectedLangs.add(loc.code); else a.selectedLangs.delete(loc.code); render() }
        td0.appendChild(cb); tr.appendChild(td0)
        const td1 = el('td'); const code = el('div', 'mono'); code.style.fontSize = '12px'; txt(code, loc.code); const nm = el('div', 'muted'); nm.style.fontSize = '12px'; txt(nm, loc.name); td1.appendChild(code); td1.appendChild(nm); tr.appendChild(td1)
        const td2 = el('td'); td2.style.cssText = 'font-size:12px;line-height:1.55'; if (c) txt(td2, c); else { const m = el('span', 'muted'); txt(m, '（無內容）'); td2.appendChild(m) }
        tr.appendChild(td2)
        tbody.appendChild(tr)
      }
      table.appendChild(tbody); sx.appendChild(table); f4.appendChild(sx)
      const note = el('div', 'muted mt8'); note.style.fontSize = '12px'; txt(note, `已選 ${annSelectedCodes().length} 語系；送出時做 lang_code→langCode 對映。`); f4.appendChild(note)
    }
    pane.appendChild(f4)

    const applied = el('div', 'muted mt8'); applied.style.fontSize = '12px'; txt(applied, `公告套用到已載入的 ${S.loadedProdOids.length} 個商品（prod_oids 陣列一次送）。`)
    pane.appendChild(applied)
    return pane
  }

  // 頂部 compact 小計：一行「本次變更 N 筆 · 檢視全部 →」，可展開看依商品分組清單
  function renderSummaryBar(): HTMLElement {
    const ch = changesList()
    const bar = el('div', 'summarybar')
    const open = S.summaryOpen && ch.length > 0
    const hd = el('button', 'summaryhd')
    const car = el('span', 'car'); txt(car, ch.length > 0 ? (open ? '▾' : '▸') : ''); hd.appendChild(car)
    const label = el('span')
    label.appendChild(document.createTextNode('本次變更 '))
    const cnt = el('span', 'cntbig tnum'); txt(cnt, String(ch.length)); label.appendChild(cnt)
    label.appendChild(document.createTextNode(' 筆'))
    if (ch.length > BATCH_CAP) { const s = el('span', 'muted'); s.style.fontSize = '12px'; txt(s, ` · 將拆 ${Math.ceil(ch.length / BATCH_CAP)} 批`); label.appendChild(s) }
    hd.appendChild(label)
    const go = el('button', 'go') as HTMLButtonElement
    txt(go, '檢視全部 →'); go.disabled = ch.length === 0
    go.onclick = (e) => { e.stopPropagation(); void doNext() }
    hd.appendChild(go)
    hd.onclick = () => { if (ch.length === 0) return; S.summaryOpen = !S.summaryOpen; render() }
    bar.appendChild(hd)
    if (open) {
      const body = el('div', 'summarybody')
      for (const [g, arr] of groupBy(ch)) {
        const grp = el('div', 'sumgrp')
        const gopen = S.sideOpen.has(g)
        const ghd = el('button', 'grphd')
        const left = el('span'); left.appendChild(document.createTextNode(g + ' ')); const gc = el('span', 'oid'); txt(gc, `· ${arr.length} 筆`); left.appendChild(gc)
        const gcar = el('span'); txt(gcar, gopen ? '▾' : '▸')
        ghd.appendChild(left); ghd.appendChild(gcar)
        ghd.onclick = () => { if (gopen) S.sideOpen.delete(g); else S.sideOpen.add(g); render() }
        grp.appendChild(ghd)
        if (gopen) for (const l of arr) { const it = el('div', 'sumitem'); const d = el('span', 'd'); it.appendChild(d); it.appendChild(document.createTextNode(l)); grp.appendChild(it) }
        body.appendChild(grp)
      }
      bar.appendChild(body)
    }
    return bar
  }

  // =====================================================================
  // 建立變更 → 拆批 → stageChunk
  // =====================================================================
  async function doNext(): Promise<void> {
    if (S.products.length === 0) { showFallback('請先載入商品'); return }
    let chunks: Array<{ action_type: ChunkActionType; items: Array<Record<string, unknown>> }> = []

    if (S.func === 'announce') {
      const built = buildAnnouncementChunk()
      if (!built) return
      chunks = [built]
    } else if (S.func === 'shelf') {
      chunks = buildShelfChunks()
      if (chunks === null as unknown as typeof chunks) return
    } else if (S.invMode === 'inventory_setting') {
      const items = inventorySettingWizard.buildItems(inventoryRowInputs(), {}) as Array<Record<string, unknown>>
      chunks = buildActionChunks(items, 'inventory_setting', BATCH_CAP) as typeof chunks
    } else {
      const items = inventoryPlatformWizard.buildItems(platformRowInputs(), { target: S.platTarget }) as Array<Record<string, unknown>>
      chunks = buildActionChunks(items, 'inventory_platform', BATCH_CAP) as typeof chunks
    }

    const total = chunks.reduce((n, c) => n + c.items.length, 0)
    if (total === 0) { showFallback('請至少勾選一筆並填妥必要欄位'); return }

    S.pendingChunks = chunks; S.chunkIndex = 0; S.accumResults = []
    clearFallback()
    await stageChunk()
  }

  function buildShelfChunks(): Array<{ action_type: ChunkActionType; items: Array<Record<string, unknown>> }> {
    const target = dirActive() ? 'on' : 'off'
    if (S.shelfSched) {
      if (!S.shelfSchedAt) { showFallback('請先設定排程時間'); return [] }
      const [date, time] = S.shelfSchedAt.split('T')
      let utc: string
      try { utc = toUtcDateTime(date, time || '00:00', S.shelfSchedTz).slice(0, 19) } catch { showFallback('排程時間格式錯誤'); return [] }
      S.lastTz = S.shelfSchedTz
      const entry: ScheduleEntry = { reserve_date_utc: utc, reserve_status: dirActive() }
      const rows: WizardRowInput[] = []
      for (const p of S.products) {
        for (const pl of p.plans) {
          const checked = S.shelfSelPlan.has(pl.pkg_oid) && !pl.is_bundle
          rows.push({ checked, is_bundle: pl.is_bundle ?? false, prod_oid: p.prod_oid, pkg_oid: pl.pkg_oid, pkg_name: pl.name ?? pl.pkg_oid, item_oid: pl.item_oid, supplier_oid: pl.supplier_oid, queue: checked ? [entry] : [], cleared: false })
        }
      }
      const items = shelfScheduleWizard.buildItems(rows, { target }) as Array<Record<string, unknown>>
      return buildActionChunks(items, 'shelf_schedule', BATCH_CAP) as Array<{ action_type: ChunkActionType; items: Array<Record<string, unknown>> }>
    }
    // 立即：整個商品 / 一般方案 / 組合方案 三路
    const prodRows: WizardRowInput[] = []
    const planRows: WizardRowInput[] = []
    for (const p of S.products) {
      prodRows.push({ checked: S.shelfSelProduct.has(p.prod_oid), is_bundle: false, prod_oid: p.prod_oid, pkg_oid: '', pkg_name: p.name ?? p.prod_oid, queue: [], cleared: false })
      for (const pl of p.plans) {
        planRows.push({ checked: S.shelfSelPlan.has(pl.pkg_oid), is_bundle: pl.is_bundle ?? false, prod_oid: p.prod_oid, pkg_oid: pl.pkg_oid, pkg_name: pl.name ?? pl.pkg_oid, item_oid: pl.item_oid, supplier_oid: pl.supplier_oid, queue: [], cleared: false })
      }
    }
    const productItems = shelfToggleProductWizard.buildItems(prodRows, { target }) as Array<Record<string, unknown>>
    const planItems = shelfTogglePlanWizard.buildItems(planRows, { target }) as Array<Record<string, unknown>>
    const bundleItems = shelfToggleBundleWizard.buildItems(planRows, { target }) as Array<Record<string, unknown>>
    return [
      ...buildActionChunks(productItems, 'shelf_toggle_product', BATCH_CAP),
      ...buildActionChunks(planItems, 'shelf_toggle_plan', BATCH_CAP),
      ...buildActionChunks(bundleItems, 'shelf_toggle_bundle', BATCH_CAP),
    ] as Array<{ action_type: ChunkActionType; items: Array<Record<string, unknown>> }>
  }

  function inventoryRowInputs(): WizardRowInput[] {
    const rows: WizardRowInput[] = []
    for (const p of S.products) {
      for (const pl of p.plans) {
        if (!pl.item_oid || !pl.supplier_oid) continue
        const raw = S.invQty.get(`${pl.item_oid}:${pl.supplier_oid}`)
        const num = raw != null && raw.trim() !== '' ? Number(raw) : NaN
        const checked = pl.inventory_mode === 'item_by_amount' && !Number.isNaN(num)
        rows.push({ checked, is_bundle: false, prod_oid: p.prod_oid, pkg_oid: pl.pkg_oid, pkg_name: pl.name ?? pl.pkg_oid, item_oid: pl.item_oid, supplier_oid: pl.supplier_oid, queue: [], cleared: false, quantity: Number.isNaN(num) ? undefined : num })
      }
    }
    return rows
  }
  function platformRowInputs(): WizardRowInput[] {
    const rows: WizardRowInput[] = []
    for (const p of S.products) {
      for (const pl of p.plans) {
        rows.push({ checked: S.platSel.has(pl.pkg_oid), is_bundle: pl.is_bundle ?? false, prod_oid: p.prod_oid, pkg_oid: pl.pkg_oid, pkg_name: pl.name ?? pl.pkg_oid, item_oid: pl.item_oid, supplier_oid: pl.supplier_oid, queue: [], cleared: false })
      }
    }
    return rows
  }

  function buildAnnouncementChunk(): { action_type: ChunkActionType; items: Array<Record<string, unknown>> } | null {
    const a = S.ann
    if (!a.name.trim()) { showFallback('請填公告標題'); return null }
    if (!a.startDate) { showFallback('請選開始日期'); return null }
    let start_time: string
    try { start_time = toUtcDateTime(a.startDate, a.startTime || '00:00', a.startTz) } catch { showFallback('開始時間格式錯誤'); return null }
    let end_time: string | null = null
    if (a.endDate) { try { end_time = toUtcDateTime(a.endDate, a.endTime || '00:00', a.endTz) } catch { showFallback('結束時間格式錯誤'); return null } }
    const langs: string[] = []; const contents: Array<{ lang: string; content: string }> = []
    for (const loc of ANN_LOCALES) {
      if (a.selectedLangs.has(loc.code)) { const c = (a.langContents.get(loc.code) ?? '').trim(); if (c) { langs.push(loc.code); contents.push({ lang: loc.code, content: c }) } }
    }
    if (langs.length === 0) { showFallback('請至少選一個語系'); return null }
    const item: AnnouncementCreateItem = { prod_oids: S.loadedProdOids, name: a.name.trim(), is_enabled: a.isEnabled, start_time, end_time, langs, contents }
    return { action_type: 'announcement', items: [item as unknown as Record<string, unknown>] }
  }

  // =====================================================================
  // 載入商品
  // =====================================================================
  function loadActionType(): string {
    if (S.func === 'shelf') return 'shelf_toggle_product'   // 提供商品層 + 方案層 is_active + is_bundle
    if (S.func === 'inventory') return S.invMode
    return 'announcement'
  }

  async function doLoad(prodOids: string[]): Promise<void> {
    if (prodOids.length === 0) { showFallback('請輸入至少一個商品 oid'); return }
    setStatus('載入中…'); clearFallback()
    try {
      if (S.func === 'announce') { await doLoadAnnounce(prodOids); return }
      const r = await app.callServerTool({ name: 'app_get_batch_view', arguments: { action_type: loadActionType(), prod_oids: prodOids } })
      if (r.isError) { showFallback('載入失敗'); return }
      const sc = r.structuredContent as { items?: unknown[]; errors?: Array<{ code?: string; message?: string }> } | undefined
      const item0 = sc?.items?.[0] as { products?: unknown[] } | undefined
      const products = (item0?.products ?? []) as ProductData[]
      const nf = (sc?.errors ?? []).filter(e => e.code === 'PRODUCT_NOT_FOUND')
      if (nf.length > 0) showFallback(nf.map(e => e.message).join('\n'))
      else clearFallback()
      ingestProducts(products, prodOids)
      setStatus(`已載入 ${products.length} 個商品`)
      render()
    } catch (e) { showFallback('載入失敗：' + String(e)) }
  }

  async function doLoadAnnounce(prodOids: string[]): Promise<void> {
    const r = await app.callServerTool({ name: 'app_get_announcement_view', arguments: { prod_oids: prodOids } })
    if (r.isError) { showFallback('載入失敗'); return }
    const products = ((r.structuredContent?.items?.[0] as { products?: ProductData[] } | undefined)?.products ?? [])
    ingestProducts(products, prodOids)
    setStatus(`已載入 ${products.length} 個商品`)
    render()
  }

  function ingestProducts(products: ProductData[], prodOids: string[]): void {
    S.products = products
    S.loadedProdOids = products.filter(p => !p.not_found).map(p => String(p.prod_oid))
    if (S.func === 'announce') S.loadedProdOids = products.map(p => String(p.prod_oid))
    S.oidDraft = prodOids.join(', ')
    S.activeIdx = 0
    // 結果頁名稱查表
    resultNameByKey = new Map<string, string>()
    for (const p of products) {
      const pn = p.name ?? p.prod_oid
      resultNameByKey.set(String(p.prod_oid), pn)
      // 公告的 app_get_announcement_view 回的 product 沒有 plans 欄位（只有 prod_oid/name/existing_count），
      // 故 p.plans 可能是 undefined —— 加 ?? [] 防 "plans is not iterable"（e2e 揪出）。
      for (const pl of (p.plans ?? [])) {
        const label = `${pn} · ${pl.name ?? pl.pkg_oid}`
        resultNameByKey.set(`${p.prod_oid}:${pl.pkg_oid}`, label)
        if (pl.item_oid != null && pl.supplier_oid != null) resultNameByKey.set(`${pl.item_oid}:${pl.supplier_oid}`, label)
      }
    }
  }

  // =====================================================================
  // Chunk flow: create → view → (approve) → next
  // =====================================================================
  async function stageChunk(): Promise<void> {
    const chunk = S.pendingChunks[S.chunkIndex]
    if (!chunk) { showFallback('無可送出的變更'); return }
    S.currentChunkActionType = chunk.action_type
    clearFallback()
    setStatus(S.pendingChunks.length > 1 ? `建立第 ${S.chunkIndex + 1}/${S.pendingChunks.length} 批變更中…` : '建立變更中…')
    try {
      const createR = await app.callServerTool({ name: 'app_create_changeset', arguments: { action_type: chunk.action_type, items: chunk.items } })
      if (createR.isError) { showFallback(tryParseErrorText(createR) ? `建立變更失敗：${tryParseErrorText(createR)}` : '建立變更失敗'); return }
      const created = createR.structuredContent?.items?.[0] as { changeset_id?: string } | undefined
      // 建立失敗時 items 為空、真正原因在 errors[]（SCOPE_NOT_READ / INVALID_ITEMS / ACTION_NOT_ALLOWED…）；
      // 把它顯示出來，別再吞成通用「未取得 changeset_id」。
      if (!created?.changeset_id) { showFallback(tryParseErrorText(createR) ? `建立變更失敗：${tryParseErrorText(createR)}` : '建立變更失敗：未取得 changeset_id'); return }
      S.changesetId = created.changeset_id
      const ok = await loadView()
      if (!ok) return
      S.step = 2; render()
    } catch (e) { showFallback('建立變更失敗：' + String(e)) }
  }

  async function loadView(): Promise<boolean> {
    const r = await app.callServerTool({ name: 'app_get_changeset_view', arguments: { changeset_id: S.changesetId } })
    if (r.isError) { showFallback('讀取變更失敗'); return false }
    const rec = (r.structuredContent?.items?.[0] as Record<string, unknown> | undefined) ?? {}
    const diff = rec.diff as { items?: Array<Record<string, unknown>> } | undefined
    S.diffItems = diff?.items ?? []
    S.nonce = rec.nonce as string | undefined
    S.diffVersion = rec.diff_version as string | undefined
    return true
  }

  function rejectOpen(): void {
    if (S.changesetId && S.nonce && S.diffVersion) {
      app.callServerTool({ name: 'app_confirm_changeset', arguments: { changeset_id: S.changesetId, decision: 'reject', nonce: S.nonce, diff_version: S.diffVersion, confirmed_keys: [] } }).catch(() => {})
    }
    resetServerFlow()
  }

  // ---- diff card rendering (module renderDiffCard or announcement inline) ----
  function renderQueueLines(container: HTMLElement, queue: ScheduleEntry[], emptyLabel = '(空，將清除排程)'): void {
    if (queue.length === 0) { const p = el('div', 'bw-queue-empty'); txt(p, emptyLabel); container.appendChild(p); return }
    for (const e of queue) {
      const line = el('div', 'bw-queue-line')
      const { local, utc } = formatDualDisplay(e.reserve_date_utc, S.lastTz)
      const l = el('span', 'bw-time-local'); txt(l, `${local} ${e.reserve_status ? '上架' : '下架'}`); line.appendChild(l)
      if (utc) { const u = el('span', 'bw-time-utc'); txt(u, utc); line.appendChild(u) }
      container.appendChild(line)
    }
  }
  const domHelpers: DomHelpers = {
    el(tag: string, className?: string) { return el(tag, className) },
    text: txt,
    renderQueueLines: (container: HTMLElement, q: unknown[], emptyLabel?: string) => renderQueueLines(container, q as ScheduleEntry[], emptyLabel),
  }
  function renderDiffCard(d: Record<string, unknown>): HTMLElement {
    const wiz = WIZARDS[S.currentChunkActionType as ChunkActionType]
    if (wiz) return wiz.renderDiffCard(d, domHelpers)
    if (S.currentChunkActionType === 'announcement') {
      const card = el('div', 'bw-diff-card')
      const nm = el('div', 'bw-diff-title'); txt(nm, `公告：${d.name}`); card.appendChild(nm)
      const names = (d.product_names as string[] | undefined) ?? []
      const pr = el('div'); txt(pr, `商品：${names.length ? names.join('、') : ((d.prod_oids as string[]) ?? []).join('、')}`); card.appendChild(pr)
      const tm = el('div'); txt(tm, `生效：${d.start_time}${d.end_time ? ' ~ ' + d.end_time : ''}（UTC）`); card.appendChild(tm)
      const lg = el('div'); txt(lg, `語系：${((d.langs as string[]) ?? []).join(', ')}`); card.appendChild(lg)
      for (const c of ((d.contents as Array<{ lang: string; content: string }>) ?? [])) { const cl = el('div'); txt(cl, `${c.lang}: ${c.content}`); card.appendChild(cl) }
      return card
    }
    const card = el('div', 'bw-diff-card'); txt(card, d); return card
  }
  // 依商品分組 diff（用於檢視/結果的商品分組）
  function diffGroupName(d: Record<string, unknown>): string {
    if (d.prod_oid != null) return resultNameByKey.get(String(d.prod_oid)) ?? String(d.prod_oid)
    const aff = d.affected_pkgs as Array<{ prod_oid?: string }> | undefined
    if (aff && aff[0]?.prod_oid != null) return resultNameByKey.get(String(aff[0].prod_oid)) ?? String(aff[0].prod_oid)
    if (d.item_oid != null && d.supplier_oid != null) { const f = resultNameByKey.get(`${d.item_oid}:${d.supplier_oid}`); if (f) return f.split(' · ')[0] }
    return '（其他）'
  }

  // =====================================================================
  // STEP 2 — 檢視
  // =====================================================================
  function warningText(): string | undefined {
    if (S.currentChunkActionType === 'announcement') return '商品公告會即時對前台顯示，請確認內容與生效時間後再批准。'
    const wiz = WIZARDS[S.currentChunkActionType as ChunkActionType]
    return wiz?.step2WarningText
  }
  function renderReview(): HTMLElement {
    const page = el('div', 'page')
    const total = S.pendingChunks.length
    const rvhead = el('div', 'rvhead')
    const left = el('div')
    const eb = el('div', 'eyebrow'); txt(eb, `檢視 · ${funcDesc().label}`); left.appendChild(eb)
    const h = el('h2'); h.style.fontSize = '20px'; txt(h, `本批 ${S.diffItems.length} 筆變更${total > 1 ? ` · 共 ${total} 批` : ''}`); left.appendChild(h)
    const sub = el('div', 'muted'); sub.style.cssText = 'font-size:13px;margin-top:2px'
    txt(sub, total > 1 ? `第 ${S.chunkIndex + 1}/${total} 批（總筆數超過 ${BATCH_CAP}，已拆成多個 change-set 逐批批准）` : `${S.shelfSched ? '排程執行' : '立即執行'}`)
    left.appendChild(sub); rvhead.appendChild(left)
    page.appendChild(rvhead)

    const w = warningText()
    if (w) { const rb = el('div', 'riskbar'); rb.appendChild(warnSvg()); const d = el('div'); txt(d, w); rb.appendChild(d); page.appendChild(rb) }

    // 批次卡（本批），內部依商品分組可折疊
    const card = el('div', 'batchcard')
    const hd = el('div', 'batchhd')
    const lbl = el('div', 'lbl')
    const bn = el('span', 'bn'); txt(bn, total > 1 ? `批次 ${S.chunkIndex + 1}／${total}` : '本批'); lbl.appendChild(bn)
    const cnt = el('b'); txt(cnt, `${S.diffItems.length} 筆`); lbl.appendChild(cnt)
    const groups = new Map<string, Array<Record<string, unknown>>>()
    for (const d of S.diffItems) { const g = diffGroupName(d); const a = groups.get(g) ?? []; a.push(d); groups.set(g, a) }
    const gcnt = el('span', 'muted'); gcnt.style.fontSize = '12px'; txt(gcnt, `· ${groups.size} 個商品`); lbl.appendChild(gcnt)
    hd.appendChild(lbl)
    const car = el('span', 'muted'); car.style.fontSize = '12px'; txt(car, S.batchCollapsed ? '▸ 展開' : '▾ 收合'); hd.appendChild(car)
    hd.onclick = () => { S.batchCollapsed = !S.batchCollapsed; render() }
    card.appendChild(hd)
    if (!S.batchCollapsed) {
      const body = el('div', 'batchbody')
      for (const [g, arr] of groups) {
        const grp = el('div', 'rvgrp')
        const h5 = el('h5'); txt(h5, `${g} · ${arr.length} 筆`); grp.appendChild(h5)
        for (const d of arr) {
          const item = el('div', 'rvitem')
          const dot = el('span', `d ${S.currentChunkActionType === 'shelf_schedule' ? 'sched' : 'pend'}`); item.appendChild(dot)
          item.appendChild(renderDiffCard(d))
          grp.appendChild(item)
        }
        body.appendChild(grp)
      }
      card.appendChild(body)
    }
    page.appendChild(card)

    const foot = el('div', 'barfoot')
    foot.appendChild(btn('← 返回選擇', 'btn', () => { rejectOpen(); S.step = 1; render() }))
    foot.appendChild(btn('前往批准 →', 'btn primary', () => { S.step = 3; render() }))
    page.appendChild(foot)
    return page
  }

  // =====================================================================
  // STEP 3 — 批准
  // =====================================================================
  function renderApprove(): HTMLElement {
    const page = el('div', 'page')
    const eb = el('div', 'eyebrow'); txt(eb, '批准送出'); page.appendChild(eb)
    const total = S.pendingChunks.length
    const h = el('h2'); h.style.fontSize = '20px'; txt(h, `${funcDesc().label} · 本批 ${S.diffItems.length} 筆${total > 1 ? ` · 第 ${S.chunkIndex + 1}/${total} 批` : ''}`); page.appendChild(h)
    const w = warningText()
    if (w) { const rb = el('div', 'riskbar'); rb.appendChild(warnSvg()); const d = el('div'); txt(d, w); rb.appendChild(d); page.appendChild(rb) }

    const card = el('div', 'batchcard'); const body = el('div', 'batchbody'); body.style.padding = '14px'
    const r1 = el('div', 'spread'); const s1 = el('span'); txt(s1, '執行方式'); const b1 = el('b'); txt(b1, S.currentChunkActionType === 'shelf_schedule' ? '排程' : '立即執行'); r1.appendChild(s1); r1.appendChild(b1); body.appendChild(r1)
    const r2 = el('div', 'spread mt8'); const s2 = el('span'); txt(s2, '本批變更筆數'); const b2 = el('b', 'tnum'); txt(b2, `${S.diffItems.length} 筆`); r2.appendChild(s2); r2.appendChild(b2); body.appendChild(r2)
    const r3 = el('div', 'spread mt8'); const s3 = el('span'); txt(s3, '拆批'); const b3 = el('b'); txt(b3, `${total} 個 change-set（逐批送出、各自稽核）`); r3.appendChild(s3); r3.appendChild(b3); body.appendChild(r3)
    card.appendChild(body); page.appendChild(card)

    const note = el('p', 'muted mt16'); note.style.fontSize = '13px'; txt(note, '批准＝人工放行；agent 結構上拿不到此按鈕（面板 nonce 通道把關）。')
    page.appendChild(note)

    const foot = el('div', 'barfoot')
    foot.appendChild(btn('← 返回檢視', 'btn', () => { S.step = 2; render() }))
    foot.appendChild(btn(total > 1 ? `確認執行本批（${S.chunkIndex + 1}/${total}）` : '確認執行', 'btn primary', () => { void doApprove() }))
    page.appendChild(foot)
    return page
  }

  async function doApprove(): Promise<void> {
    if (!S.changesetId || !S.nonce || !S.diffVersion) { showFallback('缺少批准所需資訊，請回上一步重載'); return }
    setStatus('執行中…')
    let confirmedKeys: string[]
    if (S.currentChunkActionType === 'announcement') {
      confirmedKeys = S.diffItems.map(d => announcementItemKey({
        prod_oids: (d.prod_oids as string[]) ?? [], name: String(d.name ?? ''), is_enabled: Boolean(d.is_enabled),
        start_time: String(d.start_time ?? ''), end_time: (d.end_time as string | null) ?? null,
        langs: (d.langs as string[]) ?? [], contents: (d.contents as Array<{ lang: string; content: string }>) ?? [],
      }))
    } else {
      const wiz = WIZARDS[S.currentChunkActionType as ChunkActionType]!
      confirmedKeys = S.diffItems.map(wiz.itemKey)
    }
    try {
      const r = await app.callServerTool({ name: 'app_confirm_changeset', arguments: { changeset_id: S.changesetId, decision: 'approve', nonce: S.nonce, diff_version: S.diffVersion, confirmed_keys: confirmedKeys } })
      const env = r.structuredContent
      const err = env?.errors?.[0]
      if (err?.code === 'DIFF_STALE') { showFallback('現況已變，請回檢視重新載入後再批准'); S.step = 2; await loadView(); render(); return }
      if (err) { showFallback(`批准失敗：${err.code ?? ''} ${err.message ?? ''}`); return }
      const rec = (env?.items?.[0] as { results?: unknown[] } | undefined) ?? {}
      S.accumResults.push(...((rec.results as Array<Record<string, unknown>> | undefined) ?? []))
      if (S.chunkIndex < S.pendingChunks.length - 1) { S.chunkIndex++; await stageChunk() }
      else { S.step = 4; render() }
    } catch (e) { showFallback('送出失敗：' + String(e)) }
  }

  // =====================================================================
  // STEP 4 — 結果（依商品分組 + 狀態藥丸）
  // =====================================================================
  function renderResult(): HTMLElement {
    const page = el('div', 'page')
    setStatus('完成')
    const eb = el('div', 'eyebrow'); txt(eb, '結果'); page.appendChild(eb)
    const h = el('h2'); h.style.fontSize = '20px'; txt(h, `已執行 · ${S.accumResults.length} 筆 · ${S.pendingChunks.length} 批`); page.appendChild(h)

    const groups = new Map<string, Array<Record<string, unknown>>>()
    for (const res of S.accumResults) {
      const raw = String(res.item_key ?? '')
      const friendly = resultNameByKey.get(raw)
      const g = friendly ? friendly.split(' · ')[0] : raw
      const a = groups.get(g) ?? []; a.push(res); groups.set(g, a)
    }
    const card = el('div', 'batchcard'); const body = el('div', 'batchbody')
    if (S.accumResults.length === 0) { const p = el('div', 'empty'); txt(p, '（無結果）'); body.appendChild(p) }
    for (const [g, arr] of groups) {
      const grp = el('div', 'rvgrp')
      const h5 = el('h5'); txt(h5, g); grp.appendChild(h5)
      for (const res of arr) {
        const item = el('div', 'rvitem')
        const status = String(res.status)
        let kind = 'err'; let ls = 'ls-err'; let label = `失敗（${status}）`
        if (status === 'done') { kind = 'ok'; ls = 'ls-ok'; label = '已完成' }
        else if (status === 'scheduled') { kind = 'sched'; ls = 'ls-sched'; label = '已排程' }
        else if (status === 'skipped_noop') { kind = 'skip'; ls = 'ls-skip'; label = '無變更，略過' }
        else if (status === 'cancelled') { kind = 'skip'; ls = 'ls-skip'; label = '取消排程' }
        const dot = el('span', `d ${kind}`); item.appendChild(dot)
        const nameWrap = el('span'); nameWrap.style.flex = '1'
        const raw = String(res.item_key ?? '')
        const friendly = resultNameByKey.get(raw)
        nameWrap.appendChild(document.createTextNode(friendly ?? raw))
        if (friendly) { const k = el('span', 'oid'); txt(k, ` ${raw}`); nameWrap.appendChild(k) }
        item.appendChild(nameWrap)
        const pill = el('span', `ledger-status ${ls}`); txt(pill, label); item.appendChild(pill)
        if (kind === 'err' && res.error_code) { const code = el('span', 'oid'); txt(code, String(res.error_code)); item.appendChild(code) }
        grp.appendChild(item)
      }
      body.appendChild(grp)
    }
    card.appendChild(body); page.appendChild(card)

    const note = el('div', 'muted mt16'); note.style.fontSize = '12px'; txt(note, '執行後自動讀回驗證。全鏈路稽核已記錄 actor + tool + before/after。')
    page.appendChild(note)
    const foot = el('div', 'barfoot')
    foot.appendChild(el('span'))
    foot.appendChild(btn('完成 / 開始新一批', 'btn primary', () => startNew()))
    page.appendChild(foot)
    return page
  }

  function startNew(): void {
    resetServerFlow(); resetEdits(); resetAnn()
    S.step = 1; clearFallback(); setStatus('')
    render()
  }

  // =====================================================================
  // Error parsing helper
  // =====================================================================
  function tryParseErrorText(r: { content?: Array<{ type: string; text: string }>; structuredContent?: { errors?: Array<{ code?: string; message?: string }> } }): string | undefined {
    const sErr = r.structuredContent?.errors?.[0]
    if (sErr?.code && sErr?.message) return `${sErr.code} — ${sErr.message}`
    try {
      const raw = r.content?.[0]?.text
      if (raw) { const parsed = JSON.parse(raw); const errs = parsed.errors; if (Array.isArray(errs) && errs.length > 0 && errs[0]?.code && errs[0]?.message) return `${errs[0].code} — ${errs[0].message}` }
    } catch { /* ignore */ }
    return undefined
  }

  // ---- initial render ----
  render()
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  connectApp('be2-workbench').then(a => initWorkbench(a as unknown as WizardApp)).catch(e => {
    const fb = document.getElementById('fallback')!
    fb.hidden = false; fb.textContent = '無法連上 host：' + String(e)
  })
}
