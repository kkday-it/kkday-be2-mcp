import { connectApp, renderText, backoffPoll } from './panelShared.js'

// 終態清單：抽成單一常數，refresh() 與 ontoolresult 都用它，避免兩處漏加同一狀態而導致無限輪詢。
const TERMINAL_STATUSES = ['done', 'partial', 'failed', 'rejected', 'expired']

const statusEl = document.getElementById('status')!
const bodyEl = document.getElementById('body')!
const fallback = document.getElementById('fallback') as HTMLPreElement
function showFallback(m: string) { fallback.hidden = false; fallback.textContent = m }

function renderDiff(env: any) {
  const items: any[] = env.items?.[0]?.diff?.items ?? env.diff?.items ?? []
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

  const btn = document.createElement('button'); btn.textContent = '前往核准（確認頁）'
  btn.onclick = async () => {
    if (!changesetId) return
    const r = await app.callServerTool({ name: 'app_get_confirm_link', arguments: { changeset_id: changesetId } })
    const env = (r as any).structuredContent ?? {}
    const url = env.items?.[0]?.confirm_url
    if (url) { const o = await app.openLink({ url }); if (o.isError) showFallback('host 拒絕開啟連結：' + url) }
  }
  document.body.appendChild(btn)

  async function refresh(): Promise<'ok' | 'stop' | 'rate'> {
    if (!changesetId) return 'ok'
    try {
      const r = await app.callServerTool({ name: 'app_get_changeset_view', arguments: { changeset_id: changesetId } })
      const env = (r as any).structuredContent ?? {}
      const rec = env.items?.[0]
      if (!rec) return 'stop' // 找不到記錄（如 NOT_FOUND 回 items: []），沒有東西可等，停止輪詢
      statusEl.textContent = `狀態：${rec.status}`
      renderDiff(env)
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
      changesetId = rec.changeset_id
      statusEl.textContent = `狀態：${rec.status ?? '未知'}`
      renderDiff(env)
      if (TERMINAL_STATUSES.includes(rec.status)) { stopPolling?.(); stopPolling = undefined }
      else startPolling(rec.status)
    } catch (e) { showFallback('渲染失敗：' + String(e)) }
  }
}).catch(e => showFallback('無法連上 host：' + String(e)))
