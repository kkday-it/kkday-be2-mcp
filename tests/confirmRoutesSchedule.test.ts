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
import type { ShelfScheduleItem } from '../src/core/changeset/types.js'

// Task 4: mirrors the harness in tests/confirmRoutesInventory.test.ts (buildConfirmRouter in
// isolation, plain fetch against a listening express app, redirect:'manual') — but seeds
// shelf_schedule change-sets and a fake gateway shaped like tests/executorSchedule.test.ts's
// fakeGw (GET .../package-configs -> rows[], PUT .../package-configs/reserve-active).

async function http(base: string, method: string, path: string, body?: object, cookie?: string) {
  const headers: Record<string, string> = {}
  if (body) headers['content-type'] = 'application/json'
  if (cookie) headers['cookie'] = cookie
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  return { status: res.status, text: await res.text(), headers: res.headers }
}

const SID = 'sid-sched'
const COOKIE = `be2mcp_sid=${SID}`
const USER_LABEL = 'owner@kkday.com'

function fakeGw(opts: { rows: Array<Record<string, unknown>> }) {
  const calls: Array<{ m: string; path: string }> = []
  return {
    calls,
    rows: opts.rows,
    // NOTE: reads `this.rows` (not a closed-over `opts.rows`) so a test can mutate `gw.rows =
    // [...]` between the page GET and the approve POST to simulate live drift — see the stale
    // guard test below.
    async get(path: string) {
      calls.push({ m: 'GET', path })
      return this.rows
    },
    async put(path: string) {
      calls.push({ m: 'PUT', path })
    },
  }
}

async function seedSchedule(store: ChangeSetStore, id: string, item: ShelfScheduleItem, creatorLabel = USER_LABEL) {
  await store.create({
    id, creatorLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_schedule',
    items: [item],
    // rec.diff/diffVersion are never read by GET/approve (both always recompute via liveDiff).
    diff: [], diffVersion: 'seed', status: 'pending_approval', createdAt: 1000,
  })
}

let server: Server, base: string, store: ChangeSetStore, db: Db, webSessions: WebSessionStore, gw: ReturnType<typeof fakeGw>

beforeEach(async () => {
  db = await openTestDb()
  store = new ChangeSetStore(db, { now: () => 1000 })
  webSessions = new WebSessionStore(db, { now: () => 1000 })
  const credentials = new CredentialStore(db)
  await credentials.insert({ credHash: CredentialStore.hash(SID), identityId: 'ident-sched', kind: 'web_session', expiresAt: null, updatedAt: 1000 })
  await webSessions.create(SID, 'ident-sched')
  gw = fakeGw({ rows: [{ pkg_oid: 'k1', name: 'Plan A', is_bundle: false, reserve_queue: [{ reserve_date: '2027-01-01 00:00:00', reserve_status: true }] }] })

  const sessionTokens: Record<string, { accessToken: string; userLabel: string }> = {
    [CredentialStore.hash(SID)]: { accessToken: 'sess-tok', userLabel: USER_LABEL },
  }
  const tokenManager = {
    getFreshByCredHash: async (hash: string) => {
      const rec = sessionTokens[hash]
      if (!rec) throw new Error('unknown session hash')
      return { ...rec, businessList: [] }
    },
  } as never

  const modifyUserFrom = (at: string) => 'U:' + at

  const router = buildConfirmRouter({
    changeSets: store, gateway: Object.assign(Object.create(gw), { withTrace() { return this } }) as never, tokenManager, webSessions, credentials, audit: new AuditLog(db, () => 1000),
    modifyUserFrom, now: () => 1000,
  })
  const app = express(); app.use(express.json()); app.use(router)
  server = app.listen(0); await new Promise(r => server.on('listening', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

describe('confirm routes — shelf_schedule renderer (Task 4)', () => {
  it('GET renders current queue -> new queue with the "整組取代" red-text warning and UTC label', async () => {
    await seedSchedule(store, 'cs-sched-1', { prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-03-01 00:00:00', reserve_status: false }] })
    const res = await http(base, 'GET', '/confirm/cs-sched-1', undefined, COOKIE)
    expect(res.status).toBe(200)
    expect(res.text).toContain('整組取代')
    expect(res.text).toContain('UTC')
    expect(res.text).toContain('2027-01-01 00:00:00')   // current queue
    expect(res.text).toContain('2027-03-01 00:00:00')   // new queue
    expect(res.text).toContain('Plan A')
  })

  it('GET on a noop change-set (target already matches live current) surfaces (無變更)', async () => {
    await seedSchedule(store, 'cs-sched-noop', { prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] })
    const res = await http(base, 'GET', '/confirm/cs-sched-noop', undefined, COOKIE)
    expect(res.status).toBe(200)
    expect(res.text).toContain('無變更')
  })

  it('approve executes the PUT against .../package-configs/reserve-active and marks done', async () => {
    await seedSchedule(store, 'cs-sched-2', { prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-03-01 00:00:00', reserve_status: false }] })
    const page = await http(base, 'GET', '/confirm/cs-sched-2', undefined, COOKIE)
    const version = /data-diff-version="([^"]+)"/.exec(page.text)![1]
    const res = await http(base, 'POST', '/confirm/cs-sched-2/approve', { diff_version: version }, COOKIE)
    expect(res.status).toBe(200)
    expect((await store.get('cs-sched-2'))!.status).toBe('done')
    expect(gw.calls.some(c => c.m === 'PUT' && c.path === '/product/api/v1/products/p1/package-configs/reserve-active')).toBe(true)
  })

  it('approve 409s when the live current_queue drifted since the page was rendered (stale guard)', async () => {
    await seedSchedule(store, 'cs-sched-3', { prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-03-01 00:00:00', reserve_status: false }] })
    const page = await http(base, 'GET', '/confirm/cs-sched-3', undefined, COOKIE)
    const version = /data-diff-version="([^"]+)"/.exec(page.text)![1]
    gw.rows = [{ pkg_oid: 'k1', name: 'Plan A', is_bundle: false, reserve_queue: [{ reserve_date: '2027-05-05 00:00:00', reserve_status: true }] }]
    const res = await http(base, 'POST', '/confirm/cs-sched-3/approve', { diff_version: version }, COOKIE)
    expect(res.status).toBe(409)
    expect((await store.get('cs-sched-3'))!.status).toBe('pending_approval')
  })
})
