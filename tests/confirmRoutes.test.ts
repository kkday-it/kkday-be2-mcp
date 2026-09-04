import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import { openTestDb } from './support/testDb.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { AuthError } from '../src/errors.js'
import { buildConfirmRouter } from '../src/server/confirmRoutes.js'
import type { Server } from 'node:http'
import type { Db } from '../src/store/dbTypes.js'

// minimal fetch helper — redirect:'manual' so we can assert 302s instead of following them.
async function http(base: string, method: string, path: string, body?: object, cookie?: string) {
  const headers: Record<string, string> = {}
  if (body) headers['content-type'] = 'application/json'
  if (cookie) headers['cookie'] = cookie
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  return { status: res.status, text: await res.text(), headers: res.headers }
}

const SID_A = 'sid-A'
const SID_B = 'sid-B'
const COOKIE_A = `be2mcp_sid=${SID_A}`
const COOKIE_B = `be2mcp_sid=${SID_B}`

async function seed(store: ChangeSetStore, id: string, current: boolean, target: boolean, creatorLabel = 'owner@kkday.com') {
  await store.create({
    id, creatorLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
    items: [{ prod_oid: 'p1', target_is_active: target }],
    diff: [{ prod_oid: 'p1', name: 'Prod A', current_is_active: current, target_is_active: target, no_op: current === target }],
    diffVersion: 'seed', status: 'pending_approval', createdAt: 1000,
  })
}

let server: Server, base: string, store: ChangeSetStore, db: Db, webSessions: WebSessionStore
let live: { is_active: boolean }, putCalls: number, putBearer: string | undefined
let tmMode: 'ok' | 'throw'
let modifyUserThrows: boolean

beforeEach(async () => {
  db = await openTestDb()
  store = new ChangeSetStore(db, { now: () => 1000 })
  webSessions = new WebSessionStore(db, { now: () => 1000 })
  const credentials = new CredentialStore(db)
  // Task 4: requireSession now gates on credentials.getBySecret(sid).kind === 'web_session' —
  // these fixtures must mint that credential (in addition to the web_sessions TTL row) for the
  // session cookies used throughout this file, mirroring what ssoRoutes.ts's /confirm/session
  // does on a real be2-auth login.
  await credentials.insert({ credHash: CredentialStore.hash(SID_A), identityId: 'ident-owner', kind: 'web_session', expiresAt: null, updatedAt: 1000 })
  await credentials.insert({ credHash: CredentialStore.hash(SID_B), identityId: 'ident-other', kind: 'web_session', expiresAt: null, updatedAt: 1000 })
  await webSessions.create(SID_A, 'ident-owner')
  await webSessions.create(SID_B, 'ident-other')
  live = { is_active: true }
  putCalls = 0
  putBearer = undefined
  tmMode = 'ok'
  modifyUserThrows = false

  const gateway = {
    withTrace() { return this },
    get: async (p: string) => { if (p.includes('/info')) return { name: 'Prod A' }; await new Promise(r => setTimeout(r, 15)); return { is_active: live.is_active } },
    put: async (_p: string, at: string) => { putCalls++; putBearer = at; live.is_active = false; return {} },
  } as never

  const sessionTokens: Record<string, { accessToken: string; userLabel: string }> = {
    [CredentialStore.hash(SID_A)]: { accessToken: 'sess-tok-A', userLabel: 'owner@kkday.com' },
    [CredentialStore.hash(SID_B)]: { accessToken: 'sess-tok-B', userLabel: 'other@kkday.com' },
  }
  const tokenManager = {
    getFreshByCredHash: async (hash: string) => {
      if (tmMode === 'throw') throw new AuthError('REAUTH_REQUIRED', 'be2 session dead', 401)
      const rec = sessionTokens[hash]
      if (!rec) throw new Error('unknown session hash')
      return { ...rec, businessList: [] }
    },
  } as never

  const modifyUserFrom = (at: string) => { if (modifyUserThrows) throw new Error('modify_user resolver failed'); return 'U:' + at }

  const router = buildConfirmRouter({
    changeSets: store, gateway, tokenManager, webSessions, credentials, audit: new AuditLog(db, () => 1000),
    modifyUserFrom, now: () => 1000,
  })
  const app = express(); app.use(express.json()); app.use(router)
  server = app.listen(0); await new Promise(r => server.on('listening', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

async function getDiffVersion(cookie: string, id = 'cs1'): Promise<string> {
  const g = await http(base, 'GET', `/confirm/${id}`, undefined, cookie)
  return /data-diff-version="([^"]+)"/.exec(g.text)![1]
}

describe('confirm routes — session-cookie auth', () => {
  it('no cookie -> GET redirects to /confirm/login; approve with no cookie is not executed', async () => {
    await seed(store, 'cs1', true, false)
    const g = await http(base, 'GET', '/confirm/cs1')
    expect(g.status).toBe(302)
    expect(g.headers.get('location')).toBe('/confirm/login?next=%2Fconfirm%2Fcs1')

    const a = await http(base, 'POST', '/confirm/cs1/approve', { diff_version: 'seed' })
    expect(a.status).toBe(302)
    expect((await store.get('cs1'))!.status).toBe('pending_approval')
    expect(putCalls).toBe(0)
  })

  it('dead session (getFreshByHash throws) -> requireSession deletes it + redirects, not a 500, no write', async () => {
    await seed(store, 'cs1', true, false)
    tmMode = 'throw'
    const g = await http(base, 'GET', '/confirm/cs1', undefined, COOKIE_A)
    expect(g.status).toBe(302)
    expect(g.headers.get('location')).toContain('/confirm/login')
    expect(await webSessions.get(SID_A)).toBeUndefined()
    expect(putCalls).toBe(0)
  })

  it('cookie of a DIFFERENT user -> 404 (IDOR, no existence leak)', async () => {
    await seed(store, 'cs1', true, false, 'owner@kkday.com')
    const g = await http(base, 'GET', '/confirm/cs1', undefined, COOKIE_B)
    expect(g.status).toBe(404)
    const a = await http(base, 'POST', '/confirm/cs1/approve', { diff_version: 'seed' }, COOKIE_B)
    expect(a.status).toBe(404)
    expect((await store.get('cs1'))!.status).toBe('pending_approval')
  })

  it('creatorLabel and session userLabel differing only by case/whitespace still match: creator can view AND approve their own change-set', async () => {
    // Regression for the IDOR fix: creatorLabel (bearer-side) and session userLabel (confirm-page
    // side) both derive from the JWT authKey now, but must tolerate incidental case/whitespace
    // differences rather than 404ing the change-set's own creator.
    await seed(store, 'cs1', true, false, '  Owner@KKday.com  ')
    const g = await http(base, 'GET', '/confirm/cs1', undefined, COOKIE_A)
    expect(g.status).toBe(200)
    const dv = await getDiffVersion(COOKIE_A)
    const r = await http(base, 'POST', '/confirm/cs1/approve', { diff_version: dv }, COOKIE_A)
    expect(r.status).toBe(200)
    expect((await store.get('cs1'))!.status).toBe('done')
  })

  it('GET sets Referrer-Policy: no-referrer and shows the product name', async () => {
    await seed(store, 'cs1', true, false)
    const r = await http(base, 'GET', '/confirm/cs1', undefined, COOKIE_A)
    expect(r.status).toBe(200)
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    expect(r.text).toContain('Prod A')
  })

  it('approve with matching diff_version executes once, sets done, writes with the SESSION token', async () => {
    await seed(store, 'cs1', true, false)
    const dv = await getDiffVersion(COOKIE_A)
    const r = await http(base, 'POST', '/confirm/cs1/approve', { diff_version: dv }, COOKIE_A)
    expect(r.status).toBe(200)
    expect((await store.get('cs1'))!.status).toBe('done')
    expect(live.is_active).toBe(false)
    expect(putBearer).toBe('sess-tok-A')
  })

  it('approve with stale diff_version -> 409, does NOT execute', async () => {
    await seed(store, 'cs1', true, false)
    const r = await http(base, 'POST', '/confirm/cs1/approve', { diff_version: 'STALE' }, COOKIE_A)
    expect(r.status).toBe(409)
    expect((await store.get('cs1'))!.status).toBe('pending_approval')
    expect(live.is_active).toBe(true)
    expect(putCalls).toBe(0)
  })

  it('double-approve (concurrent, same cookie) executes exactly once via CAS', async () => {
    await seed(store, 'cs1', true, false)
    const dv = await getDiffVersion(COOKIE_A)
    const [r1, r2] = await Promise.all([
      http(base, 'POST', '/confirm/cs1/approve', { diff_version: dv }, COOKIE_A),
      http(base, 'POST', '/confirm/cs1/approve', { diff_version: dv }, COOKIE_A),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
    expect((await store.get('cs1'))!.status).toBe('done')
    expect(putCalls).toBe(1)
  })

  it('approve writes an audit row with session_id/userLabel from the WEB session', async () => {
    await seed(store, 'cs1', true, false)
    const dv = await getDiffVersion(COOKIE_A)
    await http(base, 'POST', '/confirm/cs1/approve', { diff_version: dv }, COOKIE_A)
    const rows = await new AuditLog(db).recent()
    const decision = rows.find(r => r.tool === 'changeset.approve')
    // Not the raw cookie secret — see the dedicated SECURITY test below for why.
    expect(decision).toMatchObject({ userLabel: 'owner@kkday.com', sessionId: CredentialStore.hash(SID_A), status: 'ok' })
  })

  it('reject writes an audit row with session_id/userLabel from the WEB session', async () => {
    await seed(store, 'cs2', true, false)
    const r = await http(base, 'POST', '/confirm/cs2/reject', {}, COOKIE_A)
    expect(r.status).toBe(200)
    expect((await store.get('cs2'))!.status).toBe('rejected')
    const rows = await new AuditLog(db).recent()
    const decision = rows.find(row => row.tool === 'changeset.reject')
    expect(decision).toMatchObject({ userLabel: 'owner@kkday.com', sessionId: CredentialStore.hash(SID_A), status: 'ok' })
  })

  // SECURITY REGRESSION (credential-at-rest leak, final whole-branch review finding): the
  // be2mcp_sid cookie value IS the web_session credential's secret (credHash = sha256(sid)).
  // audit_log is append-only (no-delete trigger) — if the raw sid ever lands in a row, anyone who
  // can read the SQLite file/export gets a live, still-valid approval credential until idle-TTL/
  // logout, with no way to redact it after the fact. requireSession() must therefore hand back
  // cred.credHash (the already-stored, non-secret hash) as the audited sessionId, never the raw
  // cookie. This test fails if requireSession ever regresses to returning the raw sid.
  it('SECURITY: audit_log never stores the raw be2mcp_sid cookie secret, only its non-secret credHash', async () => {
    await seed(store, 'cs1', true, false)
    const dv = await getDiffVersion(COOKIE_A)
    await http(base, 'POST', '/confirm/cs1/approve', { diff_version: dv }, COOKIE_A)
    const rows = await new AuditLog(db).recent()
    const decision = rows.find(r => r.tool === 'changeset.approve')
    expect(decision).toBeDefined()
    expect(decision!.sessionId).not.toBe(SID_A)
    expect(decision!.sessionId).toBe(CredentialStore.hash(SID_A))
  })

  it('modifyUser resolution failure leaves the change-set pending_approval, not stranded', async () => {
    await seed(store, 'cs1', true, false)
    const dv = await getDiffVersion(COOKIE_A)
    modifyUserThrows = true
    const r = await http(base, 'POST', '/confirm/cs1/approve', { diff_version: dv }, COOKIE_A)
    expect(r.status).toBe(500)
    expect((await store.get('cs1'))!.status).toBe('pending_approval')
    expect(putCalls).toBe(0)
  })
})
