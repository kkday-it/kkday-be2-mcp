import type Database from 'better-sqlite3'
import { RateError } from '../errors.js'

const RETENTION_MS = 3 * 24 * 3600_000

export class RateBudget {
  private perSession: number
  private perUserDay: number
  private now: () => number

  constructor(private db: Database.Database,
    opts: { perSession?: number; perUserDay?: number; now?: () => number } = {}) {
    this.perSession = opts.perSession ?? 100
    this.perUserDay = opts.perUserDay ?? 500
    this.now = opts.now ?? Date.now
  }

  // Keys are naturally single-window (session ids never recur; day keys embed the date),
  // so window_start records creation time for retention purposes only.
  private bump(key: string): number {
    this.db.prepare(`
      INSERT INTO rate_counters (counter_key, count, window_start) VALUES (?, 1, ?)
      ON CONFLICT(counter_key) DO UPDATE SET count = count + 1
    `).run(key, this.now())
    return (this.db.prepare('SELECT count FROM rate_counters WHERE counter_key = ?').get(key) as { count: number }).count
  }

  consume(userLabel: string, sessionId: string): void {
    // Bounded table: drop counters past retention (sessions long gone; day keys stale).
    this.db.prepare('DELETE FROM rate_counters WHERE window_start < ?').run(this.now() - RETENTION_MS)
    const day = new Date(this.now()).toISOString().slice(0, 10)
    const sessionCount = this.bump(`session:${sessionId}`)
    const dayCount = this.bump(`user:${userLabel}:${day}`)
    if (sessionCount > this.perSession) {
      throw new RateError('RATE_SESSION',
        `Session read budget exhausted (${this.perSession}/session). Start a new session, or narrow the query (batch oids into fewer calls).`, 429)
    }
    if (dayCount > this.perUserDay) {
      throw new RateError('RATE_USER_DAY',
        `Daily read budget exhausted (${this.perUserDay}/day) for this user. Try again tomorrow or contact the be2-mcp owner.`, 429)
    }
  }
}
