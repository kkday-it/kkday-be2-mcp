import type { Db } from '../../store/dbTypes.js'
import type { AnyDiffItem, ChangeSetRecord, ChangeSetStatus, ItemResult, ExecutorRef } from './types.js'

export class ChangeSetStore {
  private now: () => number
  private ttlMs: number

  constructor(private db: Db, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? 24 * 3600_000
  }

  async create(rec: ChangeSetRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO change_sets (id, creator_label, creator_bearer_hash, session_id, action_type, items_json, diff_json, diff_version, note, status, created_at, decided_at, execute_at_utc, schedule_wall, schedule_tz)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        rec.id,
        rec.creatorLabel,
        rec.creatorBearerHash,
        rec.sessionId,
        rec.actionType,
        JSON.stringify(rec.items),
        JSON.stringify(rec.diff),
        rec.diffVersion,
        rec.note ?? null,
        rec.status,
        rec.createdAt,
        rec.decidedAt ?? null,
        rec.schedule?.executeAtUtc ?? null,
        rec.schedule?.wall ?? null,
        rec.schedule?.tz ?? null,
      ])
  }

  // lazy expiry：原 read-then-write（get 後判斷再 UPDATE）在 async 下有交錯窗口 →
  // 改單條條件式 UPDATE 先行，再 SELECT（spec §3.3）。UPDATE 冪等、輸掉 race 也無害。
  async get(id: string): Promise<ChangeSetRecord | undefined> {
    await this.db.query(
      `UPDATE change_sets SET status = 'expired' WHERE id = $1 AND status = 'pending_approval' AND created_at + $2 < $3`,
      [id, this.ttlMs, this.now()])
    const r = (await this.db.query(`SELECT * FROM change_sets WHERE id = $1`, [id])).rows[0] as Record<string, unknown> | undefined
    if (!r) return undefined
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
      status: r.status as ChangeSetStatus,
      createdAt: r.created_at as number,
      decidedAt: (r.decided_at as number) ?? undefined,
      schedule: r.execute_at_utc != null ? { executeAtUtc: r.execute_at_utc as number, wall: r.schedule_wall as string, tz: r.schedule_tz as string } : undefined,
      executorRef: r.executor_identity_id != null ? { identityId: r.executor_identity_id as string, userLabel: r.executor_label as string, modifyUser: r.executor_modify_user as string, sessionId: r.executor_session_id as string, traceId: (r.executor_trace_id as string) ?? undefined } : undefined,
      scheduleClaimedAt: r.schedule_claimed_at != null ? (r.schedule_claimed_at as number) : undefined,
    }
  }

  async setStatus(id: string, status: ChangeSetStatus, decidedAt?: number): Promise<void> {
    await this.db.query('UPDATE change_sets SET status = $1, decided_at = COALESCE($2, decided_at) WHERE id = $3',
      [status, decidedAt ?? null, id])
  }

  // Atomic compare-and-swap: only transitions `from` -> `to` if the row is STILL `from` at the
  // moment of the UPDATE (single statement, no read-then-write race window). Returns true iff this
  // call won the transition. This is the primitive that makes approve/reject execute-exactly-once
  // safe under concurrent requests (double-click, client retry) — see confirmRoutes.ts.
  async casStatus(id: string, from: ChangeSetStatus, to: ChangeSetStatus, decidedAt?: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE change_sets SET status = $1, decided_at = COALESCE($2, decided_at) WHERE id = $3 AND status = $4`,
      [to, decidedAt ?? null, id, from])
    return r.rowCount === 1
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
  async updateDiff(id: string, diff: AnyDiffItem[], diffVersion: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE change_sets SET diff_json = $1, diff_version = $2 WHERE id = $3 AND status = $4`,
      [JSON.stringify(diff), diffVersion, id, 'pending_approval'])
    return r.rowCount === 1
  }

  async recordResults(id: string, results: ItemResult[]): Promise<void> {
    const SQL = `INSERT INTO change_set_results (changeset_id, item_key, status, before_json, after_json, error_code, error_message, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (changeset_id, item_key) DO UPDATE SET status=EXCLUDED.status, before_json=EXCLUDED.before_json,
      after_json=EXCLUDED.after_json, error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message, trace_id=EXCLUDED.trace_id`
    await this.db.transaction(async (tx) => {
      for (const r of results) {
        await tx.query(SQL, [id, r.item_key, r.status,
          r.before === undefined ? null : JSON.stringify(r.before),
          r.after === undefined ? null : JSON.stringify(r.after),
          r.error_code ?? null, r.error_message ?? null, r.trace_id])
      }
    })
  }

  async getResults(id: string): Promise<ItemResult[]> {
    const rows = (await this.db.query('SELECT * FROM change_set_results WHERE changeset_id = $1 ORDER BY item_key', [id])).rows as Array<Record<string, unknown>>
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

  async setScheduled(id: string, executor: ExecutorRef, decidedAt: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE change_sets SET status='scheduled', decided_at=$1,
       executor_identity_id=$2, executor_label=$3, executor_modify_user=$4, executor_session_id=$5, executor_trace_id=$6
       WHERE id=$7 AND status='pending_approval'`,
      [decidedAt, executor.identityId, executor.userLabel, executor.modifyUser, executor.sessionId, executor.traceId ?? null, id])
    return r.rowCount === 1
  }

  async listDueScheduled(nowMs: number): Promise<string[]> {
    const rows = (await this.db.query(
      `SELECT id FROM change_sets WHERE status='scheduled' AND execute_at_utc <= $1 ORDER BY execute_at_utc`,
      [nowMs])).rows as Array<{ id: string }>
    return rows.map(r => r.id)
  }

  async claimScheduled(id: string, nowMs: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE change_sets SET status='approved', schedule_claimed_at=$1 WHERE id=$2 AND status='scheduled'`,
      [nowMs, id])
    return r.rowCount === 1
  }

  async releaseClaim(id: string): Promise<boolean> {
    const r = await this.db.query(`UPDATE change_sets SET status='scheduled' WHERE id=$1 AND status='approved'`, [id])
    return r.rowCount === 1
  }

  async listStrandedApproved(nowMs: number, staleClaimMs: number): Promise<string[]> {
    const rows = (await this.db.query(
      `SELECT id FROM change_sets WHERE status='approved' AND execute_at_utc IS NOT NULL
       AND schedule_claimed_at IS NOT NULL AND schedule_claimed_at < $1`,
      [nowMs - staleClaimMs])).rows as Array<{ id: string }>
    return rows.map(r => r.id)
  }

  async listScheduledIdentityIds(): Promise<string[]> {
    const rows = (await this.db.query(
      `SELECT DISTINCT executor_identity_id AS iid FROM change_sets
       WHERE status='scheduled' AND executor_identity_id IS NOT NULL`)).rows as Array<{ iid: string }>
    return rows.map(r => r.iid)
  }

  async listScheduledIdsByIdentity(identityId: string): Promise<string[]> {
    const rows = (await this.db.query(
      `SELECT id FROM change_sets WHERE status='scheduled' AND executor_identity_id = $1`,
      [identityId])).rows as Array<{ id: string }>
    return rows.map(r => r.id)
  }

  // spec §7：啟動時對 stranded executing 記 audit 警示。`executing` + execute_at_utc 非 null 代表
  // 上次 process 掛掉時，這件排程件正在寫入途中——可能已部分寫入，無法自動判斷/復原，只能留給
  // 人工複核（見 scheduler.ts auditStranded）。
  async listExecutingScheduled(): Promise<string[]> {
    const rows = (await this.db.query(
      `SELECT id FROM change_sets WHERE status='executing' AND execute_at_utc IS NOT NULL`)).rows as Array<{ id: string }>
    return rows.map(r => r.id)
  }
}
