import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openTestDb } from './support/testDb.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import type { Config } from '../src/config.js'
import type { Db } from '../src/store/dbTypes.js'

const CONFIG: Config = {
  authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
  serviceKey: 'sk', port: 0, db: { host: 'localhost', ssl: false }, schedulerMode: 'poller', auditStdout: false, otelMode: 'off', scheduleTz: 'Asia/Taipei',
  bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
}
const fakeJwt = (authKey: string) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, authKey, platformId: 'u' })}.s`
}

let http: Server, base: string, db: Db
let identities: IdentityStore, oauth: OAuthStore, creds: CredentialStore, webSessions: WebSessionStore

async function seedIdentity(id: string, label: string) {
  await identities.upsert({ identityId: id, userLabel: label, accessToken: fakeJwt(label), refreshToken: 'R', businessList: [], accessExpiresAt: Date.now() + 3600_000, updatedAt: 1 })
}
// 一條 OAuth 連線 = identity + oauth_access + oauth_refresh
async function seedConnection(id: string, label: string) {
  await seedIdentity(id, label)
  await creds.insert({ credHash: `acc-${id}`, identityId: id, kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  await oauth.insertRefresh({ refreshHash: `ref-${id}`, identityId: id, clientId: 'C1', exp: Date.now() + 86400_000, consumed: 0, accessCredHash: `acc-${id}` })
}
// 已登入的 web session(確認頁身分)
async function seedSession(sid: string, identityId: string) {
  await creds.insert({ credHash: CredentialStore.hash(sid), identityId, kind: 'web_session', expiresAt: null, updatedAt: 1 })
  await webSessions.create(sid, identityId)
}

beforeEach(async () => {
  db = await openTestDb()
  identities = new IdentityStore(db); oauth = new OAuthStore(db); creds = new CredentialStore(db)
  webSessions = new WebSessionStore(db)
  const app = buildApp({ config: CONFIG, db })
  http = createServer(app)
  await new Promise<void>(r => http.listen(0, () => r()))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterEach(() => new Promise<void>(r => http.close(() => { db.close(); r() })))

const get = (cookie?: string) => fetch(`${base}/confirm/connections`, { redirect: 'manual', headers: cookie ? { cookie } : {} })
// 關鍵:server 端 baseOrigin 由 config.port=0 組成 = 'http://127.0.0.1:0',與 harness 的實際
// 隨機 listening port(base)不同。合法 Origin 測試一律送 SERVER_ORIGIN;harness 的 base 反而
// 是「同 host 異 port」的天然錯誤樣本。
const SERVER_ORIGIN = 'http://127.0.0.1:0'
const post = (cookie: string, origin?: string) => fetch(`${base}/confirm/connections/revoke-all`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, ...(origin ? { origin } : {}) },
})

describe('/confirm/connections(spec §6)', () => {
  it('未登入 GET → 302 到 /confirm/login,next=/confirm/connections', async () => {
    const r = await get()
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe(`/confirm/login?next=${encodeURIComponent('/confirm/connections')}`)
  })
  it('登入後 GET → 只列同 userLabel 的連線(含另一 identity、大小寫差異),不列別人的、不列純 web_session 的', async () => {
    await seedConnection('I1', 'u@kkday.com')
    await seedConnection('I2', 'U@KKday.com ')       // 同人,大小寫/空白差異
    await seedConnection('I9', 'other@kkday.com')    // 別人
    await seedIdentity('I3', 'u@kkday.com')          // 同人但無 oauth 憑證 → 非連線
    await seedSession('sid1', 'I1')
    const r = await get('be2mcp_sid=sid1')
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html.match(/data-conn=/g)?.length).toBe(2)   // I1 + I2
    expect(html).toContain('斷開所有 Claude 連線')
    expect(html).toContain('static bearer')             // 邊界文案(spec §6.2)
    // 「最後活動」以 scheduleTz 牆鐘渲染並標明時區,不吐 UTC ISO(live 驗收回饋 2026-08-22)
    expect(html).toContain('Asia/Taipei')
    expect(html).not.toMatch(/最後活動 \d{4}-\d{2}-\d{2}T/)
  })
  it('POST 無 Origin → 403;同 host 異 port Origin(含 harness 實際 port)→ 403;store 無變化', async () => {
    await seedConnection('I1', 'u@kkday.com'); await seedSession('sid1', 'I1')
    expect((await post('be2mcp_sid=sid1')).status).toBe(403)
    expect((await post('be2mcp_sid=sid1', 'http://127.0.0.1:9999')).status).toBe(403)
    expect((await post('be2mcp_sid=sid1', base)).status).toBe(403)   // harness 的實際 port ≠ server baseOrigin
    expect(await oauth.countRefreshByIdentity('I1')).toBe(1)
  })
  it('POST 未登入(正確 Origin)→ 403', async () => {
    expect((await post('be2mcp_sid=nope', SERVER_ORIGIN)).status).toBe(403)
  })
  it('正確 Origin POST → 撤同 userLabel 全部連線、303 PRG、web session 仍活、別人/static_bearer 不動', async () => {
    await seedConnection('I1', 'u@kkday.com')
    await seedConnection('I2', 'U@KKday.com ')
    await seedConnection('I9', 'other@kkday.com')
    await creds.insert({ credHash: 'sb1', identityId: 'I1', kind: 'static_bearer', expiresAt: null, updatedAt: 1 })
    await seedSession('sid1', 'I1')
    const r = await post('be2mcp_sid=sid1', SERVER_ORIGIN)
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe('/confirm/connections?revoked=2')
    expect(await oauth.countRefreshByIdentity('I1')).toBe(0)
    expect(await oauth.countRefreshByIdentity('I2')).toBe(0)
    expect(await oauth.countRefreshByIdentity('I9')).toBe(1)          // 別人不動
    expect(await creds.get('sb1')).toBeDefined()                      // static_bearer 不動
    // 手動 follow PRG redirect(含 ?revoked=2)——session 仍登入、訊息由 GET 渲染
    const again = await fetch(`${base}${r.headers.get('location')}`, { headers: { cookie: 'be2mcp_sid=sid1' } })
    expect(again.status).toBe(200)
    expect((await again.text())).toContain('已斷開 2 條')
    // I2 成 ghost 被清、I1 因 web_session/static_bearer 引用而保留
    expect(await identities.get('I2')).toBeUndefined()
    expect(await identities.get('I1')).toBeDefined()
  })
  it('稽核:逐連線記 tool=confirm_connections_revoke_all', async () => {
    await seedConnection('I1', 'u@kkday.com'); await seedConnection('I2', 'u@kkday.com'); await seedSession('sid1', 'I1')
    await post('be2mcp_sid=sid1', SERVER_ORIGIN)
    const n = (await db.query("SELECT COUNT(*) c FROM audit_log WHERE tool = 'confirm_connections_revoke_all'")).rows[0].c as number
    expect(n).toBe(2)
  })
  it('revoked 參數注入 → 非 \\d{1,4} 不渲染訊息', async () => {
    await seedConnection('I1', 'u@kkday.com'); await seedSession('sid1', 'I1')
    const r = await fetch(`${base}/confirm/connections?revoked=<script>`, { headers: { cookie: 'be2mcp_sid=sid1' } })
    const html = await r.text()
    expect(html).not.toContain('<script>已斷開')
    expect(html).not.toContain('已斷開 <')
  })
})
