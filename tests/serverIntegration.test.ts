import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import { randomUUID } from 'node:crypto'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { AuditLog } from '../src/audit/auditLog.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

function fakeJwt(expSec: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec })}.sig`
}

// Task 5: enrolls a bearer directly via IdentityStore + CredentialStore (no TokenStore adapter
// left to route through). Returns the identityId so tests can mint a SECOND credential pointing
// at the SAME identity (the sessionOwner-by-identity test below needs exactly that).
function enrollBearer(db: Database.Database, bearer: string, userLabel: string, identityId = randomUUID()): string {
  new IdentityStore(db).upsert({
    identityId, userLabel,
    accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'r', businessList: [],
    accessExpiresAt: Date.now() + 3600_000, updatedAt: Date.now(),
  })
  new CredentialStore(db).insert({
    credHash: CredentialStore.hash(bearer), identityId, kind: 'static_bearer', expiresAt: null, updatedAt: Date.now(),
  })
  return identityId
}

let http: Server, base: string, db: Database.Database
const BEARER = 'be2mcp_' + 'a'.repeat(48)
const BEARER_B = 'be2mcp_' + 'b'.repeat(48)

beforeAll(async () => {
  db = openDb(':memory:')
  enrollBearer(db, BEARER, 'pilot@kkday.com')
  enrollBearer(db, BEARER_B, 'other@kkday.com')
  const config: Config = {
    authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
    serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off', scheduleTz: 'Asia/Taipei',
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

// Task 6 carried-forward requirement (from Task 4 review): Task 4's newServer dispatch branch
// (registerAppTool vs plain registerTool, gated on hostSupportsApps(caps)) was only ever
// exercised against the bare SDK (capabilityGate.test.ts) — never through the real /mcp
// initialize -> tools/list path, and no real tool had uiResourceUri set yet so the appsOk
// branch never actually fired. Task 6 binds uiResourceUri onto the 5 real tools, so this test
// drives the real path end to end via a Client that declares the ui extension capability.
function mcpClientWithCapabilities(bearer: string, capabilities: Record<string, unknown>) {
  return {
    client: new Client({ name: 'it-test-apps', version: '0.0.1' }, { capabilities: capabilities as never }),
    transport: new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
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
  // Task 5: the /mcp gate now looks up the bearer through credentials.getBySecret directly
  // (rather than an intermediate TokenStore.getByBearer wrapper) — this exercises the same
  // known/unknown-bearer behavior against a raw fetch so a 401 body shape regression would show
  // up here even if the SDK client's rejects.toThrow() above swallowed status-code detail.
  it('/mcp：未知 bearer 401；credential 存在放行（改走 credentials.getBySecret）', async () => {
    const unknown = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    })
    expect(unknown.status).toBe(401)
    const { client, transport } = mcpClient(BEARER)
    await client.connect(transport) // known credential (BEARER, enrolled in beforeAll) -> passes the gate
    await client.close()
  })
  it('initializes and lists all 6 tools (4 L0 read + 2 L2 change-set)', async () => {
    const { client, transport } = mcpClient(BEARER)
    await client.connect(transport)
    const { tools } = await client.listTools()
    // Task 6: be2_open_workbench is model-visible (plain TOOLS entry, see src/server/app.ts)
    // and thus always listed, regardless of host Apps support — same as the pre-existing L0 tools.
    expect(tools.map(t => t.name).sort()).toEqual([
      'be2_create_changeset', 'be2_find_products', 'be2_get_changeset_status',
      'be2_get_inventory_settings', 'be2_get_product_plans', 'be2_open_workbench',
    ])
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
  it('sessionOwner 綁 identity：同 identity 的另一 credential 帶同 mcp-session-id 不觸發 SESSION_OWNER_MISMATCH', async () => {
    // Two DIFFERENT credentials (different secrets, different kinds) sharing ONE identity — the
    // rotation-survival property Task 5 exists for: a future OAuth reference-token rotation mints
    // a NEW credential row for the SAME identity, and an in-flight MCP session must not get
    // SESSION_OWNER_MISMATCH'd just because the bearer secret changed underneath it.
    //
    // Non-vacuous: before Task 5, sessionOwner was keyed by TokenStore.hashBearer(bearer) — the
    // CREDENTIAL's own hash — so BEARER_ROTATED (a different secret) would 403 even though it
    // resolves to the same identity as BEARER_SHARED. Only keying by cred.identityId makes this
    // pass; reverting app.ts's owner check to hash the bearer again reproduces a 403 here.
    const sharedIdentityId = randomUUID()
    const BEARER_SHARED = 'be2mcp_' + 'c'.repeat(48)
    const BEARER_ROTATED = 'be2mcp_' + 'd'.repeat(48)
    enrollBearer(db, BEARER_SHARED, 'shared@kkday.com', sharedIdentityId)
    // Second credential, deliberately a different kind (oauth_access) — same identity.
    new CredentialStore(db).insert({
      credHash: CredentialStore.hash(BEARER_ROTATED),
      identityId: sharedIdentityId, kind: 'oauth_access', expiresAt: null, updatedAt: Date.now(),
    })

    const { client, transport } = mcpClient(BEARER_SHARED)
    await client.connect(transport)
    const sessionId = transport.sessionId!

    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${BEARER_ROTATED}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 101, method: 'tools/call',
        params: { name: 'be2_find_products', arguments: { prod_oids: ['p1'] } },
      }),
    })
    expect(res.status).toBe(200) // NOT 403 — same identity, different credential
    await client.close()
  })
  it('redirects an unauthenticated confirm-page request to the SSO login route (session gate)', async () => {
    const res = await fetch(`${base}/confirm/some-random-id`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^\/confirm\/login\?next=/)
  })
  it('serves the SSO login page at /confirm/login (proves it is not swallowed by /confirm/:id, agy T4)', async () => {
    const res = await fetch(`${base}/confirm/login`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('loginFlow=POPUP')
  })
  it('rejects POST with unknown mcp-session-id (404 SESSION_NOT_FOUND)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${BEARER}`,
        'mcp-session-id': 'bogus-session-id',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 99, method: 'tools/call',
        params: { name: 'be2_find_products', arguments: { prod_oids: ['p1'] } },
      }),
    })
    const body = await res.json() as { error: { code: string } }
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('SESSION_NOT_FOUND')
  })
  it('rejects GET with unknown mcp-session-id (404 SESSION_NOT_FOUND)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${BEARER}`,
        'mcp-session-id': 'bogus-session-id',
      },
    })
    const body = await res.json() as { error: { code: string } }
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('SESSION_NOT_FOUND')
  })
})

describe('MCP Apps dispatch — real path (Task 6 carried-forward from Task 4 review)', () => {
  it('host declares the ui extension -> real tools carry _meta.ui.resourceUri', async () => {
    const { client, transport } = mcpClientWithCapabilities(BEARER, {
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } },
    })
    await client.connect(transport)
    const { tools } = await client.listTools()
    const findProducts = tools.find(t => t.name === 'be2_find_products')!
    expect((findProducts._meta as any)?.ui?.resourceUri).toBe('ui://be2/products-panel.html')
    const createChangeset = tools.find(t => t.name === 'be2_create_changeset')!
    expect((createChangeset._meta as any)?.ui?.resourceUri).toBe('ui://be2/changeset-panel.html')
    await client.close()
  })
  it('host does NOT declare the ui extension -> real tools carry no _meta.ui (plain registerTool path)', async () => {
    const { client, transport } = mcpClient(BEARER)
    await client.connect(transport)
    const { tools } = await client.listTools()
    const findProducts = tools.find(t => t.name === 'be2_find_products')!
    expect((findProducts._meta as any)?.ui).toBeUndefined()
    await client.close()
  })
})
