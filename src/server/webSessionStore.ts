import type { Db } from '../store/dbTypes.js'
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
  // Phase 2b fix: session teardown must also purge the be2 token this session owns (the
  // credentials/be2_identities rows keyed by hash(sessionId) — see ssoRoutes.ts). Rather than
  // duplicate that knowledge here, delete() (the single row-removal path — idle-expiry in get()
  // delegates to it too) notifies this optional callback so the caller (app.ts) can wire up the
  // purge without WebSessionStore needing to know about CredentialStore/IdentityStore.
  private onDelete?: (sessionId: string) => void | Promise<void>
  constructor(private db: Db, opts: { now?: () => number; idleTtlMs?: number; onDelete?: (sessionId: string) => void | Promise<void> } = {}) {
    this.now = opts.now ?? Date.now
    this.idleTtlMs = opts.idleTtlMs ?? 8 * 3600_000
    this.onDelete = opts.onDelete
  }
  static newSessionId(): string { return randomBytes(32).toString('hex') }

  async create(sessionId: string, identityId: string): Promise<void> {
    const t = this.now()
    await this.db.query(
      `INSERT INTO web_sessions (session_id, identity_id, created_at, last_seen_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (session_id) DO UPDATE SET identity_id=EXCLUDED.identity_id, created_at=EXCLUDED.created_at, last_seen_at=EXCLUDED.last_seen_at`,
      [sessionId, identityId, t, t])
  }
  async get(sessionId: string): Promise<WebSession | undefined> {
    const r = (await this.db.query('SELECT * FROM web_sessions WHERE session_id = $1', [sessionId])).rows[0] as Record<string, unknown> | undefined
    if (!r) return undefined
    if ((r.last_seen_at as number) + this.idleTtlMs < this.now()) { await this.delete(sessionId); return undefined }
    return { sessionId: r.session_id as string, identityId: r.identity_id as string, createdAt: r.created_at as number, lastSeenAt: r.last_seen_at as number }
  }
  async touch(sessionId: string): Promise<void> {
    await this.db.query('UPDATE web_sessions SET last_seen_at = $1 WHERE session_id = $2', [this.now(), sessionId])
  }
  async delete(sessionId: string): Promise<void> {
    await this.db.query('DELETE FROM web_sessions WHERE session_id = $1', [sessionId])
    await this.onDelete?.(sessionId)
  }
}
