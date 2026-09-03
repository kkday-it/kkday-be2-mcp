import type { Db } from './dbTypes.js'

// Spec §6.2 scope-binding substrate: which oids each MCP session actually read.
// Phase 2's be2_create_changeset gate rejects items outside this set.
export class ReadOidStore {
  private retentionMs: number
  private now: () => number

  constructor(private db: Db, opts: { retentionMs?: number; now?: () => number } = {}) {
    this.retentionMs = opts.retentionMs ?? 24 * 3600_000
    this.now = opts.now ?? Date.now
  }

  async record(sessionId: string, oids: string[]): Promise<void> {
    await this.db.query('DELETE FROM session_read_oids WHERE recorded_at < $1', [this.now() - this.retentionMs])
    await this.db.transaction(async (tx) => {
      for (const oid of oids) {
        await tx.query(
          'INSERT INTO session_read_oids (session_id, oid, recorded_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [sessionId, oid, this.now()])
      }
    })
  }

  async has(sessionId: string, oid: string): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM session_read_oids WHERE session_id = $1 AND oid = $2', [sessionId, oid])
    return r.rows.length > 0
  }

  async list(sessionId: string): Promise<string[]> {
    return (await this.db.query<{ oid: string }>('SELECT oid FROM session_read_oids WHERE session_id = $1', [sessionId]))
      .rows.map(r => r.oid)
  }
}
