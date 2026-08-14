import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { buildConfirmRouter } from '../src/server/confirmRoutes.js'
import type { Server } from 'node:http'
import type { InventoryPlatformItem } from '../src/changeset/types.js'

// Final whole-branch review Important 1: confirmRoutes.ts's render dispatch only had
// inventory_setting/shelf_schedule branches — an inventory_platform change-set fell through to
// the shelf renderPage, which reads `.name`/`.current_is_active`/`.target_is_active` (all absent
// on InventoryPlatformDiffItem) and renders blank names + a hardcoded "→ 下架" for every row
// regardless of the real target platform: an approver-misleading page. Mirrors the harness in
// tests/confirmRoutesInventory.test.ts (buildConfirmRouter in isolation, plain fetch against a
// listening express app, redirect:'manual') but seeds inventory_platform change-sets and a fake
// gateway shaped like tests/executorPlatform.test.ts's fakeGw (GET .../items/{itemOid}/configs,
// PUT .../supplier-configs/{supplierOid}/inventory-setting).

async function http(base: string, method: string, path: string, body?: object, cookie?: string) {
  const headers: Record<string, string> = {}
  if (body) headers['content-type'] = 'application/json'
  if (cookie) headers['cookie'] = cookie
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  return { status: res.status, text: await res.text(), headers: res.headers }
}

const SID = 'sid-plat'
const COOKIE = `be2mcp_sid=${SID}`
const USER_LABEL = 'owner@kkday.com'

function fakeGw(opts: { configsByItem: Record<string, unknown>; packagesByProd?: Record<string, unknown> }) {
  const calls: Array<{ m: string; path: string; body?: unknown }> = []
  return {
    calls,
    configsByItem: opts.configsByItem,
    packagesByProd: opts.packagesByProd ?? {},
    async get(path: string) {
      calls.push({ m: 'GET', path })
      const cfgM = /\/items\/([^/]+)\/configs$/.exec(path)
      if (cfgM) return this.configsByItem[cfgM[1]]
      const pkgM = /\/products\/([^/]+)\/packages$/.exec(path)
      if (pkgM) return this.packagesByProd[pkgM[1]]
      return undefined
    },
    async put(path: string, _at: string, body: Record<string, unknown>) {
      calls.push({ m: 'PUT', path, body })
      const m = /\/items\/([^/]+)\/supplier-configs\/([^/]+)\/inventory-setting$/.exec(path)!
      const item = decodeURIComponent(m[1]); const supplier = decodeURIComponent(m[2])
      const rows = (this.configsByItem[item] as { supplier_configs?: Array<Record<string, unknown>> } | undefined)?.supplier_configs
      const row = rows?.find(r => String(r.supplier_oid) === supplier)
      if (row) { row.is_external_inventory = body.is_external_inventory; row.is_inventory_mgmt = body.is_inventory_mgmt }
    },
  }
}

function seedPlatform(store: ChangeSetStore, id: string, item: InventoryPlatformItem, creatorLabel = USER_LABEL) {
  store.create({
    id, creatorLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'inventory_platform',
    items: [item],
    // rec.diff/diffVersion are never read by GET/approve (both always recompute via liveDiff).
    diff: [], diffVersion: 'seed', status: 'pending_approval', createdAt: 1000,
  })
}

let server: Server, base: string, store: ChangeSetStore, db: ReturnType<typeof openDb>, webSessions: WebSessionStore, gw: ReturnType<typeof fakeGw>

beforeEach(async () => {
  db = openDb(':memory:')
  store = new ChangeSetStore(db, { now: () => 1000 })
  webSessions = new WebSessionStore(db, { now: () => 1000 })
  const credentials = new CredentialStore(db)
  credentials.insert({ credHash: CredentialStore.hash(SID), identityId: 'ident-plat', kind: 'web_session', expiresAt: null, updatedAt: 1000 })
  webSessions.create(SID, 'ident-plat')
  gw = fakeGw({ configsByItem: { i1: { supplier_configs: [{ supplier_oid: 's1', is_external_inventory: false, is_inventory_mgmt: false }] } } })

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

describe('confirm routes — inventory_platform renderer (final whole-branch review Important 1)', () => {
  it('GET renders item_oid x supplier_oid, current -> target platform, affected plan names — never the misleading shelf "下架" wording', async () => {
    seedPlatform(store, 'cs-plat-1', {
      item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM',
      affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'Plan A' }],
    })
    const res = await http(base, 'GET', '/confirm/cs-plat-1', undefined, COOKIE)
    expect(res.status).toBe(200)
    expect(res.text).toContain('i1')
    expect(res.text).toContain('s1')
    expect(res.text).toContain('BE2_SCM')   // target
    expect(res.text).toContain('Plan A')
    expect(res.text).not.toContain('下架')
  })

  it('GET on a noop change-set (target already matches live current) surfaces (無變更)', async () => {
    seedPlatform(store, 'cs-plat-noop', {
      item_oid: 'i1', supplier_oid: 's1', target: 'BE2',
      affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'Plan A' }],
    })
    const res = await http(base, 'GET', '/confirm/cs-plat-noop', undefined, COOKIE)
    expect(res.status).toBe(200)
    expect(res.text).toContain('無變更')
  })

  it('approve executes the PUT against .../supplier-configs/{supplierOid}/inventory-setting and marks done', async () => {
    seedPlatform(store, 'cs-plat-2', {
      item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM',
      affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'Plan A' }],
    })
    const page = await http(base, 'GET', '/confirm/cs-plat-2', undefined, COOKIE)
    const version = /data-diff-version="([^"]+)"/.exec(page.text)![1]
    const res = await http(base, 'POST', '/confirm/cs-plat-2/approve', { diff_version: version }, COOKIE)
    expect(res.status).toBe(200)
    expect(store.get('cs-plat-2')!.status).toBe('done')
    expect(gw.calls.some(c => c.m === 'PUT' && c.path === '/product/api/v1/items/i1/supplier-configs/s1/inventory-setting')).toBe(true)
  })

  it('approve 409s when the live current platform drifted since the page was rendered (stale guard)', async () => {
    seedPlatform(store, 'cs-plat-3', {
      item_oid: 'i1', supplier_oid: 's1', target: 'BE2_SCM',
      affected_pkgs: [{ prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'Plan A' }],
    })
    const page = await http(base, 'GET', '/confirm/cs-plat-3', undefined, COOKIE)
    const version = /data-diff-version="([^"]+)"/.exec(page.text)![1]
    gw.configsByItem['i1'] = { supplier_configs: [{ supplier_oid: 's1', is_external_inventory: true, is_inventory_mgmt: false }] } // -> EXTERNAL now
    const res = await http(base, 'POST', '/confirm/cs-plat-3/approve', { diff_version: version }, COOKIE)
    expect(res.status).toBe(409)
    expect(store.get('cs-plat-3')!.status).toBe('pending_approval')
  })
})
