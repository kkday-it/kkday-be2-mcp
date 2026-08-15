// src/ui/panelShared.ts — 面板 iframe 內執行
import { App } from '@modelcontextprotocol/ext-apps'

export async function connectApp(name: string): Promise<App> {
  if (typeof window !== 'undefined' && (window as any).__DEV_APP_SHIM__) {
    const devApp = {
      callServerTool: async (params: { name: string; arguments: any }) => {
        const res = await fetch('/dev/panel-tool', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params)
        })
        return res.json()
      },
      ontoolresult: undefined as any
    }
    setTimeout(() => {
      if (devApp.ontoolresult) {
        const p = new URLSearchParams(window.location.search)
        const prod_oids = p.get('prod_oids')?.split(',').filter(Boolean)
        const items: Record<string, unknown> = {}
        if (p.has('action_type')) items.action_type = p.get('action_type')
        if (prod_oids) items.prod_oids = prod_oids
        devApp.ontoolresult({ structuredContent: { items: [items] } })
      }
    }, 0)
    return devApp as unknown as App
  }
  const app = new App({ name, version: '0.1.0' })
  await app.connect()
  return app
}

// be2 內容一律當純文字塞，杜絕 HTML 注入（Global Constraints）。
export function renderText(el: HTMLElement, s: unknown): void {
  el.textContent = typeof s === 'string' ? s : JSON.stringify(s)
}

// 指數退避輪詢：rate 錯誤時 3s→6s→12s（cap 30s），成功則回基準間隔。
export function backoffPoll(
  tick: () => Promise<'ok' | 'stop' | 'rate'>,
  opts: { baseMs?: number; capMs?: number } = {},
): () => void {
  const base = opts.baseMs ?? 3000, cap = opts.capMs ?? 30000
  let delay = base, stopped = false, timer: ReturnType<typeof setTimeout>
  const loop = async () => {
    if (stopped) return
    const r = await tick().catch(() => 'rate' as const)
    if (r === 'stop') return
    delay = r === 'rate' ? Math.min(delay * 2, cap) : base
    timer = setTimeout(loop, delay)
  }
  void loop()
  return () => { stopped = true; clearTimeout(timer) }
}
