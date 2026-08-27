import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

// Task 6：OAuth discovery（RFC 9728 protected-resource + RFC 8414 authorization-server metadata）。
// 這兩支是 Claude OAuth client 拿到 be2-mcp base URL 後第一個打的端點，公開、不需 bearer。
let http: Server, base: string, db: Database.Database

beforeAll(async () => {
  db = openDb(':memory:')
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

describe('OAuth discovery', () => {
  it('authorization-server metadata 宣告 S256 + none + endpoints', async () => {
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`)
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(body.response_types_supported).toEqual(['code'])
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    // 端點須為絕對 URL（本 AS 的 base，非相對路徑），且都掛在同一個 issuer 之下——
    // 不比對測試 harness 實際監聽 port（buildApp 的 baseUrl 來自 config.port，測試用 listen(0)
    // 取隨機 port 兩者本就不相等，見 serverIntegration.test.ts 同樣落差），改驗內部自洽。
    expect(body.issuer).toMatch(/^https?:\/\//)
    expect(body.authorization_endpoint).toBe(`${body.issuer}/oauth/authorize`)
    expect(body.token_endpoint).toBe(`${body.issuer}/oauth/token`)
    expect(body.registration_endpoint).toBe(`${body.issuer}/oauth/register`)
    expect(body.revocation_endpoint).toBe(`${body.issuer}/oauth/revoke`)
    expect(body.revocation_endpoint_auth_methods_supported).toEqual(['none'])
  })

  it('protected-resource metadata 指向本 AS', async () => {
    const asBody = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>
    const r = await fetch(`${base}/.well-known/oauth-protected-resource`)
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(body.resource).toBe(asBody.issuer)
    expect(body.authorization_servers).toEqual([asBody.issuer])
  })
})
