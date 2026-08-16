import { RateError } from '../errors.js'

// 面板輪詢用的獨立限流 —— 與 LLM 工具的 RateBudget 完全分離（後者 100/session 是防 LLM
// runaway 用，會被面板每 3s 輪詢燒光）。in-memory sliding window：面板 call 是短命、UI 級，
// 重啟遺失無所謂。預設 120/min 容 5-6 個活躍面板併發輪詢，仍擋 bug 迴圈。
export class AppRateBudget {
  private hits = new Map<string, number[]>()
  private perMinute: number
  private now: () => number
  constructor(opts: { perMinute?: number; now?: () => number } = {}) {
    this.perMinute = opts.perMinute ?? 120
    this.now = opts.now ?? Date.now
  }
  consume(sessionId: string): void {
    const t = this.now()
    const win = (this.hits.get(sessionId) ?? []).filter(ts => t - ts < 60_000)
    win.push(t)
    this.hits.set(sessionId, win)
    if (win.length > this.perMinute) {
      throw new RateError('RATE_APP', `Panel call budget exhausted (${this.perMinute}/min). The panel will retry with backoff.`, 429)
    }
  }
  // 防記憶體洩漏：session 關閉時由 app.ts 的 onsessionclosed 呼叫，清掉該 session 的時間戳陣列。
  release(sessionId: string): void { this.hits.delete(sessionId) }
}
