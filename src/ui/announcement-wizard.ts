// src/ui/announcement-wizard.ts — Session 1 (塊 C). Dedicated create-form wizard panel for the
// `announcement` action_type (選擇→填寫→批准→結果), driven through the same app-only tools the
// batch wizard uses (app_get_announcement_view / app_create_changeset / app_get_changeset_view /
// app_confirm_changeset). Announcement is a create FORM (not a plan grid), so it gets its own
// panel rather than folding into batch-wizard.ts (spec §4.2). Import-safe like batch-wizard.ts:
// the connectApp bootstrap is guarded by `typeof window` so tests can call initAnnouncementWizard()
// directly with a stub app.
import { connectApp, renderText } from './panelShared.js'
import { itemKey } from '../modules/announcement/create/keys.js'
import type { AnnouncementCreateItem } from '../core/changeset/types.js'

// 固定時區偏移（demo scope，禁第三方庫）。DST 不建模——面板本地時間 ↔ UTC 顯示/輸入換算用。
const TZ_OFFSET_HOURS: Record<string, number> = { 'Asia/Taipei': 8, 'Asia/Tokyo': 9, UTC: 0 }
// 語系清單（§6.2；en-default 為 en-xx fallback 文案來源）。POC 取常用子集。
const LANGS = ['zh-tw', 'en-default', 'ja-jp', 'ko-kr', 'th-th', 'vi-vn']

function pad2(n: number): string { return String(n).padStart(2, '0') }

// 本地日期+時間(HH:mm)+tz → UTC "YYYY-MM-DD HH:mm:ss"。與 batch-wizard 的 toReserveDateUtc 同一時間
// 數學（複製而非 import，避免動 batch-wizard.ts / Session 2 檔）。
export function toUtcDateTime(dateStr: string, timeStr: string, tz: string): string {
  const offset = TZ_OFFSET_HOURS[tz] ?? 0
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d, hh - offset, mm, 0))
  const res = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())} ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:00`
  if (res.includes('NaN')) throw new Error('INVALID_DATE')
  return res
}

const STYLE = `
:root{--bw-tint:#0A84FF;--bw-danger:#FF3B30;--bw-text:#1d1d1f;--bw-muted:#6e6e73;--bw-border:rgba(0,0,0,.08);--bw-bg-page:#f5f5f7}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{background:var(--bw-bg-page)}
body{font:100%/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--bw-text);max-width:720px;margin:0 auto;padding:1.5rem 1.25rem 3rem}
.bw-title{font-size:1.25rem;font-weight:600;margin:0 0 1rem}
#status{font-size:.8125rem;color:var(--bw-muted);margin-bottom:.5rem}
.bw-progress{display:flex;align-items:center;margin:0 0 1.5rem}
.bw-step{display:flex;flex-direction:column;align-items:center;gap:.25rem;flex:0 0 auto}
.bw-step-circle{width:1.75rem;height:1.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.8125rem;font-weight:600;border:1.5px solid #d2d2d7;color:var(--bw-muted);background:#fff}
.bw-step-current .bw-step-circle{border-color:var(--bw-tint);color:var(--bw-tint)}
.bw-step-done .bw-step-circle{background:var(--bw-tint);border-color:var(--bw-tint);color:#fff}
.bw-step-label{font-size:.75rem;color:var(--bw-muted);white-space:nowrap}
.bw-step-current .bw-step-label{color:var(--bw-text);font-weight:600}
.bw-connector{flex:1 1 auto;height:1.5px;background:#d2d2d7;margin:0 .25rem 1.1rem}
.bw-connector-done{background:var(--bw-tint)}
.bw-card{background:#fff;border:1px solid var(--bw-border);border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 12px rgba(0,0,0,.04);padding:1rem 1.125rem;margin-bottom:1rem}
.bw-card-title{font-size:.8125rem;font-weight:600;color:var(--bw-muted);margin:0 0 .625rem;text-transform:uppercase;letter-spacing:.02em}
.bw-row-inline{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.bw-field{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.75rem}
.bw-field label{font-size:.8125rem;color:var(--bw-muted)}
.bw-input,.bw-select,textarea.bw-input{padding:.375rem .625rem;border-radius:8px;border:1px solid rgba(0,0,0,.14);font:inherit;font-size:.875rem;background:#fff;color:var(--bw-text)}
.bw-input:focus-visible,.bw-select:focus-visible{outline:2px solid var(--bw-tint);outline-offset:1px;border-color:var(--bw-tint)}
.bw-btn{height:2rem;padding:0 1.1rem;border-radius:8px;border:1px solid transparent;font:inherit;font-size:.875rem;font-weight:500;cursor:pointer}
.bw-btn-primary{background:var(--bw-tint);color:#fff}
.bw-btn-secondary{background:#f0f0f2;color:var(--bw-text)}
.bw-row-footer{display:flex;justify-content:flex-end;align-items:center;gap:.75rem}
.bw-banner{border-radius:10px;padding:.625rem .875rem;font-size:.875rem;margin-bottom:1rem}
.bw-banner-danger{background:rgba(255,59,48,.1);color:#b8281f}
.bw-prod-line{font-size:.875rem;padding:.25rem 0}
.bw-lang-row{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.5rem}
.bw-diff-card{padding:.625rem 0;border-bottom:1px solid var(--bw-border)}
.bw-ledger-row{display:flex;gap:.625rem;padding:.5rem .25rem;border-bottom:1px solid var(--bw-border)}
.bw-ledger-status-ok{color:#1d8a3c;font-weight:600}
.bw-ledger-status-error{color:var(--bw-danger);font-weight:600}
`

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)
}

// Duck-typed subset of the MCP Apps `App` — only the member this panel touches. Test seam: lets
// tests drive initAnnouncementWizard() with a stub instead of a full ui/initialize handshake.
export interface WizardApp {
  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    isError?: boolean
    content?: Array<{ type: string; text: string }>
    structuredContent?: { items?: unknown[]; errors?: Array<{ code?: string; message?: string }> }
  }>
}

function primaryBtn(text: string, role: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement('button') as HTMLButtonElement
  b.textContent = text; b.className = 'bw-btn bw-btn-primary'; b.dataset.role = role; b.onclick = onclick
  return b
}
function secondaryBtn(text: string, role: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement('button') as HTMLButtonElement
  b.textContent = text; b.className = 'bw-btn bw-btn-secondary'; b.dataset.role = role; b.onclick = onclick
  return b
}

export function initAnnouncementWizard(app: WizardApp, prefillProdOids: string[] = []): void {
  injectStyles()
  const statusEl = document.getElementById('status')!
  const progressEl = document.getElementById('progress')!
  const wizardEl = document.getElementById('wizard')!
  const fallbackEl = document.getElementById('fallback')!
  progressEl.className = 'bw-progress'

  let step = 1
  let changesetId: string | undefined
  let currentNonce: string | undefined
  let currentDiffVersion: string | undefined
  let currentDiffItems: Array<Record<string, unknown>> = []
  let stagedItem: AnnouncementCreateItem | undefined

  function showFallback(m: string): void { fallbackEl.hidden = false; fallbackEl.textContent = m }
  function clearFallback(): void { fallbackEl.hidden = true; fallbackEl.textContent = '' }

  const STEP_LABELS = ['選擇', '填寫', '批准', '結果']
  function renderProgress(): void {
    progressEl.textContent = ''
    STEP_LABELS.forEach((label, i) => {
      const n = i + 1
      if (i > 0) {
        const c = document.createElement('span'); c.className = `bw-connector${n - 1 < step ? ' bw-connector-done' : ''}`; progressEl.appendChild(c)
      }
      const s = document.createElement('span'); s.className = `bw-step ${n < step ? 'bw-step-done' : n === step ? 'bw-step-current' : 'bw-step-pending'}`
      const circle = document.createElement('span'); circle.className = 'bw-step-circle'; renderText(circle, n < step ? '✓' : String(n)); s.appendChild(circle)
      const lab = document.createElement('span'); lab.className = 'bw-step-label'; renderText(lab, label); s.appendChild(lab)
      progressEl.appendChild(s)
    })
  }
  function setStep(n: number): void { step = n; renderProgress() }

  // ---- Step 1: 選擇商品 ----
  function renderStep1(): void {
    setStep(1)
    wizardEl.textContent = ''
    const card = document.createElement('div'); card.className = 'bw-card'
    const title = document.createElement('div'); title.className = 'bw-card-title'; renderText(title, '商品'); card.appendChild(title)
    const row = document.createElement('div'); row.className = 'bw-row-inline'
    const input = document.createElement('input') as HTMLInputElement
    input.type = 'text'; input.className = 'bw-input'; input.placeholder = '商品 oid，逗號或空白分隔'
    input.value = prefillProdOids.join(', '); input.dataset.role = 'prodOidsInput'; input.style.flex = '1'
    row.appendChild(input)
    row.appendChild(primaryBtn('載入', 'loadBtn', () => { void doLoad(input.value) }))
    card.appendChild(row)
    wizardEl.appendChild(card)

    const listCard = document.createElement('div'); listCard.className = 'bw-card'; listCard.dataset.role = 'prodList'; listCard.hidden = true
    wizardEl.appendChild(listCard)

    async function doLoad(raw: string): Promise<void> {
      const prodOids = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
      if (prodOids.length === 0) { showFallback('請輸入至少一個商品 oid'); return }
      clearFallback(); statusEl.textContent = '載入中…'
      try {
        const r = await app.callServerTool({ name: 'app_get_announcement_view', arguments: { prod_oids: prodOids } })
        if (r.isError) { showFallback('載入失敗'); return }
        const products = (r.structuredContent?.items?.[0] as { products?: Array<Record<string, unknown>> } | undefined)?.products ?? []
        loadedProdOids = products.map(p => String(p.prod_oid))
        renderProdList(listCard, products)
        statusEl.textContent = `已載入 ${products.length} 個商品`
      } catch (e) { showFallback('載入失敗：' + String(e)) }
    }
  }

  let loadedProdOids: string[] = []
  function renderProdList(container: HTMLElement, products: Array<Record<string, unknown>>): void {
    container.hidden = false; container.textContent = ''
    const title = document.createElement('div'); title.className = 'bw-card-title'; renderText(title, '將對這些商品建立公告'); container.appendChild(title)
    for (const p of products) {
      const line = document.createElement('div'); line.className = 'bw-prod-line'
      const existing = Number(p.existing_count)
      const ex = existing < 0 ? '（既有公告數未知）' : `（既有公告 ${existing} 筆）`
      renderText(line, `${p.name ?? p.prod_oid}  ${p.prod_oid} ${ex}`)
      container.appendChild(line)
    }
    const footer = document.createElement('div'); footer.className = 'bw-row-footer'
    footer.appendChild(primaryBtn('下一步：填寫公告', 'toStep2Btn', () => renderStep2()))
    container.appendChild(footer)
  }

  // ---- Step 2: 填寫公告表單 ----
  function renderStep2(): void {
    if (loadedProdOids.length === 0) { showFallback('請先載入商品'); return }
    setStep(2); wizardEl.textContent = ''
    const card = document.createElement('div'); card.className = 'bw-card'

    const nameField = field('公告標題（≤254）', 'text', 'nameInput'); card.appendChild(nameField.wrap)
    // is_enabled
    const enWrap = document.createElement('div'); enWrap.className = 'bw-field'
    const enLabel = document.createElement('label'); renderText(enLabel, '啟用'); enWrap.appendChild(enLabel)
    const enInput = document.createElement('input') as HTMLInputElement
    enInput.type = 'checkbox'; enInput.checked = true; enInput.dataset.role = 'enabledInput'; enWrap.appendChild(enInput)
    card.appendChild(enWrap)

    // start time (date + time HH:mm + tz)
    const startWrap = document.createElement('div'); startWrap.className = 'bw-field'
    const startLabel = document.createElement('label'); renderText(startLabel, '開始時間'); startWrap.appendChild(startLabel)
    const startRow = document.createElement('div'); startRow.className = 'bw-row-inline'
    const startDate = mkInput('date', 'startDate'); const startTime = mkInput('time', 'startTime'); startTime.value = '00:00'
    const tzSel = mkTz('startTz')
    startRow.appendChild(startDate); startRow.appendChild(startTime); startRow.appendChild(tzSel)
    startWrap.appendChild(startRow); card.appendChild(startWrap)

    // end time (optional)
    const endWrap = document.createElement('div'); endWrap.className = 'bw-field'
    const endLabel = document.createElement('label'); renderText(endLabel, '結束時間（選填）'); endWrap.appendChild(endLabel)
    const endRow = document.createElement('div'); endRow.className = 'bw-row-inline'
    const endDate = mkInput('date', 'endDate'); const endTime = mkInput('time', 'endTime'); endTime.value = '00:00'
    const endTz = mkTz('endTz')
    endRow.appendChild(endDate); endRow.appendChild(endTime); endRow.appendChild(endTz)
    endWrap.appendChild(endRow); card.appendChild(endWrap)

    // langs + per-lang content
    const langTitle = document.createElement('div'); langTitle.className = 'bw-card-title'; renderText(langTitle, '語系與內文'); card.appendChild(langTitle)
    const contentInputs = new Map<string, HTMLTextAreaElement>()
    const langChecks = new Map<string, HTMLInputElement>()
    for (const lang of LANGS) {
      const lr = document.createElement('div'); lr.className = 'bw-lang-row'
      const top = document.createElement('div'); top.className = 'bw-row-inline'
      const cb = document.createElement('input') as HTMLInputElement
      cb.type = 'checkbox'; cb.dataset.role = `lang-${lang}`; cb.dataset.lang = lang
      const cbLabel = document.createElement('span'); renderText(cbLabel, lang)
      top.appendChild(cb); top.appendChild(cbLabel); lr.appendChild(top)
      const ta = document.createElement('textarea') as HTMLTextAreaElement
      ta.className = 'bw-input'; ta.dataset.role = `content-${lang}`; ta.hidden = true; ta.placeholder = `${lang} 內文`
      cb.onchange = () => { ta.hidden = !cb.checked }
      lr.appendChild(ta); card.appendChild(lr)
      contentInputs.set(lang, ta); langChecks.set(lang, cb)
    }
    wizardEl.appendChild(card)

    const footer = document.createElement('div'); footer.className = 'bw-row-footer'
    footer.appendChild(secondaryBtn('← 返回選擇', 'backToStep1Btn', () => renderStep1()))
    footer.appendChild(primaryBtn('下一步：檢視', 'nextBtn', () => { void doNext() }))
    wizardEl.appendChild(footer)

    async function doNext(): Promise<void> {
      clearFallback()
      const name = (nameField.input as HTMLInputElement).value.trim()
      if (!name) { showFallback('請填公告標題'); return }
      if (!startDate.value) { showFallback('請選開始日期'); return }
      let start_time: string
      try { start_time = toUtcDateTime(startDate.value, startTime.value || '00:00', tzSel.value) }
      catch { showFallback('開始時間格式錯誤'); return }
      let end_time: string | null = null
      if (endDate.value) {
        try { end_time = toUtcDateTime(endDate.value, endTime.value || '00:00', endTz.value) }
        catch { showFallback('結束時間格式錯誤'); return }
      }
      const langs: string[] = []
      const contents: Array<{ lang: string; content: string }> = []
      for (const lang of LANGS) {
        if (langChecks.get(lang)!.checked) {
          langs.push(lang)
          contents.push({ lang, content: contentInputs.get(lang)!.value })
        }
      }
      if (langs.length === 0) { showFallback('請至少選一個語系'); return }

      const item: AnnouncementCreateItem = {
        prod_oids: loadedProdOids, name, is_enabled: enInput.checked,
        start_time, end_time, langs, contents,
      }
      stagedItem = item
      statusEl.textContent = '建立變更中…'
      try {
        const createR = await app.callServerTool({ name: 'app_create_changeset', arguments: { action_type: 'announcement', items: [item] } })
        const created = createR.structuredContent?.items?.[0] as { changeset_id?: string } | undefined
        if (createR.isError || !created?.changeset_id) {
          const err = createR.structuredContent?.errors?.[0]
          showFallback(`建立變更失敗${err ? '：' + (err.code ?? '') + ' ' + (err.message ?? '') : ''}`)
          return
        }
        changesetId = created.changeset_id
        const rec = await loadView()
        if (!rec) return
        renderStep3(rec)
      } catch (e) { showFallback('建立變更失敗：' + String(e)) }
    }
  }

  async function loadView(): Promise<Record<string, unknown> | undefined> {
    const r = await app.callServerTool({ name: 'app_get_changeset_view', arguments: { changeset_id: changesetId } })
    if (r.isError) { showFallback('讀取變更失敗'); return undefined }
    const rec = (r.structuredContent?.items?.[0] as Record<string, unknown> | undefined) ?? {}
    const diff = rec.diff as { items?: Array<Record<string, unknown>> } | undefined
    currentDiffItems = diff?.items ?? []
    currentNonce = rec.nonce as string | undefined
    currentDiffVersion = rec.diff_version as string | undefined
    return rec
  }

  // ---- Step 3: 檢視 + 批准 ----
  function renderStep3(_rec: Record<string, unknown>): void {
    setStep(3); wizardEl.textContent = ''
    const warn = document.createElement('div'); warn.className = 'bw-banner bw-banner-danger'
    renderText(warn, '商品公告會即時對前台顯示，請確認內容與生效時間後再批准。'); wizardEl.appendChild(warn)
    const card = document.createElement('div'); card.className = 'bw-card'
    for (const d of currentDiffItems) {
      const dc = document.createElement('div'); dc.className = 'bw-diff-card'
      const nm = document.createElement('div'); renderText(nm, `公告：${d.name}`); dc.appendChild(nm)
      const pr = document.createElement('div')
      const names = (d.product_names as string[] | undefined) ?? []
      renderText(pr, `商品：${names.length ? names.join('、') : (d.prod_oids as string[]).join('、')}`); dc.appendChild(pr)
      const tm = document.createElement('div'); renderText(tm, `生效：${d.start_time}${d.end_time ? ' ~ ' + d.end_time : ''}（UTC）`); dc.appendChild(tm)
      const lg = document.createElement('div'); renderText(lg, `語系：${((d.langs as string[]) ?? []).join(', ')}`); dc.appendChild(lg)
      for (const c of ((d.contents as Array<{ lang: string; content: string }>) ?? [])) {
        const cl = document.createElement('div'); renderText(cl, `${c.lang}: ${c.content}`); dc.appendChild(cl)
      }
      card.appendChild(dc)
    }
    wizardEl.appendChild(card)
    const footer = document.createElement('div'); footer.className = 'bw-row-footer'
    footer.appendChild(secondaryBtn('← 回填寫', 'backToStep2Btn', () => renderStep2()))
    footer.appendChild(primaryBtn('確認執行', 'approveBtn', () => { void doApprove() }))
    wizardEl.appendChild(footer)
  }

  async function doApprove(): Promise<void> {
    if (!changesetId || !currentNonce || !currentDiffVersion || !stagedItem) { showFallback('缺少批准所需資訊，請回上一步重載'); return }
    statusEl.textContent = '執行中…'
    const confirmedKeys = [itemKey(stagedItem)]
    try {
      const r = await app.callServerTool({
        name: 'app_confirm_changeset',
        arguments: { changeset_id: changesetId, decision: 'approve', nonce: currentNonce, diff_version: currentDiffVersion, confirmed_keys: confirmedKeys },
      })
      const env = r.structuredContent
      const err = env?.errors?.[0]
      if (err) { showFallback(`批准失敗：${err.code ?? ''} ${err.message ?? ''}`); return }
      const rec = (env?.items?.[0] as { results?: unknown[] } | undefined) ?? {}
      renderStep4((rec.results as Array<Record<string, unknown>> | undefined) ?? [])
    } catch (e) { showFallback('送出失敗：' + String(e)) }
  }

  // ---- Step 4: 結果 ----
  function renderStep4(results: Array<Record<string, unknown>>): void {
    setStep(4); wizardEl.textContent = ''; clearFallback()
    const card = document.createElement('div'); card.className = 'bw-card'
    if (results.length === 0) { const p = document.createElement('div'); renderText(p, '（無結果）'); card.appendChild(p) }
    for (const r of results) {
      const row = document.createElement('div'); row.className = 'bw-ledger-row'
      const k = document.createElement('span'); renderText(k, String(r.item_key ?? '')); row.appendChild(k)
      const st = document.createElement('span')
      st.className = r.status === 'done' ? 'bw-ledger-status-ok' : 'bw-ledger-status-error'
      renderText(st, r.status === 'done' ? '✓ 已建立' : `✗ ${r.status}${r.error_code ? ' ' + r.error_code : ''}`)
      row.appendChild(st); card.appendChild(row)
    }
    wizardEl.appendChild(card)
    statusEl.textContent = '完成'
  }

  // helpers
  function mkInput(type: string, role: string): HTMLInputElement {
    const i = document.createElement('input') as HTMLInputElement
    i.type = type; i.className = 'bw-input'; i.dataset.role = role; return i
  }
  function mkTz(role: string): HTMLSelectElement {
    const s = document.createElement('select') as HTMLSelectElement
    s.className = 'bw-select'; s.dataset.role = role
    for (const z of Object.keys(TZ_OFFSET_HOURS)) { const o = document.createElement('option') as HTMLOptionElement; o.value = z; renderText(o, z); s.appendChild(o) }
    s.value = 'Asia/Taipei'; return s
  }
  function field(labelText: string, type: string, role: string): { wrap: HTMLElement; input: HTMLElement } {
    const wrap = document.createElement('div'); wrap.className = 'bw-field'
    const label = document.createElement('label'); renderText(label, labelText); wrap.appendChild(label)
    const input = mkInput(type, role); wrap.appendChild(input)
    return { wrap, input }
  }

  renderStep1()
}

// import-safe bootstrap (see batch-wizard.ts): only wire the real MCP transport in a browser.
if (typeof window !== 'undefined') {
  connectApp('be2-announcement-wizard').then(a => {
    const prod = (a as unknown as { toolInput?: { prod_oids?: string[] } })?.toolInput?.prod_oids ?? []
    initAnnouncementWizard(a as unknown as WizardApp, prod)
  }).catch(e => {
    const fb = document.getElementById('fallback')!
    fb.hidden = false; fb.textContent = '無法連上 host：' + String(e)
  })
}
