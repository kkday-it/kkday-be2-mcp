import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

// Task 10：POST /oauth/token 是 OAuth 外殼的認證核心——PKCE 驗證、code 一次性、refresh
// rotation + reuse-detection family revoke。這是「認證繞過」影響面最大的一支端點，測試需
// 非空洞（每個安全宣稱都要有對應的真實 request/response 斷言，不能只測 happy path）。

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')

function fakeJwt(expSec: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec, authKey: 'u' })}.s`
}

const REDIRECT_URI = 'http://127.0.0.1:5/callback'
const CLIENT_ID = 'C'

const CONFIG: Config = {
  authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
  serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off',
}

// 每個測試前：db + 一個已登入 identity + 一個 client C + 一個 authz code 綁 (C, redirect, challenge, identity)。
// exp 預設給很長的 TTL（Date.now() + 60_000），除非測試自己要驗過期案例才覆寫。
function seedCode(db: Database.Database, opts: { verifier: string; identityId?: string; exp?: number }): { rawCode: string; identityId: string } {
  const identityId = opts.identityId ?? 'I1'
  const identities = new IdentityStore(db)
  const oauth = new OAuthStore(db)
  identities.upsert({
    identityId, userLabel: 'u', accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'R', businessList: [], accessExpiresAt: Date.now() + 3600_000, updatedAt: 1,
  })
  if (!oauth.getClient(CLIENT_ID)) oauth.insertClient({ clientId: CLIENT_ID, redirectUris: [REDIRECT_URI], createdAt: 1 })
  const rawCode = randomBytes(16).toString('hex')
  oauth.insertAuthCode({
    codeHash: CredentialStore.hash(rawCode), clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
    codeChallenge: s256(opts.verifier), identityId, exp: opts.exp ?? Date.now() + 60_000, consumed: 0,
  })
  return { rawCode, identityId }
}

describe('POST /oauth/token', () => {
  let http: Server, base: string, db: Database.Database

  beforeEach(async () => {
    db = openDb(':memory:')
    const app = buildApp({ config: CONFIG, db })
    http = createServer(app)
    await new Promise<void>(r => http.listen(0, () => r()))
    base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  })
  afterEach(() => new Promise<void>(r => http.close(() => { db.close(); r() })))

  async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }

  async function mcpInitialize(bearer: string): Promise<{ status: number; headers: Headers }> {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
      }),
    })
    return { status: r.status, headers: r.headers }
  }

  it('正確 verifier → 發 token 且該 access 能過 /mcp；同一個 code 事後用錯 verifier 重放 → invalid_grant', async () => {
    const { rawCode } = seedCode(db, { verifier: 'VER' })
    const ok = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER',
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    })
    expect(ok.status).toBe(200)
    expect(ok.body.access_token).toBeTruthy()
    expect(ok.body.refresh_token).toBeTruthy()
    expect(ok.body.token_type).toBe('Bearer')
    expect(typeof ok.body.expires_in).toBe('number')

    const gate = await mcpInitialize(ok.body.access_token as string)
    expect(gate.status).not.toBe(401)

    // 同一支 rawCode 此時已被消費（見上），用錯的 verifier 重放 → invalid_grant（此斷言字面照抄
    // brief 給的測試序列）。
    const bad = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'WRONG',
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_grant')
  })

  // 上面那個 case 的「錯 verifier」其實跟「code 已消費」疊在一起，不能單獨證明 PKCE 檢查本身
  // 有效。這裡用一支全新、尚未被消費的 code 單獨驗證 PKCE mismatch 會被擋下——是 PKCE 檢查本身
  // 在擋，不是一次性檢查順便擋住。
  it('PKCE 單獨驗證：全新未消費的 code + 錯誤 verifier → invalid_grant，且 code 未被消費（可用正確 verifier 換到）', async () => {
    const { rawCode } = seedCode(db, { verifier: 'RIGHT' })
    const bad = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'WRONG',
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_grant')

    // code 沒有因為驗證失敗被消費掉——用正確 verifier 還能換到 token。
    const ok = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'RIGHT',
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    })
    expect(ok.status).toBe(200)
    expect(ok.body.access_token).toBeTruthy()
  })

  it('code 一次性：同 code 換兩次 → 第二次 invalid_grant', async () => {
    const { rawCode } = seedCode(db, { verifier: 'VER' })
    const first = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER',
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    })
    expect(first.status).toBe(200)
    const second = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER',
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    })
    expect(second.status).toBe(400)
    expect(second.body.error).toBe('invalid_grant')
  })

  it('client_id / redirect_uri 對不上綁定的 code → invalid_grant', async () => {
    const { rawCode } = seedCode(db, { verifier: 'VER' })
    const wrongClient = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER',
      client_id: 'someone-else', redirect_uri: REDIRECT_URI,
    })
    expect(wrongClient.status).toBe(400)
    expect(wrongClient.body.error).toBe('invalid_grant')

    const wrongRedirect = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER',
      client_id: CLIENT_ID, redirect_uri: 'http://127.0.0.1:9/callback',
    })
    expect(wrongRedirect.status).toBe(400)
    expect(wrongRedirect.body.error).toBe('invalid_grant')
  })

  it('過期的 code → invalid_grant', async () => {
    const { rawCode } = seedCode(db, { verifier: 'VER', exp: Date.now() - 1000 })
    const r = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER',
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_grant')
  })

  it('未知 grant_type → invalid_request（400）', async () => {
    const r = await post('/oauth/token', { grant_type: 'client_credentials' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_request')
  })

  it('未知 refresh_token → invalid_grant', async () => {
    const r = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'no-such-token', client_id: CLIENT_ID })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_grant')
  })

  it('refresh rotation：舊 access 立即失效、舊 refresh 再用觸發 family revoke（撤銷整個 token family）', async () => {
    // 換到 {access1, refresh1}
    const { rawCode } = seedCode(db, { verifier: 'VER' })
    const first = await post('/oauth/token', {
      grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER',
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    })
    expect(first.status).toBe(200)
    const access1 = first.body.access_token as string
    const refresh1 = first.body.refresh_token as string

    // access1 在 rotate 之前是有效的
    expect((await mcpInitialize(access1)).status).not.toBe(401)

    // 用 refresh1 rotate 到 {access2, refresh2}
    const rotated = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: refresh1, client_id: CLIENT_ID })
    expect(rotated.status).toBe(200)
    const access2 = rotated.body.access_token as string
    const refresh2 = rotated.body.refresh_token as string
    expect(access2).not.toBe(access1)
    expect(refresh2).not.toBe(refresh1)

    // 斷言：access1 打 /mcp → 401（credential 已刪）；access2 有效
    expect((await mcpInitialize(access1)).status).toBe(401)
    expect((await mcpInitialize(access2)).status).not.toBe(401)

    // 再用「已 consumed 的 refresh1」→ invalid_grant 且 family revoke
    const reused = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: refresh1, client_id: CLIENT_ID })
    expect(reused.status).toBe(400)
    expect(reused.body.error).toBe('invalid_grant')

    // family revoke：access2（本應仍合法的新 access）也立即失效
    expect((await mcpInitialize(access2)).status).toBe(401)
    // family revoke：refresh2 也被撤銷，之後連它自己都無法再拿來 rotate
    const refresh2AfterRevoke = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: refresh2, client_id: CLIENT_ID })
    expect(refresh2AfterRevoke.status).toBe(400)
    expect(refresh2AfterRevoke.body.error).toBe('invalid_grant')
  })

  it('/mcp 401 帶 WWW-Authenticate 指向 protected-resource', async () => {
    const r = await mcpInitialize('unknown-bearer')
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource')
  })
})
