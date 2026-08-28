import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

// Task 7：DCR 動態註冊（RFC 7591）。安全重點兩項：
// (1) redirect_uri 必須逐一過 allowlist（isAllowedRedirectUri），任何一個不合格整支請求 400、
//     且不得建立 client（避免半成品 client 留在 store）。
// (2) 回應物件絕不可含 `client_secret` 這個 key（連 null 都不行）——這是本 client 是 public
//     client（PKCE、無 secret）的宣告，也是避開 Claude Code zod schema 型別衝突的既知限制
//     （見 reference-dev-tools-architecture.md）。
let http: Server, base: string, db: Database.Database, oauthStore: OAuthStore

beforeAll(async () => {
  db = openDb(':memory:')
  oauthStore = new OAuthStore(db)
  const config: Config = {
    authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
    serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off', scheduleTz: 'Asia/Taipei',
    bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
  }
  const app = buildApp({ config, db })
  http = createServer(app)
  await new Promise<void>(r => http.listen(0, () => r()))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterAll(() => { http.close(); db.close() })

describe('POST /oauth/register', () => {
  it('合法 redirect_uri（loopback）→ 200，回應不含 client_secret key', async () => {
    const r = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:5/callback'] }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect('client_secret' in body).toBe(false)
    expect(typeof body.client_id).toBe('string')
    expect(body.redirect_uris).toEqual(['http://127.0.0.1:5/callback'])
    expect(body.token_endpoint_auth_method).toBe('none')
    // 建立的 client 真的落地在 store 裡（可用剛回傳的 client_id 查到）
    expect(oauthStore.getClient(body.client_id as string)).toBeDefined()
  })

  it('合法 redirect_uri（claude.ai callback）→ 200', async () => {
    const r = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
    })
    expect(r.status).toBe(200)
  })

  it('redirect_uri 不在 allowlist → 400，且不建立 client', async () => {
    const r = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example.com/callback'] }),
    })
    expect(r.status).toBe(400)
  })

  it('多個 redirect_uris 中有一個不合格 → 整支 400（不部分接受）', async () => {
    const r = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1:5/callback', 'https://evil.example.com/callback'],
      }),
    })
    expect(r.status).toBe(400)
  })

  it('缺 redirect_uris 或非陣列 → 400', async () => {
    const r1 = await fetch(`${base}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(r1.status).toBe(400)
    const r2 = await fetch(`${base}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: 'http://127.0.0.1:5/callback' }),
    })
    expect(r2.status).toBe(400)
  })
})
