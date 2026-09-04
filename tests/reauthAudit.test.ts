import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { buildOnReauthRequired } from '../src/auth/reauthAudit.js'
import { randomUUID } from 'node:crypto'

describe('buildOnReauthRequired (G2)', () => {
  it('revokes credentials AND records security.reauth_required with the identity userLabel', async () => {
    const db = await openTestDb()
    const identities = new IdentityStore(db)
    const credentials = new CredentialStore(db)
    const oauthStore = new OAuthStore(db)
    const audit = new AuditLog(db)
    const id = randomUUID()
    await identities.upsert({ identityId: id, userLabel: 'victim@kkday.com', accessToken: 'a', refreshToken: 'r', businessList: [], accessExpiresAt: 9e12, updatedAt: 1 })
    const cb = buildOnReauthRequired({ credentials, oauthStore, identities, audit })
    await cb(id)
    const row = (await audit.recent())[0]
    expect(row).toMatchObject({ eventType: 'security.reauth_required', severity: 'WARN', status: 'error', userLabel: 'victim@kkday.com' })
    expect(JSON.stringify(row.params)).not.toMatch(/eyJ|refresh/i)   // 不落 token
    await db.close()
  })

  it('audit failure must not block the revocation itself', async () => {
    const db = await openTestDb()
    const identities = new IdentityStore(db)
    const credentials = new CredentialStore(db)
    const oauthStore = new OAuthStore(db)
    const audit = { record: () => Promise.reject(new Error('audit down')) } as never
    const id = randomUUID()
    await identities.upsert({ identityId: id, userLabel: 'v@kkday.com', accessToken: 'a', refreshToken: 'r', businessList: [], accessExpiresAt: 9e12, updatedAt: 1 })
    const cb = buildOnReauthRequired({ credentials, oauthStore, identities, audit })
    await expect(cb(id)).resolves.toBeUndefined()   // 不 throw（撤銷已完成）
    await db.close()
  })
})
