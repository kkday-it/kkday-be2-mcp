import { connectApp, renderText } from './panelShared.js'

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
  app.ontoolresult = params => {
    try {
      const env = (params as any).structuredContent ?? {}
      const rec = env.items?.[0] ?? {}
      statusEl.textContent = `狀態：${rec.status ?? '未知'}`
      renderDiff(env)
    } catch (e) { showFallback('渲染失敗：' + String(e)) }
  }
}).catch(e => showFallback('無法連上 host：' + String(e)))
