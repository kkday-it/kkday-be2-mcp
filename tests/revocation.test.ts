import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { revokeGrant } from '../src/oauth/revocation.js'
import type Database from 'better-sqlite3'

let db: Database.Database, identities: IdentityStore, credentials: CredentialStore, oauth: OAuthStore
beforeEach(() => {
  db = openDb(':memory:')
  identities = new IdentityStore(db); credentials = new CredentialStore(db); oauth = new OAuthStore(db)
  identities.upsert({ identityId: 'I1', userLabel: 'u@kkday.com', accessToken: 'A', refreshToken: 'R', businessList: [], accessExpiresAt: 9e12, updatedAt: 1 })
  credentials.insert({ credHash: 'acc1', identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  oauth.insertRefresh({ refreshHash: 'rh1', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 0, accessCredHash: 'acc1' })
  oauth.insertRefresh({ refreshHash: 'rh0', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 1 })
})
const deps = () => ({ oauthStore: oauth, credentials, identities })

describe('revokeGrant(spec §4.4)', () => {
  it('刪整條 refresh family(含 consumed)+ oauth_access;identity 無引用即清,回 userLabel', () => {
    const out = revokeGrant(deps(), 'I1')
    expect(out?.userLabel).toBe('u@kkday.com')
    expect(oauth.countRefreshByIdentity('I1')).toBe(0)
    expect(credentials.get('acc1')).toBeUndefined()
    expect(identities.get('I1')).toBeUndefined()   // ghost 清掉
  })
  it('同 identity 還有 web_session → credential 與 identity 都保留', () => {
    credentials.insert({ credHash: 'ws1', identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 1 })
    revokeGrant(deps(), 'I1')
    expect(credentials.get('ws1')?.kind).toBe('web_session')
    expect(identities.get('I1')?.userLabel).toBe('u@kkday.com')
    expect(oauth.countRefreshByIdentity('I1')).toBe(0)
  })
  it('static_bearer 不受影響(kind-scoped 刪除)', () => {
    credentials.insert({ credHash: 'sb1', identityId: 'I1', kind: 'static_bearer', expiresAt: null, updatedAt: 1 })
    revokeGrant(deps(), 'I1')
    expect(credentials.get('sb1')?.kind).toBe('static_bearer')
    expect(identities.get('I1')).toBeDefined()
  })
  it('不存在的 identity → 冪等,回 undefined 不炸', () => {
    expect(revokeGrant(deps(), 'nope')).toBeUndefined()
  })
})
