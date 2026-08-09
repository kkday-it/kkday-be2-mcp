import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { ChangeSetRecord, ChangeSetStatus, ItemResult } from './types.js'

export class ChangeSetStore {
  private now: () => number
  private ttlMs: number

  constructor(private db: Database.Database, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? 24 * 3600_000
  }

  static hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex')
  }

  create(rec: ChangeSetRecord): void {
    this.db.prepare(`
      INSERT INTO change_sets (id, creator_label, creator_bearer_hash, session_id, action_type, items_json, diff_json, diff_version, note, status, approval_token_hash, created_at, decided_at)
      VALUES (@id,@creatorLabel,@creatorBearerHash,@sessionId,@actionType,@itemsJson,@diffJson,@diffVersion,@note,@status,@approvalTokenHash,@createdAt,@decidedAt)
    `).run({
      ...rec,
      note: rec.note ?? null,
      decidedAt: rec.decidedAt ?? null,
      itemsJson: JSON.stringify(rec.items),
      diffJson: JSON.stringify(rec.diff),
    })
  }

  get(id: string): ChangeSetRecord | undefined {
    const r = this.db.prepare('SELECT * FROM change_sets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) return undefined
    let status = r.status as ChangeSetStatus
    if (status === 'pending_approval' && (r.created_at as number) + this.ttlMs < this.now()) {
      this.db.prepare('UPDATE change_sets SET status = ? WHERE id = ?').run('expired', id)
      status = 'expired'
    }
    return {
      id: r.id as string,
      creatorLabel: r.creator_label as string,
      creatorBearerHash: r.creator_bearer_hash as string,
      sessionId: r.session_id as string,
      actionType: r.action_type as ChangeSetRecord['actionType'],
      items: JSON.parse(r.items_json as string),
      diff: JSON.parse(r.diff_json as string),
      diffVersion: r.diff_version as string,
      note: (r.note as string) ?? undefined,
      status,
      approvalTokenHash: r.approval_token_hash as string,
      createdAt: r.created_at as number,
      decidedAt: (r.decided_at as number) ?? undefined,
    }
  }

  setStatus(id: string, status: ChangeSetStatus, decidedAt?: number): void {
    this.db.prepare('UPDATE change_sets SET status = ?, decided_at = COALESCE(?, decided_at) WHERE id = ?')
      .run(status, decidedAt ?? null, id)
  }

  // Atomic compare-and-swap: only transitions `from` -> `to` if the row is STILL `from` at the
  // moment of the UPDATE (single statement, no read-then-write race window). Returns true iff this
  // call won the transition. This is the primitive that makes approve/reject execute-exactly-once
  // safe under concurrent requests (double-click, client retry) — see confirmRoutes.ts.
  casStatus(id: string, from: ChangeSetStatus, to: ChangeSetStatus, decidedAt?: number): boolean {
    const result = this.db.prepare('UPDATE change_sets SET status = ?, decided_at = COALESCE(?, decided_at) WHERE id = ? AND status = ?')
      .run(to, decidedAt ?? null, id, from)
    return result.changes === 1
  }

  recordResults(id: string, results: ItemResult[]): void {
    const ins = this.db.prepare(`
      INSERT OR REPLACE INTO change_set_results (changeset_id, item_key, status, before_json, after_json, error_code, error_message, trace_id)
      VALUES (?,?,?,?,?,?,?,?)`)
    const tx = this.db.transaction((rs: ItemResult[]) => {
      for (const r of rs) {
        ins.run(
          id,
          r.item_key,
          r.status,
          r.before === undefined ? null : JSON.stringify(r.before),
          r.after === undefined ? null : JSON.stringify(r.after),
          r.error_code ?? null,
          r.error_message ?? null,
          r.trace_id
        )
      }
    })
    tx(results)
  }

  getResults(id: string): ItemResult[] {
    const rows = this.db.prepare('SELECT * FROM change_set_results WHERE changeset_id = ?').all(id) as Array<Record<string, unknown>>
    return rows.map(r => ({
      item_key: r.item_key as string,
      status: r.status as ItemResult['status'],
      before: r.before_json ? JSON.parse(r.before_json as string) : undefined,
      after: r.after_json ? JSON.parse(r.after_json as string) : undefined,
      error_code: (r.error_code as string) ?? undefined,
      error_message: (r.error_message as string) ?? undefined,
      trace_id: r.trace_id as string,
    }))
  }
}
