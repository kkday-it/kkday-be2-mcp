import type Database from 'better-sqlite3'
import type { AnyDiffItem, ChangeSetRecord, ChangeSetStatus, ItemResult, ExecutorRef } from './types.js'

export class ChangeSetStore {
  private now: () => number
  private ttlMs: number

  constructor(private db: Database.Database, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? 24 * 3600_000
  }

  create(rec: ChangeSetRecord): void {
    this.db.prepare(`
      INSERT INTO change_sets (id, creator_label, creator_bearer_hash, session_id, action_type, items_json, diff_json, diff_version, note, status, created_at, decided_at, execute_at_utc, schedule_wall, schedule_tz)
      VALUES (@id,@creatorLabel,@creatorBearerHash,@sessionId,@actionType,@itemsJson,@diffJson,@diffVersion,@note,@status,@createdAt,@decidedAt,@executeAtUtc,@scheduleWall,@scheduleTz)
    `).run({
      ...rec,
      note: rec.note ?? null,
      decidedAt: rec.decidedAt ?? null,
      itemsJson: JSON.stringify(rec.items),
      diffJson: JSON.stringify(rec.diff),
      executeAtUtc: rec.schedule?.executeAtUtc ?? null,
      scheduleWall: rec.schedule?.wall ?? null,
      scheduleTz: rec.schedule?.tz ?? null,
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
      createdAt: r.created_at as number,
      decidedAt: (r.decided_at as number) ?? undefined,
      schedule: r.execute_at_utc != null ? { executeAtUtc: r.execute_at_utc as number, wall: r.schedule_wall as string, tz: r.schedule_tz as string } : undefined,
      executorRef: r.executor_identity_id != null ? { identityId: r.executor_identity_id as string, userLabel: r.executor_label as string, modifyUser: r.executor_modify_user as string, sessionId: r.executor_session_id as string } : undefined,
      scheduleClaimedAt: r.schedule_claimed_at != null ? (r.schedule_claimed_at as number) : undefined,
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

  // Final whole-branch review Important 2: the panel path (app_get_changeset_view) reads
  // rec.diff/rec.diffVersion straight off the store — unlike the confirm page's GET (which always
  // recomputes a live diff), it never recomputed anything itself, so a DIFF_STALE response from
  // approveAndExecute had no way to ever converge — every subsequent view/approval attempt would
  // keep reading the SAME stale creation-time diff/version forever. approveAndExecute now calls
  // this to persist the diff it just recomputed (the one that caused the staleness detection) back
  // into the store, so the next read is fresh. Restricted to WHERE status = 'pending_approval' —
  // same discipline as casStatus — so a race against a concurrent approve/reject/expiry can never
  // resurrect/overwrite a change-set that has already left pending_approval. Returns whether the
  // write happened (false is not currently acted upon by any caller, but mirrors casStatus's
  // signature for consistency and so a future caller can detect the race without a separate read).
  updateDiff(id: string, diff: AnyDiffItem[], diffVersion: string): boolean {
    const result = this.db.prepare('UPDATE change_sets SET diff_json = ?, diff_version = ? WHERE id = ? AND status = ?')
      .run(JSON.stringify(diff), diffVersion, id, 'pending_approval')
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
    const rows = this.db.prepare('SELECT * FROM change_set_results WHERE changeset_id = ? ORDER BY item_key').all(id) as Array<Record<string, unknown>>
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

  setScheduled(id: string, executor: ExecutorRef, decidedAt: number): boolean {
    const r = this.db.prepare(`UPDATE change_sets SET status='scheduled', decided_at=?,
      executor_identity_id=?, executor_label=?, executor_modify_user=?, executor_session_id=?
      WHERE id=? AND status='pending_approval'`)
      .run(decidedAt, executor.identityId, executor.userLabel, executor.modifyUser, executor.sessionId, id)
    return r.changes === 1
  }

  listDueScheduled(nowMs: number): string[] {
    return (this.db.prepare(`SELECT id FROM change_sets WHERE status='scheduled' AND execute_at_utc <= ? ORDER BY execute_at_utc`)
      .all(nowMs) as Array<{ id: string }>).map(r => r.id)
  }

  claimScheduled(id: string, nowMs: number): boolean {
    return this.db.prepare(`UPDATE change_sets SET status='approved', schedule_claimed_at=? WHERE id=? AND status='scheduled'`)
      .run(nowMs, id).changes === 1
  }

  releaseClaim(id: string): boolean {
    return this.db.prepare(`UPDATE change_sets SET status='scheduled' WHERE id=? AND status='approved'`).run(id).changes === 1
  }

  listStrandedApproved(nowMs: number, staleClaimMs: number): string[] {
    return (this.db.prepare(`SELECT id FROM change_sets WHERE status='approved' AND execute_at_utc IS NOT NULL
      AND schedule_claimed_at IS NOT NULL AND schedule_claimed_at < ?`).all(nowMs - staleClaimMs) as Array<{ id: string }>).map(r => r.id)
  }

  listScheduledIdentityIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT executor_identity_id AS iid FROM change_sets
      WHERE status='scheduled' AND executor_identity_id IS NOT NULL`).all() as Array<{ iid: string }>).map(r => r.iid)
  }

  listScheduledIdsByIdentity(identityId: string): string[] {
    return (this.db.prepare(`SELECT id FROM change_sets WHERE status='scheduled' AND executor_identity_id = ?`)
      .all(identityId) as Array<{ id: string }>).map(r => r.id)
  }

  // spec §7：啟動時對 stranded executing 記 audit 警示。`executing` + execute_at_utc 非 null 代表
  // 上次 process 掛掉時，這件排程件正在寫入途中——可能已部分寫入，無法自動判斷/復原，只能留給
  // 人工複核（見 scheduler.ts auditStranded）。
  listExecutingScheduled(): string[] {
    return (this.db.prepare(`SELECT id FROM change_sets WHERE status='executing' AND execute_at_utc IS NOT NULL`)
      .all() as Array<{ id: string }>).map(r => r.id)
  }
}
