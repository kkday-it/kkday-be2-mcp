import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openTestDb } from './support/testDb.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import type { Config } from '../src/config.js'
import type { Db } from '../src/store/dbTypes.js'

const CONFIG: Config = {
  authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
  serviceKey: 'sk', port: 0, db: { host: 'localhost', ssl: false }, schedulerMode: 'poller', auditStdout: false, otelMode: 'off', scheduleTz: 'Asia/Taipei',
  bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
}
const fakeJwt = () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, authKey: 'u@kkday.com', platformId: 'u' })}.s`
}

// seed 一條完整 OAuth 連線:identity I1 + access(明文 rawAccess) + refresh(明文 rawRefresh)
async function seedGrant(db: Db, opts?: { identityId?: string; clientId?: string; withAccessLink?: boolean }) {
  const identityId = opts?.identityId ?? 'I1'
  const clientId = opts?.clientId ?? 'C1'
  const identities = new IdentityStore(db); const oauth = new OAuthStore(db); const creds = new CredentialStore(db)
  await identities.upsert({ identityId, userLabel: 'u@kkday.com', accessToken: fakeJwt(), refreshToken: 'R', businessList: [], accessExpiresAt: Date.now() + 3600_000, updatedAt: 1 })
  const rawAccess = `acc-${identityId}`, rawRefresh = `ref-${identityId}`
  const accessCredHash = CredentialStore.hash(rawAccess)
  await creds.insert({ credHash: accessCredHash, identityId, kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  await oauth.insertRefresh({ refreshHash: CredentialStore.hash(rawRefresh), identityId, clientId, exp: Date.now() + 86400_000, consumed: 0, ...(opts?.withAccessLink === false ? {} : { accessCredHash }) })
  return { identityId, rawAccess, rawRefresh, identities, oauth, creds }
}

let http: Server, base: string, db: Db
beforeEach(async () => {
  db = await openTestDb()
  const app = buildApp({ config: CONFIG, db })
  http = createServer(app)
  await new Promise<void>(r => http.listen(0, () => r()))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterEach(() => new Promise<void>(r => http.close(() => { void db.close().then(() => r()) })))

const revoke = (body: Record<string, unknown>) => fetch(`${base}/oauth/revoke`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

describe('POST /oauth/revoke(RFC 7009,spec §4)', () => {
  it('refresh 撤銷 → 整 family + access 消失、ghost identity 清掉、200 空 body', async () => {
    const g = await seedGrant(db)
    const r = await revoke({ token: g.rawRefresh })
    expect(r.status).toBe(200)
    expect(await g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
    expect(await g.creds.getBySecret(g.rawAccess)).toBeUndefined()
    expect(await g.identities.get(g.identityId)).toBeUndefined()
  })
  it('access 撤銷 → 同 grant 級效果(經 accessCredHash 反查 clientId)', async () => {
    const g = await seedGrant(db)
    const r = await revoke({ token: g.rawAccess, client_id: 'C1' })
    expect(r.status).toBe(200)
    expect(await g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
    expect(await g.identities.get(g.identityId)).toBeUndefined()
  })
  it('web_session 同 identity 存在 → 撤銷後 session 與 identity 保留', async () => {
    const g = await seedGrant(db)
    await g.creds.insert({ credHash: 'ws1', identityId: g.identityId, kind: 'web_session', expiresAt: null, updatedAt: 1 })
    await revoke({ token: g.rawRefresh })
    expect(await g.creds.get('ws1')).toBeDefined()
    expect(await g.identities.get(g.identityId)).toBeDefined()
  })
  it('unknown token / static_bearer / web_session secret → 200 no-op、store 無變化、無 audit', async () => {
    const g = await seedGrant(db)
    await g.creds.insert({ credHash: CredentialStore.hash('sb-raw'), identityId: g.identityId, kind: 'static_bearer', expiresAt: null, updatedAt: 1 })
    await g.creds.insert({ credHash: CredentialStore.hash('ws-raw'), identityId: g.identityId, kind: 'web_session', expiresAt: null, updatedAt: 1 })
    for (const t of ['garbage', 'sb-raw', 'ws-raw']) {
      const r = await revoke({ token: t })
      expect(r.status).toBe(200)
    }
    expect(await g.creds.getBySecret('sb-raw')).toBeDefined()
    expect(await g.creds.getBySecret('ws-raw')).toBeDefined()
    expect(await g.oauth.countRefreshByIdentity(g.identityId)).toBe(1)
    expect((await db.query("SELECT COUNT(*) c FROM audit_log WHERE tool = 'oauth_revoke'")).rows[0]).toEqual({ c: 0 })
  })
  it('consumed / 已過期的 refresh 呈上 → 照樣命中、整 family 撤銷(spec §4.2)', async () => {
    // consumed:模擬已被 rotation 標記過的舊 refresh
    const g1 = await seedGrant(db, { identityId: 'IC' })
    await db.query('UPDATE oauth_refresh SET consumed = TRUE WHERE identity_id = $1', ['IC'])
    expect((await revoke({ token: g1.rawRefresh })).status).toBe(200)
    expect(await g1.oauth.countRefreshByIdentity('IC')).toBe(0)
    expect(await g1.creds.getBySecret(g1.rawAccess)).toBeUndefined()
    // expired:exp 已過的列照樣命中(冪等、無害)
    const g2 = await seedGrant(db, { identityId: 'IE' })
    await db.query('UPDATE oauth_refresh SET exp = 1 WHERE identity_id = $1', ['IE'])
    expect((await revoke({ token: g2.rawRefresh })).status).toBe(200)
    expect(await g2.oauth.countRefreshByIdentity('IE')).toBe(0)
  })
  it('token 缺席 → 400 invalid_request', async () => {
    const r = await revoke({})
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('invalid_request')
  })
  it('token_type_hint 給錯(refresh 標成 access_token)→ 仍找到並撤銷', async () => {
    const g = await seedGrant(db)
    await revoke({ token: g.rawRefresh, token_type_hint: 'access_token' })
    expect(await g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
  })
  it('client_id 不符 → 200 no-op 且 store 無變化;client_id 缺席 → 照撤', async () => {
    const g = await seedGrant(db)
    await revoke({ token: g.rawRefresh, client_id: 'WRONG' })
    expect(await g.oauth.countRefreshByIdentity(g.identityId)).toBe(1)   // 沒撤
    await revoke({ token: g.rawRefresh })                          // 缺席 → 照撤
    expect(await g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
  })
  it('access token 的 family 已亡(refresh 列被 purge)→ 跳過 client 檢查照撤(possession 足矣)', async () => {
    const g = await seedGrant(db)
    await db.query('DELETE FROM oauth_refresh WHERE identity_id = $1', [g.identityId])   // 模擬 oauth-purge
    const r = await revoke({ token: g.rawAccess, client_id: 'ANYTHING' })
    expect(r.status).toBe(200)
    expect(await g.creds.getBySecret(g.rawAccess)).toBeUndefined()
  })
  it('重複撤銷同一顆 → 兩次都 200(冪等)', async () => {
    const g = await seedGrant(db)
    expect((await revoke({ token: g.rawRefresh })).status).toBe(200)
    expect((await revoke({ token: g.rawRefresh })).status).toBe(200)
  })
  it('撤銷後:原 access 打 /mcp → 401;原 refresh 打 /oauth/token → invalid_grant', async () => {
    const g = await seedGrant(db)
    await revoke({ token: g.rawAccess })
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${g.rawAccess}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    })
    expect(mcp.status).toBe(401)
    const tok = await fetch(`${base}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: g.rawRefresh, client_id: 'C1' }),
    })
    expect(tok.status).toBe(400)
    expect(((await tok.json()) as { error: string }).error).toBe('invalid_grant')
  })
  it('audit:命中記一筆(tool=oauth_revoke),params 無 token 明文', async () => {
    const g = await seedGrant(db)
    await revoke({ token: g.rawRefresh, client_id: 'C1' })
    const row = (await db.query("SELECT * FROM audit_log WHERE tool = 'oauth_revoke'")).rows[0] as { user_label: string; params_json: string }
    expect(row.user_label).toBe('u@kkday.com')
    expect(row.params_json).not.toContain(g.rawRefresh)
    expect(row.params_json).toContain('refresh_token')
  })
  it('urlencoded form body 也吃(真實 OAuth client 慣例)', async () => {
    const g = await seedGrant(db)
    const r = await fetch(`${base}/oauth/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(g.rawRefresh)}`,
    })
    expect(r.status).toBe(200)
    expect(await g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
  })
})
