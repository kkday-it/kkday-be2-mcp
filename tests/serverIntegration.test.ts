import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import { TokenStore } from '../src/store/tokenStore.js'
import { AuditLog } from '../src/audit/auditLog.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

function fakeJwt(expSec: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec })}.sig`
}

let http: Server, base: string, db: Database.Database
const BEARER = 'be2mcp_' + 'a'.repeat(48)
const BEARER_B = 'be2mcp_' + 'b'.repeat(48)

beforeAll(async () => {
  db = openDb(':memory:')
  new TokenStore(db).upsert({
    bearerHash: TokenStore.hashBearer(BEARER), userLabel: 'pilot@kkday.com',
    accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'r', businessList: [],
    accessExpiresAt: Date.now() + 3600_000, updatedAt: Date.now(),
  })
  new TokenStore(db).upsert({
    bearerHash: TokenStore.hashBearer(BEARER_B), userLabel: 'other@kkday.com',
    accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'r', businessList: [],
    accessExpiresAt: Date.now() + 3600_000, updatedAt: Date.now(),
  })
  const config: Config = {
    authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
    serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off',
  }
  const app = buildApp({ config, db })
  http = createServer(app)
  await new Promise<void>(r => http.listen(0, () => r()))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>(r => http.close(() => r())))

function mcpClient(bearer?: string) {
  return {
    client: new Client({ name: 'it-test', version: '0.0.1' }),
    transport: new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined,
    }),
  }
}

describe('MCP server integration', () => {
  it('healthz is open', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
  })
  it('rejects /mcp without a known bearer (401)', async () => {
    const { client, transport } = mcpClient()
    await expect(client.connect(transport)).rejects.toThrow()
    const bad = mcpClient('be2mcp_' + 'f'.repeat(48))
    await expect(bad.client.connect(bad.transport)).rejects.toThrow()
  })
  it('initializes and lists exactly the 3 L0 tools', async () => {
    const { client, transport } = mcpClient(BEARER)
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(
      ['be2_find_products', 'be2_get_inventory_settings', 'be2_get_product_plans'])
    await client.close()
  })
  it('tool call flows through pipeline: gateway unreachable -> envelope error + audit row', async () => {
    const { client, transport } = mcpClient(BEARER)
    await client.connect(transport)
    const res = await client.callTool({ name: 'be2_find_products', arguments: { prod_oids: ['p1'] } })
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    const env = JSON.parse(text)
    expect(env.errors?.[0]?.key ?? env.error).toBeDefined() // gw.invalid is unreachable
    const audit = new AuditLog(db).recent()
    expect(audit[0]).toMatchObject({ tool: 'be2_find_products', userLabel: 'pilot@kkday.com' })
    expect(audit[0].traceId).toBeTruthy()
    await client.close()
  })
  it('rejects a session-id reused with a different bearer (session ownership binding, spec §6.2)', async () => {
    const { client, transport } = mcpClient(BEARER)
    await client.connect(transport)
    const sessionId = transport.sessionId
    expect(sessionId).toBeTruthy()

    // Forge: A's session-id + B's bearer, via raw fetch (SDK client hides session wiring).
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${BEARER_B}`,
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 99, method: 'tools/call',
        params: { name: 'be2_find_products', arguments: { prod_oids: ['p1'] } },
      }),
    })
    const body = await res.json() as { error: { code: string } }
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('SESSION_OWNER_MISMATCH')
    await client.close()
  })
})
