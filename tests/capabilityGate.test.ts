import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { hostSupportsApps, buildApp } from '../src/server/app.js'
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import { openDb } from '../src/store/db.js'
import { randomUUID } from 'node:crypto'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

describe('hostSupportsApps', () => {
  it('宣告 ui extension + 支援 mime → true', () => {
    const caps = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } }
    expect(hostSupportsApps(caps)).toBe(true)
  })
  it('未宣告 ui extension → false', () => {
    expect(hostSupportsApps({})).toBe(false)
    expect(hostSupportsApps(null)).toBe(false)
  })
  it('宣告 extension 但不含我們的 mime → false', () => {
    const caps = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/plain'] } } }
    expect(hostSupportsApps(caps)).toBe(false)
  })
})

describe('registerAppTool SDK 行為（先驗 SDK API 形狀，供 newServer 分派用）', () => {
  it('registerAppTool 註冊的工具在 tools/list 帶 _meta.ui.resourceUri', async () => {
    const server = new McpServer({ name: 't', version: '0' })
    registerAppTool(server, 'demo', {
      description: 'd', inputSchema: {}, outputSchema: { ok: z.boolean() },
      _meta: { ui: { resourceUri: 'ui://x/y.html' } },
    }, async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } }))
    const [cs, ss] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'c', version: '0' })
    await Promise.all([server.connect(ss), client.connect(cs)])
    const list = await client.listTools()
    const demo = list.tools.find(t => t.name === 'demo')!
    expect((demo._meta as any).ui.resourceUri).toBe('ui://x/y.html')
  })
})

// Task 8: app_get_changeset_view / app_get_confirm_link 是 app-only 工具，只在 host 宣告 MCP
// Apps ui extension 時才透過 registerAppTool 註冊（見 app.ts newServer 的 appsOk 分支）。未宣告
// 的 host（一般 LLM tool-call 面）連工具存在都看不到——這裡對真實 buildApp 跑一次 tools/list
// 驗證兩種 host 的差異，而不只是驗 SDK 本身的行為（上面兩個 describe 已驗過 SDK 形狀）。
describe('app-only tools 的 capability-gate（透過真實 buildApp /mcp path）', () => {
  function fakeJwt(expSec: number): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec })}.sig`
  }

  let http: Server, base: string, db: Database.Database
  const BEARER = 'be2mcp_' + 'c'.repeat(48)

  beforeAll(async () => {
    db = openDb(':memory:')
    const identityId = randomUUID()
    new IdentityStore(db).upsert({
      identityId, userLabel: 'pilot@kkday.com',
      accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'r', businessList: [],
      accessExpiresAt: Date.now() + 3600_000, updatedAt: Date.now(),
    })
    new CredentialStore(db).insert({
      credHash: CredentialStore.hash(BEARER), identityId, kind: 'static_bearer', expiresAt: null, updatedAt: Date.now(),
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

  function client(capabilities?: Record<string, unknown>) {
    return {
      client: new Client({ name: 'it-test', version: '0.0.1' }, capabilities ? { capabilities: capabilities as never } : undefined),
      transport: new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${BEARER}` } },
      }),
    }
  }

  it('host 宣告 ui extension -> tools/list 含 app_get_changeset_view / app_get_confirm_link', async () => {
    const { client: c, transport } = client({
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } },
    })
    await c.connect(transport)
    const { tools } = await c.listTools()
    expect(tools.map(t => t.name)).toContain('app_get_changeset_view')
    expect(tools.map(t => t.name)).toContain('app_get_confirm_link')
    await c.close()
  })

  it('host 未宣告 ui extension -> tools/list 不含這兩個 app-only 工具（連存在都看不到）', async () => {
    const { client: c, transport } = client()
    await c.connect(transport)
    const { tools } = await c.listTools()
    expect(tools.map(t => t.name)).not.toContain('app_get_changeset_view')
    expect(tools.map(t => t.name)).not.toContain('app_get_confirm_link')
    await c.close()
  })
})
