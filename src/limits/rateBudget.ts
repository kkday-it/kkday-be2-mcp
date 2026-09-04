import type { Db } from '../store/dbTypes.js'
import { RateError } from '../errors.js'

const RETENTION_MS = 3 * 24 * 3600_000

export class RateBudget {
  private perSession: number
  private perUserDay: number
  private now: () => number

  constructor(private db: Db,
    opts: { perSession?: number; perUserDay?: number; now?: () => number } = {}) {
    this.perSession = opts.perSession ?? 100
    this.perUserDay = opts.perUserDay ?? 500
    this.now = opts.now ?? Date.now
  }

  // Keys are naturally single-window (session ids never recur; day keys embed the date),
  // so window_start records creation time for retention purposes only.
  private async bump(key: string): Promise<number> {
    const r = await this.db.query<{ count: number }>(`
      INSERT INTO rate_counters (counter_key, count, window_start) VALUES ($1, 1, $2)
      ON CONFLICT (counter_key) DO UPDATE SET count = rate_counters.count + 1
      RETURNING count`, [key, this.now()])
    return r.rows[0].count
  }

  async consume(userLabel: string, sessionId: string): Promise<void> {
    // Bounded table: drop counters past retention (sessions long gone; day keys stale).
    await this.db.query('DELETE FROM rate_counters WHERE window_start < $1', [this.now() - RETENTION_MS])
    const day = new Date(this.now()).toISOString().slice(0, 10)
    const sessionCount = await this.bump(`session:${sessionId}`)
    const dayCount = await this.bump(`user:${userLabel}:${day}`)
    if (sessionCount > this.perSession) {
      throw new RateError('RATE_SESSION',
        `Session read budget exhausted (${this.perSession}/session). Start a new session, or narrow the query (batch oids into fewer calls).`, 429)
    }
    if (dayCount > this.perUserDay) {
      throw new RateError('RATE_USER_DAY',
        `Daily read budget exhausted (${this.perUserDay}/day) for this user. Try again tomorrow or contact the be2-mcp owner.`, 429)
    }
  }

  async consumeChangeset(userLabel: string, perDay = 10): Promise<void> {
    await this.db.query('DELETE FROM rate_counters WHERE window_start < $1', [this.now() - RETENTION_MS])
    const day = new Date(this.now()).toISOString().slice(0, 10)
    const key = `changeset:${userLabel}:${day}`
    const n = await this.bump(key)
    if (n > perDay) {
      throw new RateError('RATE_CHANGESET_DAY',
        `Daily change-set budget exhausted (${perDay}/day). Try again tomorrow.`, 429)
    }
  }
}
