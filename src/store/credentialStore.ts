import type { Db } from './dbTypes.js'
import { createHash } from 'node:crypto'
export type CredentialKind = 'oauth_access' | 'static_bearer' | 'web_session'
export interface Credential { credHash: string; identityId: string; kind: CredentialKind; expiresAt: number | null; updatedAt: number }
export class CredentialStore {
  constructor(private db: Db) {}
  static hash(secret: string): string { return createHash('sha256').update(secret).digest('hex') }
  async get(credHash: string): Promise<Credential | undefined> {
    const r = (await this.db.query('SELECT * FROM credentials WHERE cred_hash = $1', [credHash])).rows[0] as Record<string, unknown> | undefined
    if (!r) return undefined
    return { credHash: r.cred_hash as string, identityId: r.identity_id as string, kind: r.kind as CredentialKind,
      expiresAt: (r.expires_at as number | null) ?? null, updatedAt: r.updated_at as number }
  }
  getBySecret(secret: string): Promise<Credential | undefined> { return this.get(CredentialStore.hash(secret)) }
  async insert(rec: Credential): Promise<void> {
    await this.db.query(
      `INSERT INTO credentials (cred_hash,identity_id,kind,expires_at,updated_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (cred_hash) DO UPDATE SET identity_id=EXCLUDED.identity_id, kind=EXCLUDED.kind, expires_at=EXCLUDED.expires_at, updated_at=EXCLUDED.updated_at`,
      [rec.credHash, rec.identityId, rec.kind, rec.expiresAt, rec.updatedAt])
  }
  async delete(credHash: string): Promise<void> { await this.db.query('DELETE FROM credentials WHERE cred_hash = $1', [credHash]) }
  async deleteByIdentity(identityId: string): Promise<void> { await this.db.query('DELETE FROM credentials WHERE identity_id = $1', [identityId]) }
  // Task 10: refresh-reuse family revoke needs to nuke every oauth_access credential for an
  // identity WITHOUT also killing unrelated credential kinds (e.g. a web_session cookie the same
  // identity holds for the confirm page) — deleteByIdentity is kind-agnostic and too broad for
  // that use case.
  async deleteByIdentityAndKind(identityId: string, kind: CredentialKind): Promise<void> {
    await this.db.query('DELETE FROM credentials WHERE identity_id = $1 AND kind = $2', [identityId, kind])
  }
  async countByIdentity(identityId: string): Promise<number> {
    return (await this.db.query<{ c: number }>('SELECT COUNT(*) c FROM credentials WHERE identity_id = $1', [identityId])).rows[0].c
  }
  async countByIdentityAndKind(identityId: string, kind: CredentialKind): Promise<number> {
    return (await this.db.query<{ c: number }>('SELECT COUNT(*) c FROM credentials WHERE identity_id = $1 AND kind = $2', [identityId, kind])).rows[0].c
  }
}
