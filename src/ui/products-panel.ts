import { connectApp, renderText } from './panelShared.js'

const list = document.getElementById('list')!
const count = document.getElementById('count')!
const fallback = document.getElementById('fallback') as HTMLPreElement

function showFallback(msg: string) { fallback.hidden = false; fallback.textContent = msg }

connectApp('be2-products-panel').then(app => {
  app.ontoolresult = params => {
    try {
      const env = (params as any).structuredContent ?? {}
      const items: any[] = env.items ?? []
      const errors: any[] = env.errors ?? []
      list.textContent = ''
      for (const it of items) {
        const card = document.createElement('div'); card.className = 'card'
        renderText(card, it)        // 純文字，杜絕注入
        list.appendChild(card)
      }
      for (const e of errors) {
        const row = document.createElement('div'); row.className = 'err'
        renderText(row, `${e.key}: ${e.message}`); list.appendChild(row)
      }
      count.textContent = `已載入 ${items.length} 筆` + (errors.length ? `，${errors.length} 筆錯誤` : '')
    } catch (e) { showFallback('面板渲染失敗：' + String(e)) }
  }
}).catch(e => showFallback('無法連上 host：' + String(e)))
