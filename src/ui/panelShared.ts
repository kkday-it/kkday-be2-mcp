// src/ui/panelShared.ts — 面板 iframe 內執行
import { App } from '@modelcontextprotocol/ext-apps'

export async function connectApp(name: string): Promise<App> {
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
