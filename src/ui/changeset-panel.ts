import { connectApp, renderText, backoffPoll } from './panelShared.js'
import { itemKey as invKey } from '../modules/product/inventorySetting/keys.js'
import { itemKey as shelfKey } from '../modules/product/shelfToggle/keys.js'

// 終態清單：抽成單一常數，refresh() 與 ontoolresult 都用它，避免兩處漏加同一狀態而導致無限輪詢。
const TERMINAL_STATUSES = ['done', 'partial', 'failed', 'rejected', 'expired']

// 高風險 action_type：approve 前需面板內二次確認（紅字 banner），而非直接送出。
// 目前只有 inventory_setting——庫存寫入立即影響前台可售並清除快取（見 phase3a-runbook）。
const HIGH_RISK_ACTIONS = ['inventory_setting']

const statusEl = document.getElementById('status')!
const bodyEl = document.getElementById('body')!
const bannerEl = document.getElementById('banner') as HTMLDivElement
const fallback = document.getElementById('fallback') as HTMLPreElement
function showFallback(m: string) { fallback.hidden = false; fallback.textContent = m }
function hideBanner() { bannerEl.hidden = true; bannerEl.textContent = '' }

// itemKey 規則須與 server 端完全一致，否則 confirmed_keys 永遠對不上、approve 一律
// CONFIRMED_KEYS_MISMATCH：
//   - shelf：src/changeset/executor.ts#itemKey → pkg_oid ? `${prod_oid}:${pkg_oid}` : prod_oid
//   - inventory：src/changeset/confirmService.ts#itemKeysOf → `${item_oid}:${supplier_oid}`
// 用 diff item 是否帶 item_oid 欄位來分辨兩種形狀（跟 diff.ts 的 diffVersionHash 判斷方式一致）。
function itemKeyOf(d: any): string {
  if (d && typeof d === 'object' && 'item_oid' in d) return invKey(d)
  return shelfKey(d)
}

let currentDiffItems: any[] = []

function renderDiff(env: any) {
  const items: any[] = env.items?.[0]?.diff?.items ?? env.diff?.items ?? []
  currentDiffItems = items
  const table = document.createElement('table')
  for (const d of items) {
    const tr = document.createElement('tr'); const td = document.createElement('td')
    renderText(td, d); tr.appendChild(td); table.appendChild(tr)
  }
  bodyEl.textContent = ''; bodyEl.appendChild(table)
}

connectApp('be2-changeset-panel').then(app => {
  let changesetId: string | undefined
  let stopPolling: (() => void) | undefined
  let currentActionType: string | undefined
  let currentNonce: string | undefined
  let currentDiffVersion: string | undefined

  const openConfirmBtn = document.createElement('button'); openConfirmBtn.textContent = '前往核准（確認頁）'
  openConfirmBtn.onclick = async () => {
    if (!changesetId) return
    const r = await app.callServerTool({ name: 'app_get_confirm_link', arguments: { changeset_id: changesetId } })
    const env = (r as any).structuredContent ?? {}
    const url = env.items?.[0]?.confirm_url
    if (url) { const o = await app.openLink({ url }); if (o.isError) showFallback('host 拒絕開啟連結：' + url) }
  }
  document.body.appendChild(openConfirmBtn)

  // 批准/拒絕 UI 容器：每次 renderApprovalControls 重繪，絕不殘留上一輪 checkbox。
  const approvalEl = document.createElement('div')
  document.body.appendChild(approvalEl)

  function checkedKeys(): string[] {
    return [...approvalEl.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-item-key]')]
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.itemKey!)
  }

  // 送出 approve/reject：nonce + diff_version 一律取自最近一次 app_get_changeset_view 回傳
  // （model 讀不到這兩個值，見 spike T6）；confirmed_keys 收集「按下當下仍勾選」的 item key——
  // 預設全勾，取消勾選 = 該批次視同拒絕（服務端以 CONFIRMED_KEYS_MISMATCH 擋下，此為設計行為，
  // 不在此處靜默調整批次範圍）。
  // `keys` 由呼叫端在核取方塊還在 DOM 上時擷取後傳入（見 renderApprovalControls 的按鈕
  // handler）——不可在這裡才呼叫 checkedKeys()：高風險二次確認會先把 approvalEl 換成 banner，
  // 屆時核取方塊已從 DOM 移除，事後才讀會永遠拿到空集合，導致每筆高風險 approve 都誤觸
  // CONFIRMED_KEYS_MISMATCH。
  async function doConfirm(decision: 'approve' | 'reject', keys: string[]) {
    if (!changesetId || !currentNonce || !currentDiffVersion) return
    hideBanner()
    approvalEl.textContent = ''
    statusEl.textContent = decision === 'approve' ? '執行中…' : '處理中…'
    const args = {
      changeset_id: changesetId, decision, nonce: currentNonce, diff_version: currentDiffVersion,
      confirmed_keys: keys,
    }
    try {
      const r = await app.callServerTool({ name: 'app_confirm_changeset', arguments: args })
      const raw = r as any
      if (raw.isError) {
        let msg = 'unknown error'
        try { msg = JSON.parse(raw.content?.[0]?.text ?? '{}')?.error?.message ?? msg } catch { /* keep default */ }
        showFallback(`${decision === 'approve' ? '批准' : '拒絕'}失敗：${msg}`)
      } else {
        const env = raw.structuredContent ?? {}
        const err = env.errors?.[0]
        if (err?.code === 'DIFF_STALE') {
          showFallback('審閱內容已過期（be2 現況又變了），已重新載入最新 diff，請重新確認。')
        } else if (err) {
          showFallback(`${decision === 'approve' ? '批准' : '拒絕'}失敗：${err.code ?? ''} ${err.message ?? ''}`)
        }
      }
    } catch (e) {
      showFallback('送出失敗：' + String(e))
    }
    // 不論成功/失敗/stale，一律重新拉一次 view：成功時取得終態（approve 是同步 read-merge-write，
    // 回來時通常已是 done/partial/failed）；stale 時取得新 nonce+diff_version；失敗時至少同步最新狀態。
    await refresh()
  }

  function showHighRiskConfirm(keys: string[]) {
    approvalEl.textContent = ''
    bannerEl.hidden = false
    bannerEl.textContent = '⚠️ 高風險操作：庫存寫入會立即影響前台可售狀態並清除快取，執行後可能無法逆轉。請再次確認要執行這批變更。'
    const confirmBtn = document.createElement('button'); confirmBtn.textContent = '確定執行'
    confirmBtn.onclick = () => { void doConfirm('approve', keys) }
    const cancelBtn = document.createElement('button'); cancelBtn.textContent = '取消'
    cancelBtn.onclick = () => { hideBanner(); renderApprovalControls() }
    approvalEl.appendChild(confirmBtn); approvalEl.appendChild(cancelBtn)
  }

  function renderApprovalControls() {
    approvalEl.textContent = ''
    // 只有 pending_approval 且 host 回過 nonce（T6-PASS host）才有批准 UI；否則維持 Task 9 的
    // 「前往核准（確認頁）」openLink 退路，不裝批准按鈕。
    if (!currentNonce || !currentDiffVersion) return
    for (const d of currentDiffItems) {
      const row = document.createElement('label'); row.style.display = 'block'
      const cb = document.createElement('input')
      cb.type = 'checkbox'; cb.checked = true; cb.dataset.itemKey = itemKeyOf(d)
      row.appendChild(cb)
      const span = document.createElement('span'); renderText(span, d)
      row.appendChild(span)
      approvalEl.appendChild(row)
    }
    const approveBtn = document.createElement('button'); approveBtn.textContent = '確認執行'
    approveBtn.onclick = () => {
      // 在核取方塊仍在 DOM 上的當下就擷取勾選狀態，往後傳遞——見 doConfirm 頂端註解。
      const keys = checkedKeys()
      if (currentActionType && HIGH_RISK_ACTIONS.includes(currentActionType)) showHighRiskConfirm(keys)
      else void doConfirm('approve', keys)
    }
    const rejectBtn = document.createElement('button'); rejectBtn.textContent = '拒絕'
    rejectBtn.onclick = () => { void doConfirm('reject', checkedKeys()) }
    approvalEl.appendChild(approveBtn)
    approvalEl.appendChild(rejectBtn)
  }

  function applyView(rec: any, env: any): void {
    changesetId = rec.changeset_id
    statusEl.textContent = `狀態：${rec.status ?? '未知'}`
    currentActionType = rec.action_type
    currentNonce = rec.nonce
    currentDiffVersion = rec.diff_version
    renderDiff(env)
    renderApprovalControls()
  }

  async function refresh(): Promise<'ok' | 'stop' | 'rate'> {
    if (!changesetId) return 'ok'
    try {
      const r = await app.callServerTool({ name: 'app_get_changeset_view', arguments: { changeset_id: changesetId } })
      const env = (r as any).structuredContent ?? {}
      const rec = env.items?.[0]
      if (!rec) return 'stop' // 找不到記錄（如 NOT_FOUND 回 items: []），沒有東西可等，停止輪詢
      applyView(rec, env)
      if (TERMINAL_STATUSES.includes(rec.status)) return 'stop'
      return 'ok'
    } catch { return 'rate' }
  }

  function startPolling(status: string) {
    stopPolling?.()
    stopPolling = undefined
    if (status === 'executing') stopPolling = backoffPoll(refresh, { baseMs: 3000 })
    else if (status === 'pending_approval') stopPolling = backoffPoll(refresh, { baseMs: 20000 })
  }

  app.ontoolresult = params => {
    try {
      const env = (params as any).structuredContent ?? {}
      const rec = env.items?.[0] ?? {}
      applyView(rec, env)
      if (TERMINAL_STATUSES.includes(rec.status)) { stopPolling?.(); stopPolling = undefined }
      else startPolling(rec.status)
    } catch (e) { showFallback('渲染失敗：' + String(e)) }
  }
}).catch(e => showFallback('無法連上 host：' + String(e)))
