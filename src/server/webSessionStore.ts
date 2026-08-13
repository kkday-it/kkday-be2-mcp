import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'

// Task 4: this row no longer carries the display userLabel directly — it carries the
// identity_id the session's be2mcp_sid cookie was minted for (agy round-1: overloading the old
// `user_label` column to hold an identity reference would have been semantic pollution). The
// authoritative userLabel now always comes from the credential/identity chain
// (credentials.getBySecret -> identities.get, or TokenManager.getFreshByCredHash which already
// resolves it) — see confirmRoutes.ts's requireSession.
export interface WebSession { sessionId: string; identityId: string; createdAt: number; lastSeenAt: number }

export class WebSessionStore {
  private now: () => number
  private idleTtlMs: number
  // Phase 2b fix: session teardown must also purge the be2 token this session owns (in
  // user_tokens, keyed by hash(sessionId) — see ssoRoutes.ts). Rather than duplicate that
  // knowledge here, delete() (the single row-removal path — idle-expiry in get() delegates to
  // it too) notifies this optional callback so the caller (app.ts) can wire up the purge without
  // WebSessionStore needing to know about TokenStore.
  private onDelete?: (sessionId: string) => void
  constructor(private db: Database.Database, opts: { now?: () => number; idleTtlMs?: number; onDelete?: (sessionId: string) => void } = {}) {
    this.now = opts.now ?? Date.now
    this.idleTtlMs = opts.idleTtlMs ?? 8 * 3600_000
    this.onDelete = opts.onDelete
  }
  static newSessionId(): string { return randomBytes(32).toString('hex') }

  create(sessionId: string, identityId: string): void {
    const t = this.now()
    this.db.prepare('INSERT OR REPLACE INTO web_sessions (session_id, identity_id, created_at, last_seen_at) VALUES (?,?,?,?)')
      .run(sessionId, identityId, t, t)
  }
  get(sessionId: string): WebSession | undefined {
    const r = this.db.prepare('SELECT * FROM web_sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined
    if (!r) return undefined
    if ((r.last_seen_at as number) + this.idleTtlMs < this.now()) { this.delete(sessionId); return undefined }
    return { sessionId: r.session_id as string, identityId: r.identity_id as string, createdAt: r.created_at as number, lastSeenAt: r.last_seen_at as number }
  }
  touch(sessionId: string): void {
    this.db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE session_id = ?').run(this.now(), sessionId)
  }
  delete(sessionId: string): void {
    this.db.prepare('DELETE FROM web_sessions WHERE session_id = ?').run(sessionId)
    this.onDelete?.(sessionId)
  }
}
