import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/server/app.js'
import { buildAuthorizeRouter } from '../src/oauth/authorizeRoutes.js'
import { openDb } from '../src/store/db.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'
import { runLauncherScript } from './launcherHarness.js'

function fakeJwt(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`
}

function authCodeCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) c FROM oauth_auth_codes').get() as { c: number }).c
}

// Task 9：/oauth/authorize 驗證測試——用 buildApp 跑真實的 discovery/register/authorize 三支
// 路由，同一個 db 上另建一個 OAuthStore 實例直接查/插資料（與 tests/oauthRegister.test.ts 同一
// 手法）。這一組全部只測「驗證失敗一律 400、不鑄 code」，不需要真的走 be2-auth 登入，所以可以
// 安心用 buildApp 的真實 AuthServiceClient（永遠不會被呼叫到）。
describe('GET /oauth/authorize — 參數驗證（失敗一律 400，不鑄 code）', () => {
  let http: Server, base: string, db: Database.Database, oauthStore: OAuthStore

  beforeAll(async () => {
    db = openDb(':memory:')
    oauthStore = new OAuthStore(db)
    const config: Config = {
      authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
      serviceKey: 'sk', port: 0, db: { host: 'localhost', ssl: false }, schedulerMode: 'poller', otelMode: 'off', scheduleTz: 'Asia/Taipei',
      bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
    }
    const app = buildApp({ config, db })
    http = createServer(app)
    await new Promise<void>(r => http.listen(0, () => r()))
    base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  })
  afterAll(() => new Promise<void>(r => http.close(() => r())))

  async function registerClient(redirectUris: string[]): Promise<string> {
    const r = await fetch(`${base}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: redirectUris }),
    })
    expect(r.status).toBe(200)
    return ((await r.json()) as { client_id: string }).client_id
  }

  it('缺 code_challenge → 400，且沒有 auth code 落地', async () => {
    const clientId = await registerClient(['http://127.0.0.1:5/callback'])
    const before = authCodeCount(db)
    const url = `${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('http://127.0.0.1:5/callback')}&response_type=code&code_challenge_method=S256&state=st-a`
    const r = await fetch(url, { redirect: 'manual' })
    expect(r.status).toBe(400)
    expect(authCodeCount(db)).toBe(before)
  })

  it('redirect_uri 不在該 client 註冊清單 → 400（不 redirect 到該 uri），且沒有 auth code 落地', async () => {
    const clientId = await registerClient(['http://127.0.0.1:5/callback'])
    const before = authCodeCount(db)
    // 這個 redirect_uri 本身形狀合法（isAllowedRedirectUri 會過），但不在這個 client 的註冊清單裡。
    const badUri = 'http://127.0.0.1:6/callback'
    const url = `${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(badUri)}&response_type=code&code_challenge=chal&code_challenge_method=S256&state=st-b`
    const r = await fetch(url, { redirect: 'manual' })
    expect(r.status).toBe(400)
    expect(r.status).not.toBe(302)
    expect(authCodeCount(db)).toBe(before)
  })

  it('redirect_uri 在清單裡但未過 isAllowedRedirectUri（雙重防線）→ 400', async () => {
    // 直接繞過 /oauth/register 自己的驗證，插入一個帶不合格 redirect_uri 的 client——
    // 驗證這條防線不是只靠「register 時檢查過一次」，authorize 自己也要重新驗一次。
    const clientId = randomUUID()
    oauthStore.insertClient({ clientId, redirectUris: ['http://evil.example.com/callback'], createdAt: Date.now() })
    const before = authCodeCount(db)
    const url = `${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('http://evil.example.com/callback')}&response_type=code&code_challenge=chal&code_challenge_method=S256&state=st-c`
    const r = await fetch(url, { redirect: 'manual' })
    expect(r.status).toBe(400)
    expect(authCodeCount(db)).toBe(before)
  })

  it('code_challenge_method 不是 S256 → 400', async () => {
    const clientId = await registerClient(['http://127.0.0.1:5/callback'])
    const before = authCodeCount(db)
    const url = `${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('http://127.0.0.1:5/callback')}&response_type=code&code_challenge=chal&code_challenge_method=plain&state=st-d`
    const r = await fetch(url, { redirect: 'manual' })
    expect(r.status).toBe(400)
    expect(authCodeCount(db)).toBe(before)
  })

  it('缺 state → 400', async () => {
    const clientId = await registerClient(['http://127.0.0.1:5/callback'])
    const before = authCodeCount(db)
    const url = `${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('http://127.0.0.1:5/callback')}&response_type=code&code_challenge=chal&code_challenge_method=S256`
    const r = await fetch(url, { redirect: 'manual' })
    expect(r.status).toBe(400)
    expect(authCodeCount(db)).toBe(before)
  })

  it('未知 client_id → 400', async () => {
    const before = authCodeCount(db)
    const url = `${base}/oauth/authorize?client_id=does-not-exist&redirect_uri=${encodeURIComponent('http://127.0.0.1:5/callback')}&response_type=code&code_challenge=chal&code_challenge_method=S256&state=st-e`
    const r = await fetch(url, { redirect: 'manual' })
    expect(r.status).toBe(400)
    expect(authCodeCount(db)).toBe(before)
  })
})

// 通過驗證的 happy path 需要注入假的 be2-auth 登入（stub authServiceClient.exchangeCode），
// buildApp 自己內部建的 AuthServiceClient 打的是真實 fetch、無法在這裡注入，所以這裡跳過
// buildApp，直接組一個只掛 buildAuthorizeRouter 的最小 app——與 tests/ssoRoutes.test.ts
// 測 buildSsoRouter 的手法完全一致。
describe('POST /oauth/authorize/complete — happy path（假 be2-auth 登入）', () => {
  let server: Server, base: string, db: Database.Database
  let oauthStore: OAuthStore, identities: IdentityStore, credentials: CredentialStore, webSessions: WebSessionStore
  let clientId: string
  const REDIRECT_URI = 'http://127.0.0.1:5/callback'

  beforeEach(async () => {
    db = openDb(':memory:')
    oauthStore = new OAuthStore(db)
    identities = new IdentityStore(db)
    credentials = new CredentialStore(db)
    webSessions = new WebSessionStore(db, { now: () => 1000 })
    clientId = randomUUID()
    oauthStore.insertClient({ clientId, redirectUris: [REDIRECT_URI], createdAt: 1000 })

    const jwt = fakeJwt({ authKey: 'pilot@kkday.com', exp: Math.floor(Date.now() / 1000) + 3000 })
    const authServiceClient = { exchangeCode: async (_c: string) => ({ accessToken: jwt, refreshToken: 'r', businessList: [] }) } as never
    const router = buildAuthorizeRouter({
      oauthStore, authServiceClient, identities, credentials, webSessions,
      authOrigin: 'https://auth-220.sit.kkday.com', now: () => 1000,
    })
    const app = express(); app.use(express.json()); app.use(router)
    server = app.listen(0); await new Promise(r => server.on('listening', r as () => void))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => new Promise<void>(r => server.close(() => { db.close(); r() })))

  // 同 tests/ssoRoutes.test.ts 的握手測試：be2-auth popup 發 AUTH_LOGIN_READY 後，authorize
  // 過場頁（opener）必須回 CONFIRM_LOGIN_DOMAIN，否則 be2-auth 500ms 後 client-route /404。
  it('authorize 過場頁收到 AUTH_LOGIN_READY → 回 CONFIRM_LOGIN_DOMAIN 給 popup（targetOrigin 鎖 be2-auth）', async () => {
    const url = `${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&code_challenge=chal-xyz&code_challenge_method=S256&state=state-123`
    const html = await (await fetch(url)).text()
    const page = runLauncherScript(html)
    const pop = page.clickLogin()
    page.dispatchMessage({ origin: 'https://auth-220.sit.kkday.com', source: pop, data: { event: 'AUTH_LOGIN_READY' } })
    expect(pop.posted).toEqual([{ data: { event: 'CONFIRM_LOGIN_DOMAIN' }, targetOrigin: 'https://auth-220.sit.kkday.com' }])
  })

  it('登入成功 → 設 be2mcp_sid cookie、code 綁定正確、code 只存 hash、導回 redirect_uri 帶 code&state', async () => {
    const r = await fetch(`${base}/oauth/authorize/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'be2-auth-code-1', client_id: clientId, redirect_uri: REDIRECT_URI,
        response_type: 'code', code_challenge: 'chal-xyz', code_challenge_method: 'S256', state: 'state-123',
      }),
    })
    expect(r.status).toBe(200)

    // (i) be2mcp_sid cookie 有設
    const setCookie = r.headers.get('set-cookie')!
    expect(setCookie).toContain('be2mcp_sid=')
    expect(setCookie).toContain('HttpOnly')
    const sid = /be2mcp_sid=([^;]+)/.exec(setCookie)![1]
    const session = webSessions.get(sid)!
    expect(session).toBeDefined()

    // (iv) 導向 redirect_uri，帶 code & state
    const body = (await r.json()) as { redirectTo: string }
    expect(body.redirectTo.startsWith(`${REDIRECT_URI}?code=`)).toBe(true)
    expect(body.redirectTo).toContain('&state=state-123')
    const rawCode = /[?&]code=([^&]+)/.exec(body.redirectTo)![1]

    // (ii) authz code 綁對 clientId/codeChallenge/identityId
    const codeHash = CredentialStore.hash(rawCode)
    const rec = oauthStore.getAuthCode(codeHash)!
    expect(rec).toBeDefined()
    expect(rec.clientId).toBe(clientId)
    expect(rec.redirectUri).toBe(REDIRECT_URI)
    expect(rec.codeChallenge).toBe('chal-xyz')
    expect(rec.identityId).toBe(session.identityId)
    expect(rec.consumed).toBe(0)

    // (iii) raw code 不等於它自己的 hash（store 裡只有雜湊、非明文）
    expect(rec.codeHash).not.toBe(rawCode)
    expect(rawCode).not.toBe(codeHash)
  })

  it('client_id/redirect_uri 對不上 → 400，不鑄 code、不設 cookie', async () => {
    const before = authCodeCount(db)
    const r = await fetch(`${base}/oauth/authorize/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'be2-auth-code-1', client_id: clientId, redirect_uri: 'http://127.0.0.1:9/callback',
        response_type: 'code', code_challenge: 'chal-xyz', code_challenge_method: 'S256', state: 'state-123',
      }),
    })
    expect(r.status).toBe(400)
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(authCodeCount(db)).toBe(before)
  })
})
