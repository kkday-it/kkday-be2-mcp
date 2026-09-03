import type { Db } from '../store/dbTypes.js'

export interface AuditEntry {
  userLabel: string; sessionId: string; clientInfo: string; tool: string
  params: unknown; status: 'ok' | 'error' | 'denied_rate' | 'denied_auth'
  errorMessage?: string; traceId: string; durationMs: number
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*)?/g

export class AuditLog {
  constructor(private db: Db, private now: () => number = Date.now) {}

  async record(e: AuditEntry): Promise<void> {
    const paramsJson = JSON.stringify(e.params ?? {}).replace(JWT_RE, '[REDACTED_TOKEN]')
    await this.db.query(`
      INSERT INTO audit_log (ts, user_label, session_id, client_info, tool, params_json, status, error_message, trace_id, duration_ms)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [this.now(), e.userLabel, e.sessionId, e.clientInfo, e.tool, paramsJson, e.status, e.errorMessage ?? null, e.traceId, e.durationMs])
  }

  async recent(limit = 50): Promise<Array<AuditEntry & { ts: number }>> {
    const rows = (await this.db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit])).rows as Array<Record<string, unknown>>
    return rows.map(r => ({
      ts: r.ts as number, userLabel: r.user_label as string, sessionId: r.session_id as string,
      clientInfo: r.client_info as string, tool: r.tool as string, params: JSON.parse(r.params_json as string),
      status: r.status as AuditEntry['status'], errorMessage: (r.error_message as string) ?? undefined,
      traceId: r.trace_id as string, durationMs: r.duration_ms as number,
    }))
  }
}
