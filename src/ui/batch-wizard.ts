// src/ui/batch-wizard.ts — Task 7 (.superpowers/sdd/task-7-brief.md). Four-step batch wizard panel
// (選擇→檢視→批准→結果) for the two Phase 4a batch action_types (inventory_platform,
// shelf_schedule), driven entirely through the app-only tools Task 5/6 landed
// (app_get_batch_view / app_create_changeset / app_get_changeset_view / app_confirm_changeset).
import { connectApp, renderText } from './panelShared.js'

type ActionType = 'inventory_platform' | 'shelf_schedule'

interface ScheduleEntry { reserve_date_utc: string; reserve_status: boolean }
interface AffectedPkg { prod_oid: string; pkg_oid: string; pkg_name: string }

// Fixed offsets — demo scope only (brief: "禁第三方庫"). DST is NOT modeled; do not reuse this
// for anything beyond the wizard's local<->UTC display/input conversion.
const TZ_OFFSET_HOURS: Record<string, number> = { 'Asia/Taipei': 8, 'Asia/Tokyo': 9, UTC: 0 }

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

export function initWizard(app: WizardApp): void {
  const statusEl = document.getElementById('status')!
  const progressEl = document.getElementById('progress')!
  const wizardEl = document.getElementById('wizard')!
  const fallbackEl = document.getElementById('fallback') as HTMLPreElement

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
      const span = document.createElement('span')
      renderText(span, `${n < step ? '✓' : n} ${label}`)
      progressEl.appendChild(span)
    })
  }
  function setStep(n: number): void { step = n; renderProgress() }

  // ---- Step 1: 選擇 ----
  function renderStep1(prefillProdOids: string[]): void {
    setStep(1)
    wizardEl.textContent = ''
    rows = []
    radioButtons = []

    const prodInput = document.createElement('input')
    prodInput.type = 'text'
    prodInput.value = prefillProdOids.join(', ')
    prodInput.dataset.role = 'prodOidsInput'
    wizardEl.appendChild(prodInput)

    const loadBtn = document.createElement('button')
    loadBtn.textContent = '載入'
    loadBtn.dataset.role = 'loadBtn'
    loadBtn.onclick = () => { void doLoad(prodInput.value) }
    wizardEl.appendChild(loadBtn)

    const planTableEl = document.createElement('div')
    planTableEl.dataset.role = 'planTable'
    wizardEl.appendChild(planTableEl)

    if (actionType === 'shelf_schedule') wizardEl.appendChild(renderDefaultTimeBar())

    const noteInput = document.createElement('input')
    noteInput.type = 'text'
    noteInput.dataset.role = 'noteInput'
    noteInput.onchange = () => { noteValue = noteInput.value }
    wizardEl.appendChild(noteInput)

    const nextBtn = document.createElement('button')
    nextBtn.textContent = '下一步'
    nextBtn.dataset.role = 'nextBtn'
    nextBtn.onclick = () => { void doNext() }
    wizardEl.appendChild(nextBtn)

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

      const filterBar = document.createElement('div')
      const filterInput = document.createElement('input')
      filterInput.type = 'text'
      ;(filterInput as HTMLInputElement).placeholder = '篩選方案…'
      filterInput.dataset.role = 'filterInput'
      filterInput.oninput = () => { filterQuery = filterInput.value.trim(); applyVisibility() }
      filterBar.appendChild(filterInput)
      const hideBtn = document.createElement('button')
      hideBtn.textContent = '隱藏未勾選'
      hideBtn.dataset.role = 'hideUncheckedBtn'
      hideBtn.onclick = () => {
        hideUnchecked = !hideUnchecked
        hideBtn.textContent = hideUnchecked ? '顯示全部' : '隱藏未勾選'
        applyVisibility()
      }
      filterBar.appendChild(hideBtn)
      container.appendChild(filterBar)

      if (actionType === 'inventory_platform') {
        const radioBar = document.createElement('div')
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
          badge.dataset.role = 'coBadge'
          badge.hidden = true
          const rs: RowState = {
            checkbox: cb, badge, rowEl: row, prod_oid: prod.prod_oid, pkg_oid: String(plan.pkg_oid),
            pkg_name: (plan.name as string | undefined) ?? String(plan.pkg_oid),
            item_oid: itemOid, supplier_oid: supplierOid, is_bundle: isBundle, queue: [],
          }
          rows.push(rs)
          cb.onclick = () => {
            if (actionType === 'inventory_platform') syncSiblings(rs)
            applyVisibility() // hideUnchecked 開啟時,勾/取消勾都可能改變本列(與連動列)的可見性
          }
          row.appendChild(cb)
          const nameSpan = document.createElement('span')
          renderText(nameSpan, rs.pkg_name)
          row.appendChild(nameSpan)
          // brief: 方案表格需含「供應商、現況欄」——供應商用 be2 內容(untrusted)一律 renderText 純文字;
          // current_platform 可能 null(讀不到,非「否」),顯示「—」而非空白或 false,避免使用者誤讀成
          // 已確定某個平台(src/tools/batchView.ts resolveCurrentPlatform 的 PLATFORM_READ_UNAVAILABLE
          // 就是為了不讓 unknown 被誤呈現成一個確定值)。
          const supplierSpan = document.createElement('span')
          renderText(supplierSpan, plan.supplier_name ? String(plan.supplier_name) : '—')
          row.appendChild(supplierSpan)
          const statusSpan = document.createElement('span')
          if (actionType === 'inventory_platform') {
            renderText(statusSpan, plan.current_platform != null ? String(plan.current_platform) : '—')
          } else {
            const queueLen = Array.isArray(plan.reserve_queue) ? plan.reserve_queue.length : 0
            renderText(statusSpan, isBundle ? '(bundle，不可個別排程)' : queueLen > 0 ? `現有 ${queueLen} 筆排程` : '（無排程）')
          }
          row.appendChild(statusSpan)
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
        }
      }
      // 自己這列的 badge:勾選發起者本人不掛「將一併變更」(那是標示「被連帶」的列);取消時一律清。
      if (!on) changed.badge.hidden = true
    }

    function renderDefaultTimeBar(): HTMLElement {
      const bar = document.createElement('div')
      const date = document.createElement('input'); date.type = 'date'; date.dataset.role = 'defDate'
      const hour = document.createElement('input'); hour.type = 'number'; hour.value = '0'; hour.dataset.role = 'defHour'
      const minute = document.createElement('input'); minute.type = 'number'; minute.value = '0'; minute.dataset.role = 'defMinute'
      const tz = document.createElement('select'); tz.dataset.role = 'defTz'
      for (const z of ['Asia/Taipei', 'Asia/Tokyo', 'UTC']) {
        const opt = document.createElement('option'); opt.value = z; renderText(opt, z); tz.appendChild(opt)
      }
      tz.value = 'Asia/Taipei'
      const status = document.createElement('select'); status.dataset.role = 'defStatus'
      for (const [v, label] of [['true', '上架'], ['false', '下架']]) {
        const opt = document.createElement('option'); opt.value = v; renderText(opt, label); status.appendChild(opt)
      }
      status.value = 'true'
      const applyBtn = document.createElement('button')
      applyBtn.textContent = '套用到所有已勾選'
      applyBtn.dataset.role = 'applyAllBtn'
      applyBtn.onclick = () => {
        lastTz = tz.value
        const utc = toReserveDateUtc(date.value, Number(hour.value), Number(minute.value), tz.value)
        for (const r of rows) {
          if (r.checkbox.checked && !r.is_bundle) r.queue.push({ reserve_date_utc: utc, reserve_status: status.value === 'true' })
        }
      }
      bar.appendChild(date); bar.appendChild(hour); bar.appendChild(minute); bar.appendChild(tz); bar.appendChild(status); bar.appendChild(applyBtn)
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

  // ---- Step 2: 檢視 ----
  function renderStep2(rec: Record<string, unknown>): void {
    setStep(2)
    wizardEl.textContent = ''
    if (actionType === 'shelf_schedule') {
      const warn = document.createElement('p')
      warn.style.color = '#b00'
      renderText(warn, '原排程將被整組取代（reserve_queue 為整組替換、非合併）')
      wizardEl.appendChild(warn)
    }
    for (const d of currentDiffItems) {
      const row = document.createElement('div')
      if (actionType === 'shelf_schedule' && Array.isArray(d.new_queue)) {
        const lines = (d.new_queue as ScheduleEntry[]).map(e => formatDualDisplay(e.reserve_date_utc, lastTz)).join(' | ')
        renderText(row, `${d.pkg_name ?? d.pkg_oid}: ${lines || '(空，將清除排程)'}`)
      } else {
        renderText(row, d)
      }
      wizardEl.appendChild(row)
    }
    if (rec.note) {
      const noteP = document.createElement('p')
      renderText(noteP, `備註：${String(rec.note)}`)
      wizardEl.appendChild(noteP)
    }
    const toApproveBtn = document.createElement('button')
    toApproveBtn.textContent = '前往批准'
    toApproveBtn.dataset.role = 'toApproveBtn'
    toApproveBtn.onclick = () => renderStep3()
    wizardEl.appendChild(toApproveBtn)
  }

  // ---- Step 3: 批准 ----
  function renderStep3(): void {
    setStep(3)
    wizardEl.textContent = ''
    const approveBtn = document.createElement('button')
    approveBtn.textContent = '確認執行'
    approveBtn.dataset.role = 'approveBtn'
    approveBtn.onclick = () => { void doApprove() }
    wizardEl.appendChild(approveBtn)
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
      if (err?.code === 'DIFF_STALE') { showFallback(fallbackEl, '現況已變，請回上一步重載'); return }
      if (err) { showFallback(fallbackEl, `批准失敗：${err.code ?? ''} ${err.message ?? ''}`); return }
      const rec = (env?.items?.[0] as { results?: unknown[] } | undefined) ?? {}
      renderStep4((rec.results as Array<Record<string, unknown>> | undefined) ?? [])
    } catch (e) { showFallback(fallbackEl, '送出失敗：' + String(e)) }
  }

  // ---- Step 4: 結果 ----
  function renderStep4(results: Array<Record<string, unknown>>): void {
    setStep(4)
    wizardEl.textContent = ''
    statusEl.textContent = '完成'
    for (const res of results) {
      const row = document.createElement('div')
      row.dataset.itemKey = String(res.item_key)
      row.dataset.status = String(res.status)
      const status = res.status
      row.style.color = status === 'done' ? 'green' : status === 'skipped_noop' ? 'gray' : 'red'
      const suffix = status === 'done' || status === 'skipped_noop' ? '' : ` ${res.error_code ?? ''}`
      renderText(row, `${res.item_key}: ${res.status}${suffix}`)
      wizardEl.appendChild(row)
    }
  }

  app.ontoolresult = params => {
    try {
      const env = params.structuredContent
      const rec = (env?.items?.[0] as { action_type?: ActionType; prod_oids?: string[] } | undefined) ?? {}
      actionType = rec.action_type ?? 'inventory_platform'
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
