import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openTestDb } from './support/testDb.js'
import type { Config } from '../src/config.js'
import type { Db } from '../src/store/dbTypes.js'

// Task 6：OAuth discovery（RFC 9728 protected-resource + RFC 8414 authorization-server metadata）。
// 這兩支是 Claude OAuth client 拿到 be2-mcp base URL 後第一個打的端點，公開、不需 bearer。
let http: Server, base: string, db: Db

beforeAll(async () => {
  db = await openTestDb()
  const config: Config = {
    authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
    serviceKey: 'sk', port: 0, db: { host: 'localhost', ssl: false }, schedulerMode: 'poller', auditStdout: false, otelMode: 'off', scheduleTz: 'Asia/Taipei',
    bindHost: '127.0.0.1', publicBaseUrl: 'https://mcp.stage.example',
  }
  const app = buildApp({ config, db })
  http = createServer(app)
  await new Promise<void>(r => http.listen(0, () => r()))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterAll(async () => { http.close(); await db.close() })

describe('OAuth discovery', () => {
  it('authorization-server metadata 宣告 S256 + none + endpoints', async () => {
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`)
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(body.response_types_supported).toEqual(['code'])
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    // 端點須為絕對 URL（本 AS 的 base），且都掛在同一個 issuer 之下——
    // 現在 baseUrl 由 config.publicBaseUrl 驅動（Task 2），測試斷言具體值 https://mcp.stage.example。
    expect(body.issuer).toBe('https://mcp.stage.example')
    expect(body.authorization_endpoint).toBe('https://mcp.stage.example/oauth/authorize')
    expect(body.token_endpoint).toBe('https://mcp.stage.example/oauth/token')
    expect(body.registration_endpoint).toBe('https://mcp.stage.example/oauth/register')
    expect(body.revocation_endpoint).toBe('https://mcp.stage.example/oauth/revoke')
    expect(body.revocation_endpoint_auth_methods_supported).toEqual(['none'])
  })

  it('protected-resource metadata 指向本 AS', async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource`)
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(body.resource).toBe('https://mcp.stage.example')
    expect(body.authorization_servers).toEqual(['https://mcp.stage.example'])
  })
})
