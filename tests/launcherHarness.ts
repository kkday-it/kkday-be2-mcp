// 執行 POPUP launcher 過場頁（/confirm/login、/oauth/authorize）的 inline <script>，
// 用 stub 的 window/document/fetch/location 跑真 JS，讓測試能對「收到 postMessage 之後的
// 行為」做斷言——而不是 grep HTML 字串。動機：be2-auth 登入 popup 的 CONFIRM_LOGIN_DOMAIN
// 握手（LoginPage.vue validatePopupPageSource，500ms 內不回就 client-route /404）是純
// client-side 行為，字串斷言測不到「有沒有回、回給誰、targetOrigin 對不對」。

export interface PostedMessage { data: unknown; targetOrigin: string }

export interface FakePopup {
  posted: PostedMessage[]
  closed: boolean
  postMessage: (data: unknown, targetOrigin: string) => void
  close: () => void
}

interface FakeElement {
  textContent: string
  addEventListener: (type: string, fn: () => void) => void
  fire: (type: string) => void
}

export interface LauncherPage {
  /** 觸發 loginBtn click（window.open 在 click handler 裡），回傳被開啟的 popup stub */
  clickLogin: () => FakePopup
  /** 對頁面 dispatch 一個 message 事件（模擬 popup postMessage 到 opener） */
  dispatchMessage: (e: { origin: string; source?: unknown; data: unknown }) => void
  msgText: () => string
}

export function runLauncherScript(
  html: string,
  opts: { fetchImpl?: (...args: unknown[]) => Promise<unknown> } = {},
): LauncherPage {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('launcher page has no inline <script>')

  const messageListeners: Array<(e: unknown) => void> = []
  const els = new Map<string, FakeElement>()
  const el = (id: string): FakeElement => {
    let existing = els.get(id)
    if (!existing) {
      const handlers = new Map<string, Array<() => void>>()
      existing = {
        textContent: '',
        addEventListener: (type, fn) => { handlers.set(type, [...(handlers.get(type) ?? []), fn]) },
        fire: type => { for (const fn of handlers.get(type) ?? []) fn() },
      }
      els.set(id, existing)
    }
    return existing
  }

  const popup: FakePopup = {
    posted: [],
    closed: false,
    postMessage: (data, targetOrigin) => { popup.posted.push({ data, targetOrigin }) },
    close: () => { popup.closed = true },
  }
  const windowStub = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') messageListeners.push(fn)
    },
    open: () => popup,
  }
  const documentStub = { getElementById: (id: string) => el(id) }
  // 預設 fetch 永不 resolve：握手測試不該走到 fetch，走到就會 hang 在 promise 裡不影響斷言
  const fetchStub = opts.fetchImpl ?? (() => new Promise<never>(() => { /* never resolves */ }))
  const locationStub = { replace: () => { /* noop */ } }

  // eslint 風格註：這裡刻意用 new Function 執行「我們自己 server 剛渲染出來的頁面 JS」，
  // 輸入不是外部資料。
  new Function('window', 'document', 'fetch', 'location', m[1])(windowStub, documentStub, fetchStub, locationStub)

  return {
    clickLogin: () => { el('loginBtn').fire('click'); return popup },
    dispatchMessage: e => { for (const fn of messageListeners) fn(e) },
    msgText: () => el('msg').textContent,
  }
}
