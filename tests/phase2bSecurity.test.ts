import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

// Phase 2b exit-gate security tests (Task 7). Unlike tests/confirmRoutes.test.ts (which exercises
// buildConfirmRouter in isolation), these spin the FULL built app (buildApp), the same way
// tests/serverIntegration.test.ts does — real route mounting order, real cookie parsing, real
// requireSession wiring — because the two invariants below are exactly what the Phase 2b design
// spec calls the point of the whole exercise, and an isolated-router test can't rule out a
// route-wiring mistake (e.g. a second, forgotten mount of the old capability-token router).
//
//   1. self-approval-closed: the agent that creates a change-set always knows its id (it reports
//      it to the operator) — so the only thing standing between "agent creates + approves its own
//      write" is that the agent has no be2-auth session cookie. This test also tries the REMOVED
//      Phase 2a capability-token query param (`?token=`) to prove that mechanism isn't just
//      unused, it's gone: nothing in confirmRoutes.ts reads req.query at all.
//   2. IDOR: a logged-in be2-auth session for a DIFFERENT be2 user cannot approve (or even view)
//      someone else's change-set.
//
// A third test re-adds a Phase 2a-era regression test that was dropped when Task 5 rewired
// confirmRoutes.ts from capability-token to session-cookie auth (git 766cc9b deleted the
// capability-token version of this exact case): a change-set that already executed to 'done'
// must reject a subsequent /reject with 409, not silently accept a decision on it.

function fakeJwt(claims: Record<string, unknown> = {}): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`
}

let httpServer: Server, base: string, db: Database.Database, store: ChangeSetStore, webSessions: WebSessionStore

function seed(id: string, creatorLabel = 'owner@kkday.com') {
  store.create({
    id, creatorLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
    items: [{ prod_oid: 'p1', target_is_active: false }],
    diff: [{ prod_oid: 'p1', name: 'Prod A', current_is_active: true, target_is_active: false, no_op: false }],
    // createdAt must be "now", not a frozen small number: buildApp's own ChangeSetStore instance
    // (used by the real server code under test) reads the REAL Date.now() — unlike this file's
    // local `store`, it has no frozen clock — so a stale createdAt would make the server's own
    // TTL check (ChangeSetStore.get()) flip the row to 'expired' the moment the server reads it.
    diffVersion: 'seed', status: 'pending_approval', createdAt: Date.now(),
  })
}

// Task 4: a real confirm-page session is a 'web_session'-kind credential (minted by ssoRoutes.ts's
// /confirm/session), not the generic 'static_bearer' enroll.ts produces. Mint it the same way
// here — via IdentityStore/CredentialStore directly against the shared `db` — so requireSession's
// credential-kind gate accepts these fixture sessions exactly like a real be2-auth SSO login would.
function seedSession(sid: string, userLabel: string) {
  const identities = new IdentityStore(db)
  const credentials = new CredentialStore(db)
  const identityId = `ident-${sid}`
  identities.upsert({
    identityId, userLabel,
    accessToken: fakeJwt({ authKey: userLabel }), refreshToken: 'r', businessList: [],
    accessExpiresAt: Date.now() + 3600_000, updatedAt: Date.now(),
  })
  credentials.insert({
    credHash: CredentialStore.hash(sid), identityId, kind: 'web_session', expiresAt: null, updatedAt: Date.now(),
  })
  webSessions.create(sid, identityId)
  return identityId
}

async function startApp(gatewayUrl = 'https://gw.invalid'): Promise<void> {
  const config: Config = {
    authsvcUrl: 'https://auth.invalid', gatewayUrl,
    serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off',
  }
  const app = buildApp({ config, db })
  httpServer = createServer(app)
  await new Promise<void>(r => httpServer.listen(0, () => r()))
  base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
}

beforeEach(async () => {
  db = openDb(':memory:')
  store = new ChangeSetStore(db)
  webSessions = new WebSessionStore(db)
  seedSession('sid-owner', 'owner@kkday.com')
  seedSession('sid-other', 'other@kkday.com')
  await startApp()
})

afterEach(async () => {
  await new Promise<void>(r => httpServer.close(() => r()))
  vi.unstubAllGlobals()
})

describe('phase2b security — self-approval closed (Phase 2a hole, closed by SSO session auth)', () => {
  it('POST /confirm/<id>/approve with NO cookie AND the removed ?token= capability param does not execute', async () => {
    seed('cs-self')
    // An agent (or anyone forwarding the change-set id it was told) tries the OLD Phase 2a
    // capability-token contract: no session cookie, just `?token=` on the URL.
    const res = await fetch(`${base}/confirm/cs-self/approve?token=anything-an-agent-could-guess-or-relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diff_version: 'seed' }),
      redirect: 'manual',
    })
    // requireSession only ever looks at the be2mcp_sid cookie — the query string is never read —
    // so this fails exactly like a bare request with no cookie at all: redirect to login, no 200.
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/confirm/login?next=%2Fconfirm%2Fcs-self')
    expect(store.get('cs-self')!.status).toBe('pending_approval')
  })

  it('GET /confirm/<id> with the removed ?token= capability param does not leak the diff either', async () => {
    seed('cs-self-2')
    const res = await fetch(`${base}/confirm/cs-self-2?token=anything`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/confirm/login')
  })
})

describe('phase2b security — IDOR (a different be2 user cannot touch your change-set)', () => {
  it('a valid session cookie for a DIFFERENT user cannot approve -> 404, no execute', async () => {
    seed('cs-idor', 'owner@kkday.com')
    const res = await fetch(`${base}/confirm/cs-idor/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'be2mcp_sid=sid-other' },
      body: JSON.stringify({ diff_version: 'seed' }),
      redirect: 'manual',
    })
    expect(res.status).toBe(404)
    expect(store.get('cs-idor')!.status).toBe('pending_approval')
  })

  it('a valid session cookie for a DIFFERENT user cannot even view the change-set -> 404 (no existence leak)', async () => {
    seed('cs-idor-2', 'owner@kkday.com')
    const res = await fetch(`${base}/confirm/cs-idor-2`, { headers: { cookie: 'be2mcp_sid=sid-other' } })
    expect(res.status).toBe(404)
  })
})

// Resolves the be2 identity a session secret's credential currently points at (undefined once the
// credential — and, if orphaned, the identity — has been purged). Mirrors what
// TokenStore.getByBearerHash used to answer, without the deleted adapter.
function identityFor(secret: string) {
  const cred = new CredentialStore(db).get(CredentialStore.hash(secret))
  if (!cred) return undefined
  return new IdentityStore(db).get(cred.identityId)
}

describe('phase2b security — session teardown purges the be2 token, not just the web-session row (Fix 2)', () => {
  it('POST /confirm/logout purges the be2 token for that session', async () => {
    expect(identityFor('sid-owner')).toBeDefined()
    const res = await fetch(`${base}/confirm/logout`, { method: 'POST', headers: { cookie: 'be2mcp_sid=sid-owner' } })
    expect(res.status).toBe(200)
    expect(identityFor('sid-owner')).toBeUndefined()
  })

  it('an idle-expired session, once lazily reaped by requireSession, also purges its be2 token', async () => {
    // The app's own WebSessionStore instance has no fake clock injected (default idleTtlMs 8h) —
    // backdate last_seen_at directly to simulate 9h of inactivity without a real wait.
    db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE session_id = ?').run(Date.now() - 9 * 3600_000, 'sid-owner')
    expect(identityFor('sid-owner')).toBeDefined()
    const res = await fetch(`${base}/confirm/anything`, { headers: { cookie: 'be2mcp_sid=sid-owner' }, redirect: 'manual' })
    expect(res.status).toBe(302) // idle-expired -> requireSession treats as no-session -> login redirect
    expect(identityFor('sid-owner')).toBeUndefined()
  })

  it('logout of one credential does NOT orphan an identity another credential (e.g. the Phase 1a static bearer) still references', async () => {
    // Non-vacuous against purgeCredential's identity-survival branch (src/server/app.ts): if
    // purgeCredential unconditionally deleted the identity instead of checking
    // countByIdentity(...) === 0 first, this would fail — the static_bearer credential minted
    // below would be orphaned even though it never logged out.
    const credentials = new CredentialStore(db)
    const sharedIdentityId = seedSession('sid-shared', 'shared@kkday.com')
    credentials.insert({ credHash: CredentialStore.hash('static-bearer-shared'), identityId: sharedIdentityId, kind: 'static_bearer', expiresAt: null, updatedAt: Date.now() })

    const res = await fetch(`${base}/confirm/logout`, { method: 'POST', headers: { cookie: 'be2mcp_sid=sid-shared' } })
    expect(res.status).toBe(200)

    expect(identityFor('sid-shared')).toBeUndefined()               // the web_session credential is gone
    expect(identityFor('static-bearer-shared')).toBeDefined()       // the identity + sibling credential survive
  })
})

describe('phase2b security — reject-after-done (carry-forward from Phase 2a, session-auth version)', () => {
  it('reject after approve/execute -> 409, status stays done (cannot reject a done change-set)', async () => {
    // This case needs a change-set to actually reach 'done', which needs both (a) a gateway that
    // answers with real data instead of an unreachable host, and (b) the modify_user placeholder
    // escape hatch (src/server/app.ts throws by default — see tests/modifyUserPlaceholder.test.ts —
    // since the real userUuid resolver is still a documented SIT blocker).
    const ORIGINAL_FLAG = process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER
    process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER = '1'
    try {
      let liveIsActive = true
      const realFetch = globalThis.fetch
      // Only intercept calls to the (fake) gateway host; anything else — including this test's own
      // requests to the locally-listening app — passes through to the real network stack.
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (!url.startsWith('https://gw.invalid')) return realFetch(input as never, init)
        const method = (init?.method ?? 'GET').toUpperCase()
        if (url.includes('/drafts/products/') && url.includes('/info')) {
          return new Response(JSON.stringify({ name: 'Prod A' }), { status: 200 })
        }
        if (url.includes('/product-configs/') && url.includes('/switch')) {
          if (method === 'PUT') { liveIsActive = false; return new Response(JSON.stringify({}), { status: 200 }) }
          return new Response(JSON.stringify({ is_active: liveIsActive }), { status: 200 })
        }
        return new Response(JSON.stringify({}), { status: 404 })
      }))
      // Rebuild the app so its GatewayClient captures the stubbed fetch (it reads the global once,
      // in its constructor).
      await new Promise<void>(r => httpServer.close(() => r()))
      await startApp()

      seed('cs-done', 'owner@kkday.com')
      const g = await fetch(`${base}/confirm/cs-done`, { headers: { cookie: 'be2mcp_sid=sid-owner' } })
      const dv = /data-diff-version="([^"]+)"/.exec(await g.text())![1]

      const approveRes = await fetch(`${base}/confirm/cs-done/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'be2mcp_sid=sid-owner' },
        body: JSON.stringify({ diff_version: dv }),
      })
      expect(approveRes.status).toBe(200)
      expect(store.get('cs-done')!.status).toBe('done')

      const rejectRes = await fetch(`${base}/confirm/cs-done/reject`, {
        method: 'POST',
        headers: { cookie: 'be2mcp_sid=sid-owner' },
      })
      expect(rejectRes.status).toBe(409)
      expect(store.get('cs-done')!.status).toBe('done')
    } finally {
      if (ORIGINAL_FLAG === undefined) delete process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER
      else process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER = ORIGINAL_FLAG
    }
  })
})
