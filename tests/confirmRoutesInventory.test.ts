import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { buildConfirmRouter } from '../src/server/confirmRoutes.js'
import type { Server } from 'node:http'
import type { InventoryItem } from '../src/core/changeset/types.js'

// Phase 3a Task 7: mirrors the harness in tests/confirmRoutes.test.ts (buildConfirmRouter in
// isolation, plain fetch against a listening express app, redirect:'manual') — but seeds
// inventory_setting change-sets and a fake gateway shaped like tests/inventoryExecutor.test.ts's
// fakeGw, so a single mutable `qty` map drives both the diff (GET /inventories/{supplier}) and
// the executor's read-merge-write PUT.

async function http(base: string, method: string, path: string, body?: object, cookie?: string) {
  const headers: Record<string, string> = {}
  if (body) headers['content-type'] = 'application/json'
  if (cookie) headers['cookie'] = cookie
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  return { status: res.status, text: await res.text(), headers: res.headers }
}

const SID = 'sid-inv'
const COOKIE = `be2mcp_sid=${SID}`
const USER_LABEL = 'owner@kkday.com'

function fakeGw(opts: { qty: Record<string, number> }) {
  const calls: Array<{ m: string; path: string }> = []
  return {
    calls,
    qty: opts.qty,
    async get(path: string, _at: string, query?: Record<string, string>) {
      calls.push({ m: 'GET', path })
      if (path.endsWith('/inventories/status')) return { is_processing: false }
      if (path.endsWith('/basic-info')) return { item_config: { inventory_setting: { control_type: 1, inventory_type: 0 } } }
      return {}
    },
    async post(path: string, _at: string, body: unknown) {
      calls.push({ m: 'POST', path })
      return opts.qty
    },
    async put(path: string, _at: string, body: unknown) {
      calls.push({ m: 'PUT', path })
      const rq = (body as any).inventory_data.remain_qty
      for (const [oid, val] of Object.entries(rq)) {
        opts.qty[oid] = (val as any).fullday
      }
    },
  }
}

function seedInventory(store: ChangeSetStore, id: string, item: InventoryItem, creatorLabel = USER_LABEL) {
  store.create({
    id, creatorLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'inventory_setting',
    items: [item],
    // rec.diff/diffVersion are never read by GET/approve (both always recompute via liveDiff) —
    // placeholders are enough here, same as tests/confirmRoutes.test.ts's shelf seed().
    diff: [], diffVersion: 'seed', status: 'pending_approval', createdAt: 1000,
  })
}

let server: Server, base: string, store: ChangeSetStore, db: ReturnType<typeof openDb>, webSessions: WebSessionStore, gw: ReturnType<typeof fakeGw>

beforeEach(async () => {
  db = openDb(':memory:')
  store = new ChangeSetStore(db, { now: () => 1000 })
  webSessions = new WebSessionStore(db, { now: () => 1000 })
  const credentials = new CredentialStore(db)
  // Task 4: requireSession gates on credentials.getBySecret(sid).kind === 'web_session'.
  credentials.insert({ credHash: CredentialStore.hash(SID), identityId: 'ident-inv', kind: 'web_session', expiresAt: null, updatedAt: 1000 })
  webSessions.create(SID, 'ident-inv')
  gw = fakeGw({ qty: { 'i1': { fullday: 10 } as any } })

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
    changeSets: store, gateway: gw as never, tokenManager, webSessions, credentials, audit: new AuditLog(db, () => 1000),
    modifyUserFrom, now: () => 1000,
  })
  const app = express(); app.use(express.json()); app.use(router)
  server = app.listen(0); await new Promise(r => server.on('listening', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

describe('confirm routes — inventory_setting per-date render (Phase 3a Task 7)', () => {
  it('GET renders fullday rows + the high-risk banner', async () => {
    seedInventory(store, 'cs-inv-1', { item_oid: 'i1', supplier_oid: 's1', quantity: 50 })
    const res = await http(base, 'GET', '/confirm/cs-inv-1', undefined, COOKIE)
    expect(res.status).toBe(200)
    expect(res.text).toContain('立即影響前台可售')
    expect(res.text).toContain('現量')
    expect(res.text).toContain('目標')
    expect(res.text).toContain('10')   // live current
    expect(res.text).toContain('50')   // target
  })

  it('approve: write drift between render and approve does NOT 409 for SET because target is absolute', async () => {
    seedInventory(store, 'cs-inv-adj', { item_oid: 'i1', supplier_oid: 's1', quantity: 50 })
    const page = await http(base, 'GET', '/confirm/cs-inv-adj', undefined, COOKIE)
    const version = /data-diff-version="([^"]+)"/.exec(page.text)![1]
    gw.qty['i1'] = { fullday: 25 } as any   // live drift after the user saw the page
    const res = await http(base, 'POST', '/confirm/cs-inv-adj/approve', { diff_version: version }, COOKIE)
    expect(res.status).toBe(409) // SET always 409s on drift
    expect(store.get('cs-inv-adj')!.status).toBe('pending_approval')
    expect((gw.qty['i1'] as any).fullday).toBe(25)
  })

  it('approve: a SET change-set 409s when the base drifted (stale guard intact)', async () => {
    seedInventory(store, 'cs-inv-set', { item_oid: 'i1', supplier_oid: 's1', quantity: 100 })
    const page = await http(base, 'GET', '/confirm/cs-inv-set', undefined, COOKIE)
    const version = /data-diff-version="([^"]+)"/.exec(page.text)![1]
    gw.qty['i1'] = { fullday: 11 } as any
    const res = await http(base, 'POST', '/confirm/cs-inv-set/approve', { diff_version: version }, COOKIE)
    expect(res.status).toBe(409)
    expect(store.get('cs-inv-set')!.status).toBe('pending_approval')
    expect((gw.qty['i1'] as any).fullday).toBe(11)   // no write happened
  })
})
