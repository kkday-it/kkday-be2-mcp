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

let server: Server, base: string, store: ChangeSetStore, live: { is_active: boolean }
beforeEach(async () => {
  const db = openDb(':memory:'); store = new ChangeSetStore(db, { now: () => 1000 }); live = { is_active: true }
  const gateway = { get: async (p: string) => p.includes('/info') ? { name: 'Prod A' } : { is_active: live.is_active }, put: async () => { live.is_active = false; return {} } } as never
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
})
