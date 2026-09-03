import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import { openTestDb } from './support/testDb.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { buildConfirmRouter } from '../src/server/confirmRoutes.js'
import type { Server } from 'node:http'
import type { Db } from '../src/store/dbTypes.js'

// Task 4: requireSession's credential-kind gate is the structural half of "an agent cannot
// self-approve its own change-set" (鐵則 #4). The confirm page's be2mcp_sid cookie must resolve
// to a credential minted BY the confirm-page SSO login (kind === 'web_session'). An agent that
// holds its own MCP credential (oauth_access — a reference token Claude was handed, or
// static_bearer — the Phase 1a pilot bearer) and sends that SAME secret as the be2mcp_sid cookie
// must be rejected — not because the secret is unknown (it is a perfectly valid, known
// credential), but because it is the WRONG KIND for this surface.

async function http(base: string, method: string, path: string, body?: object, cookie?: string) {
  const headers: Record<string, string> = {}
  if (body) headers['content-type'] = 'application/json'
  if (cookie) headers['cookie'] = cookie
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  return { status: res.status, text: await res.text(), headers: res.headers }
}

// Both secrets below resolve to the SAME identity/userLabel on purpose: if identity differed
// too, a rejection could be (wrongly) explained by the IDOR/creator check instead of the kind
// gate. Isolating identity as a control variable is what makes the "denied" assertion below
// non-vacuous against the kind check specifically.
const SID_WEB = 'sid-real-web-session'     // secret behind a kind='web_session' credential
const SID_OAUTH = 'tok-agents-own-mcp-bearer' // secret behind a kind='oauth_access' credential
const IDENTITY = 'ident-shared-1'
const USER_LABEL = 'owner@kkday.com'

let server: Server, base: string, store: ChangeSetStore, db: Db

async function seed(id: string) {
  await store.create({
    id, creatorLabel: USER_LABEL, creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
    items: [{ prod_oid: 'p1', target_is_active: false }],
    diff: [{ prod_oid: 'p1', name: 'Prod A', current_is_active: true, target_is_active: false, no_op: false }],
    diffVersion: 'seed', status: 'pending_approval', createdAt: 1000,
  })
}

beforeEach(async () => {
  db = await openTestDb()
  store = new ChangeSetStore(db, { now: () => 1000 })
  const webSessions = new WebSessionStore(db, { now: () => 1000 })
  const credentials = new CredentialStore(db)

  await credentials.insert({ credHash: CredentialStore.hash(SID_WEB), identityId: IDENTITY, kind: 'web_session', expiresAt: null, updatedAt: 1000 })
  await credentials.insert({ credHash: CredentialStore.hash(SID_OAUTH), identityId: IDENTITY, kind: 'oauth_access', expiresAt: null, updatedAt: 1000 })
  // A web_sessions row is seeded for BOTH secrets — including the oauth one, which would never
  // happen for a real agent bearer in production (nothing ever calls webSessions.create for an
  // MCP token). This decoy row rules out "no web_sessions row" as the reason SID_OAUTH gets
  // rejected below, isolating the credential-kind check as the actual, only, mechanism at work.
  await webSessions.create(SID_WEB, IDENTITY)
  await webSessions.create(SID_OAUTH, IDENTITY)

  const tokenManager = {
    getFreshByCredHash: async (hash: string) => {
      if (hash === CredentialStore.hash(SID_WEB) || hash === CredentialStore.hash(SID_OAUTH)) {
        return { accessToken: 'AT', userLabel: USER_LABEL, businessList: [] }
      }
      throw new Error('unknown cred hash')
    },
  } as never

  const gateway = {
    get: async (p: string) => (p.includes('/info') ? { name: 'Prod A' } : { is_active: true }),
    put: async () => ({}),
  } as never

  const router = buildConfirmRouter({
    changeSets: store, gateway, tokenManager, webSessions, credentials,
    audit: new AuditLog(db, () => 1000), modifyUserFrom: (at: string) => 'U:' + at, now: () => 1000,
  })
  const app = express(); app.use(express.json()); app.use(router)
  server = app.listen(0); await new Promise(r => server.on('listening', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

describe('requireSession — credential kind gate (Task 4)', () => {
  it('a real web_session credential (be2-auth SSO login) is let through', async () => {
    await seed('cs1')
    const res = await http(base, 'GET', '/confirm/cs1', undefined, `be2mcp_sid=${SID_WEB}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('Prod A')
  })

  it('the SAME identity\'s oauth_access credential, sent AS the cookie, is denied — proves the kind gate, not just IDOR', async () => {
    await seed('cs2')
    const res = await http(base, 'GET', '/confirm/cs2', undefined, `be2mcp_sid=${SID_OAUTH}`)
    // Not 404 (that's the creator/IDOR check further down the handler) — a 302 to login:
    // requireSession itself returned undefined because cred.kind !== 'web_session', so the
    // request never even reaches the creator comparison.
    // Non-vacuous: remove the `cred.kind !== 'web_session'` check from requireSession and this
    // becomes 200 (same identity/userLabel as SID_WEB, same seeded webSessions row, same
    // tokenManager stub answer) — so this assertion fails without the kind gate in place.
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/confirm/login?next=%2Fconfirm%2Fcs2')
    expect((await store.get('cs2'))!.status).toBe('pending_approval')
  })
})
