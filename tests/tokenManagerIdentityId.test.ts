import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { TokenManager } from '../src/auth/tokenManager.js'
import type { AuthServiceClient } from '../src/auth/authServiceClient.js'

describe('TokenManager IdentityId Threading', () => {
  it('getFreshAccessToken returns the identityId backing the credential', async () => {
    const db = openDb(':memory:')
    const identities = new IdentityStore(db)
    const credentials = new CredentialStore(db)
    identities.upsert({ identityId: 'id-9', userLabel: 'u', accessToken: 'tok', refreshToken: 'r',
      businessList: [], accessExpiresAt: Number.MAX_SAFE_INTEGER, updatedAt: 0 })
    credentials.insert({ credHash: CredentialStore.hash('bearer-1'), identityId: 'id-9', kind: 'oauth_access', expiresAt: null, updatedAt: 0 })
    const tm = new TokenManager({ identities, credentials }, {} as AuthServiceClient)
    const u = await tm.getFreshAccessToken('bearer-1')
    expect(u.identityId).toBe('id-9')
    expect(u.accessToken).toBe('tok')
  })
})
