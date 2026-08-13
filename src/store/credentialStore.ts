import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
export type CredentialKind = 'oauth_access' | 'static_bearer' | 'web_session'
export interface Credential { credHash: string; identityId: string; kind: CredentialKind; expiresAt: number | null; updatedAt: number }
export class CredentialStore {
  constructor(private db: Database.Database) {}
  static hash(secret: string): string { return createHash('sha256').update(secret).digest('hex') }
  get(credHash: string): Credential | undefined {
    const r = this.db.prepare('SELECT * FROM credentials WHERE cred_hash = ?').get(credHash) as Record<string, unknown> | undefined
    if (!r) return undefined
    return { credHash: r.cred_hash as string, identityId: r.identity_id as string, kind: r.kind as CredentialKind,
      expiresAt: (r.expires_at as number | null) ?? null, updatedAt: r.updated_at as number }
  }
  getBySecret(secret: string): Credential | undefined { return this.get(CredentialStore.hash(secret)) }
  insert(rec: Credential): void {
    this.db.prepare('INSERT OR REPLACE INTO credentials (cred_hash,identity_id,kind,expires_at,updated_at) VALUES (?,?,?,?,?)')
      .run(rec.credHash, rec.identityId, rec.kind, rec.expiresAt, rec.updatedAt)
  }
  delete(credHash: string): void { this.db.prepare('DELETE FROM credentials WHERE cred_hash = ?').run(credHash) }
  deleteByIdentity(identityId: string): void { this.db.prepare('DELETE FROM credentials WHERE identity_id = ?').run(identityId) }
  // Task 10: refresh-reuse family revoke needs to nuke every oauth_access credential for an
  // identity WITHOUT also killing unrelated credential kinds (e.g. a web_session cookie the same
  // identity holds for the confirm page) — deleteByIdentity is kind-agnostic and too broad for
  // that use case.
  deleteByIdentityAndKind(identityId: string, kind: CredentialKind): void {
    this.db.prepare('DELETE FROM credentials WHERE identity_id = ? AND kind = ?').run(identityId, kind)
  }
  countByIdentity(identityId: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM credentials WHERE identity_id = ?').get(identityId) as { c: number }).c
  }
}
