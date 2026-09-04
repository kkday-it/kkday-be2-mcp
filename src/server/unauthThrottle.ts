// G3 防灌爆（spec §3.4）：401 嘗試的 audit 寫入本身不得成為 DoS 放大面。
// L1 per-IP：分桶粒度（同 IP 60s 窗只落第一筆）。map 滿時停收新 IP（不清空——
// 清空會被偽造 XFF 連續觸發、throttle 形同虛設），新 IP 直接交給 L2。
// L2 全域天花板：與 IP 無關的絕對上界；XFF 不可信時仍成立。
interface IpEntry { windowStart: number; suppressed: number }

export class UnauthThrottle {
  private ips = new Map<string, IpEntry>()
  private minuteStart = 0
  private minuteCount = 0
  private globalSuppressed = 0
  private windowMs: number
  private maxIps: number
  private globalPerMinute: number
  private now: () => number

  constructor(opts: { windowMs?: number; maxIps?: number; globalPerMinute?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? 60_000
    this.maxIps = opts.maxIps ?? 1024
    this.globalPerMinute = opts.globalPerMinute ?? 60
    this.now = opts.now ?? Date.now
  }

  admit(ip: string): { admit: boolean; note?: string } {
    const now = this.now()
    const notes: string[] = []

    // --- L1 per-IP ---
    const entry = this.ips.get(ip)
    if (entry) {
      if (now - entry.windowStart < this.windowMs) { entry.suppressed++; return { admit: false } }
      if (entry.suppressed > 0) notes.push(`suppressed=${entry.suppressed}`)
      entry.windowStart = now; entry.suppressed = 0
    } else if (this.ips.size < this.maxIps) {
      this.ips.set(ip, { windowStart: now, suppressed: 0 })
    }
    // map 滿且是新 IP：無 entry、不建 entry，直接走 L2。

    // --- L2 global ceiling ---
    if (now - this.minuteStart >= 60_000) {
      if (this.globalSuppressed > 0) notes.push(`global_suppressed=${this.globalSuppressed}`)
      this.minuteStart = now; this.minuteCount = 0; this.globalSuppressed = 0
    }
    if (this.minuteCount >= this.globalPerMinute) { this.globalSuppressed++; return { admit: false } }
    this.minuteCount++
    return { admit: true, note: notes.length ? notes.join(' ') : undefined }
  }
}
