import type Database from 'better-sqlite3'

export interface AuditEntry {
  userLabel: string; sessionId: string; clientInfo: string; tool: string
  params: unknown; status: 'ok' | 'error' | 'denied_rate' | 'denied_auth'
  errorMessage?: string; traceId: string; durationMs: number
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*)?/g

export class AuditLog {
  constructor(private db: Database.Database, private now: () => number = Date.now) {}

  record(e: AuditEntry): void {
    const paramsJson = JSON.stringify(e.params ?? {}).replace(JWT_RE, '[REDACTED_TOKEN]')
    this.db.prepare(`
      INSERT INTO audit_log (ts, user_label, session_id, client_info, tool, params_json, status, error_message, trace_id, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.now(), e.userLabel, e.sessionId, e.clientInfo, e.tool, paramsJson, e.status, e.errorMessage ?? null, e.traceId, e.durationMs)
  }

  recent(limit = 50): Array<AuditEntry & { ts: number }> {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
    return rows.map(r => ({
      ts: r.ts as number, userLabel: r.user_label as string, sessionId: r.session_id as string,
      clientInfo: r.client_info as string, tool: r.tool as string, params: JSON.parse(r.params_json as string),
      status: r.status as AuditEntry['status'], errorMessage: (r.error_message as string) ?? undefined,
      traceId: r.trace_id as string, durationMs: r.duration_ms as number,
    }))
  }
}
