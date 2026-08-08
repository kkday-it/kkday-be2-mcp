import type Database from 'better-sqlite3'

// Spec §6.2 scope-binding substrate: which oids each MCP session actually read.
// Phase 2's be2_create_changeset gate rejects items outside this set.
export class ReadOidStore {
  private retentionMs: number
  private now: () => number

  constructor(private db: Database.Database, opts: { retentionMs?: number; now?: () => number } = {}) {
    this.retentionMs = opts.retentionMs ?? 24 * 3600_000
    this.now = opts.now ?? Date.now
  }

  record(sessionId: string, oids: string[]): void {
    this.db.prepare('DELETE FROM session_read_oids WHERE recorded_at < ?').run(this.now() - this.retentionMs)
    const ins = this.db.prepare('INSERT OR IGNORE INTO session_read_oids (session_id, oid, recorded_at) VALUES (?, ?, ?)')
    const tx = this.db.transaction((rows: string[]) => { for (const oid of rows) ins.run(sessionId, oid, this.now()) })
    tx(oids)
  }

  has(sessionId: string, oid: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM session_read_oids WHERE session_id = ? AND oid = ?').get(sessionId, oid)
  }

  list(sessionId: string): string[] {
    return (this.db.prepare('SELECT oid FROM session_read_oids WHERE session_id = ?').all(sessionId) as Array<{ oid: string }>)
      .map(r => r.oid)
  }
}
