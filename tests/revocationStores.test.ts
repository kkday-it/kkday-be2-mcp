import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import type Database from 'better-sqlite3'

// A2 撤銷功能的 store 層薄查詢(spec §7)。純 SQL 查詢,無業務邏輯。
let db: Database.Database, identities: IdentityStore, credentials: CredentialStore, oauth: OAuthStore
beforeEach(() => {
  db = openDb(':memory:')
  identities = new IdentityStore(db); credentials = new CredentialStore(db); oauth = new OAuthStore(db)
})

const ident = (id: string, label: string) => identities.upsert({
  identityId: id, userLabel: label, accessToken: 'A', refreshToken: 'R',
  businessList: [], accessExpiresAt: 9e12, updatedAt: 1,
})

describe('OAuthStore revocation queries', () => {
  it('getRefreshByAccessCredHash 反查同批核發的 refresh 列;查無回 undefined', () => {
    oauth.insertRefresh({ refreshHash: 'rh1', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 0, accessCredHash: 'ah1' })
    expect(oauth.getRefreshByAccessCredHash('ah1')?.clientId).toBe('C1')
    expect(oauth.getRefreshByAccessCredHash('nope')).toBeUndefined()
  })
  it('countRefreshByIdentity 含 consumed 歷史列', () => {
    oauth.insertRefresh({ refreshHash: 'rh1', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 0 })
    oauth.insertRefresh({ refreshHash: 'rh2', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 1 })
    expect(oauth.countRefreshByIdentity('I1')).toBe(2)
    expect(oauth.countRefreshByIdentity('I2')).toBe(0)
  })
})

describe('CredentialStore.countByIdentityAndKind', () => {
  it('只數指定 kind', () => {
    credentials.insert({ credHash: 'h1', identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
    credentials.insert({ credHash: 'h2', identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 1 })
    expect(credentials.countByIdentityAndKind('I1', 'oauth_access')).toBe(1)
    expect(credentials.countByIdentityAndKind('I1', 'static_bearer')).toBe(0)
  })
})

describe('IdentityStore.listByUserLabel', () => {
  it('大小寫/前後空白正規化比對,不撈別人的', () => {
    ident('I1', 'User@KKday.com'); ident('I2', ' user@kkday.com '); ident('I3', 'other@kkday.com')
    const got = identities.listByUserLabel('user@kkday.com').map(i => i.identityId).sort()
    expect(got).toEqual(['I1', 'I2'])
  })
})
