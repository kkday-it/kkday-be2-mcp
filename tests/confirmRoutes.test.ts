import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { buildConfirmRouter } from '../src/server/confirmRoutes.js'
import type { Server } from 'node:http'

// minimal fetch helper
async function http(base: string, method: string, path: string, body?: object) {
  const res = await fetch(`${base}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  return { status: res.status, text: await res.text(), headers: res.headers }
}
function seed(store: ChangeSetStore, current: boolean, target: boolean) {
  const token = 'tok-abc'
  store.create({ id: 'cs1', creatorLabel: 'owner@kkday.com', creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
    items: [{ prod_oid: 'p1', target_is_active: target }],
    diff: [{ prod_oid: 'p1', name: 'Prod A', current_is_active: current, target_is_active: target, no_op: current === target }],
    diffVersion: 'seed', status: 'pending_approval', approvalTokenHash: ChangeSetStore.hashToken(token), createdAt: 1000 })
  return token
}

let server: Server, base: string, store: ChangeSetStore, db: ReturnType<typeof openDb>, live: { is_active: boolean }, putCalls: number
beforeEach(async () => {
  db = openDb(':memory:'); store = new ChangeSetStore(db, { now: () => 1000 }); live = { is_active: true }; putCalls = 0
  const gateway = {
    // Delay on the live-state read inside liveDiff() — this is what widens the race window between
    // a request's initial `status === 'pending_approval'` check and its eventual status-transition
    // call, letting a second concurrent approve's initial check run (and pass) before the first
    // request transitions the status away from pending_approval.
    get: async (p: string) => { if (p.includes('/info')) return { name: 'Prod A' }; await new Promise(r => setTimeout(r, 15)); return { is_active: live.is_active } },
    put: async () => { putCalls++; live.is_active = false; return {} },
  } as never
  const tokenManager = { getFreshByHash: async () => ({ accessToken: 'f', userLabel: 'owner@kkday.com', businessList: [] }) } as never
  const router = buildConfirmRouter({ changeSets: store, gateway, tokenManager, audit: new AuditLog(db, () => 1000), modifyUserFrom: () => 'U', now: () => 1000 })
  const app = express(); app.use(express.json()); app.use(router)
  server = app.listen(0); await new Promise(r => server.on('listening', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

describe('confirm routes', () => {
  it('GET with bad token -> 404', async () => {
    seed(store, true, false)
    expect((await http(base, 'GET', '/confirm/cs1?token=WRONG')).status).toBe(404)
    expect((await http(base, 'GET', '/confirm/cs1?token=tok-abc')).status).toBe(200)
  })
  it('GET sets Referrer-Policy: no-referrer and shows the product name + target', async () => {
    seed(store, true, false)
    const r = await http(base, 'GET', '/confirm/cs1?token=tok-abc')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    expect(r.text).toContain('Prod A')
  })
  it('approve executes when diff_version matches live, sets done, writes', async () => {
    const token = seed(store, true, false)
    // live diff_version = hash of current is_active=true
    const g = await http(base, 'GET', `/confirm/cs1?token=${token}`)
    const dv = /data-diff-version="([^"]+)"/.exec(g.text)![1]
    const r = await http(base, 'POST', '/confirm/cs1/approve', { token, diff_version: dv })
    expect(r.status).toBe(200)
    expect(store.get('cs1')!.status).toBe('done')
    expect(live.is_active).toBe(false)
  })
  it('approve with stale diff_version -> 409, does NOT execute', async () => {
    const token = seed(store, true, false)
    const r = await http(base, 'POST', '/confirm/cs1/approve', { token, diff_version: 'STALE' })
    expect(r.status).toBe(409)
    expect(store.get('cs1')!.status).toBe('pending_approval')
    expect(live.is_active).toBe(true)
  })
  it('reject sets rejected', async () => {
    const token = seed(store, true, false)
    await http(base, 'POST', '/confirm/cs1/reject', { token })
    expect(store.get('cs1')!.status).toBe('rejected')
  })

  it('approve writes a route-level audit row for the human DECISION (Fix 2)', async () => {
    const token = seed(store, true, false)
    const g = await http(base, 'GET', `/confirm/cs1?token=${token}`)
    const dv = /data-diff-version="([^"]+)"/.exec(g.text)![1]
    await http(base, 'POST', '/confirm/cs1/approve', { token, diff_version: dv })
    const rows = new AuditLog(db).recent()
    const decision = rows.find(r => r.tool === 'changeset.approve')
    expect(decision).toMatchObject({ userLabel: 'owner@kkday.com', status: 'ok' })
    expect((decision!.params as { changeset_id?: string }).changeset_id).toBe('cs1')
  })

  it('reject writes a route-level audit row for the human DECISION (Fix 2)', async () => {
    const token = seed(store, true, false)
    await http(base, 'POST', '/confirm/cs1/reject', { token })
    const rows = new AuditLog(db).recent()
    const decision = rows.find(r => r.tool === 'changeset.reject')
    expect(decision).toMatchObject({ userLabel: 'owner@kkday.com', status: 'ok' })
    expect((decision!.params as { changeset_id?: string }).changeset_id).toBe('cs1')
  })

  it('double-approve is exactly-once: concurrent approves fire the gateway write only once', async () => {
    const token = seed(store, true, false)
    const g = await http(base, 'GET', `/confirm/cs1?token=${token}`)
    const dv = /data-diff-version="([^"]+)"/.exec(g.text)![1]
    // Fire both approves concurrently (not sequentially-awaited) so both requests race past the
    // status===pending_approval read before either finishes the async liveDiff() recompute — this
    // is the actual race window a double-click / client retry would hit. Without the CAS fix, both
    // requests pass the check, both call executeChangeSet, and the gateway PUT fires twice.
    const [r1, r2] = await Promise.all([
      http(base, 'POST', '/confirm/cs1/approve', { token, diff_version: dv }),
      http(base, 'POST', '/confirm/cs1/approve', { token, diff_version: dv }),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
    expect(store.get('cs1')!.status).toBe('done')
    expect(putCalls).toBe(1) // the real gateway write happened exactly once
  })

  it('reject after approve/execute -> 409, status stays done (can\'t reject a done change-set)', async () => {
    const token = seed(store, true, false)
    const g = await http(base, 'GET', `/confirm/cs1?token=${token}`)
    const dv = /data-diff-version="([^"]+)"/.exec(g.text)![1]
    const approveRes = await http(base, 'POST', '/confirm/cs1/approve', { token, diff_version: dv })
    expect(approveRes.status).toBe(200)
    expect(store.get('cs1')!.status).toBe('done')
    const rejectRes = await http(base, 'POST', '/confirm/cs1/reject', { token })
    expect(rejectRes.status).toBe(409)
    expect(store.get('cs1')!.status).toBe('done')
  })
})
