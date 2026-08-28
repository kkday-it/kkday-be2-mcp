import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'
import { APP_TOOLS } from '../src/tools/appTools.js'
import { ApprovalNonceStore } from '../src/core/changeset/approvalNonce.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import type { L2ToolContext } from '../src/server/l2Context.js'

function fakeJwt(claims: Record<string, unknown> = {}): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`
}

let httpServer: Server, base: string, db: Database.Database, store: ChangeSetStore, webSessions: WebSessionStore

function seedSession(sid: string, userLabel: string) {
  const identities = new IdentityStore(db)
  const credentials = new CredentialStore(db)
  const identityId = `ident-${sid}`
  identities.upsert({
    identityId, userLabel,
    accessToken: fakeJwt({ authKey: userLabel, platformId: 'plat-uuid-test' }), refreshToken: 'r', businessList: [],
    accessExpiresAt: Date.now() + 3600_000, updatedAt: Date.now(),
  })
  credentials.insert({
    credHash: CredentialStore.hash(sid), identityId, kind: 'web_session', expiresAt: null, updatedAt: Date.now(),
  })
  webSessions.create(sid, identityId)
  return identityId
}

async function startApp(): Promise<void> {
  const config: Config = {
    authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
    serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off', scheduleTz: 'Asia/Taipei',
    bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
  }
  const app = buildApp({ config, db })
  httpServer = createServer(app)
  await new Promise<void>(r => httpServer.listen(0, () => r()))
  base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
}

const T0 = Date.UTC(2026, 8, 1, 0, 0)

beforeEach(async () => {
  db = openDb(':memory:')
  store = new ChangeSetStore(db, { now: () => T0 })
  webSessions = new WebSessionStore(db)
  seedSession('sid-owner', 'owner@kkday.com')
  seedSession('sid-other', 'other@kkday.com')
  await startApp()
})

afterEach(async () => {
  await new Promise<void>(r => httpServer.close(() => r()))
  vi.unstubAllGlobals()
})

function seed(id: string, status: 'pending_approval' | 'scheduled' | 'cancelled', creatorLabel = 'owner@kkday.com') {
  store.create({
    id, creatorLabel, creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
    items: [{ prod_oid: 'p1', target_is_active: false }],
    diff: [{ prod_oid: 'p1', name: 'Prod A', current_is_active: true, target_is_active: false, no_op: false }],
    diffVersion: 'seed', status: 'pending_approval', createdAt: T0,
    schedule: status === 'pending_approval' ? undefined : { executeAtUtc: T0 + 3600_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' },
  })
  if (status === 'scheduled') {
    store.setScheduled(id, { identityId: 'id-1', userLabel: creatorLabel, modifyUser: 'mu', sessionId: 's' }, T0)
  }
  if (status === 'cancelled') {
    store.setScheduled(id, { identityId: 'id-1', userLabel: creatorLabel, modifyUser: 'mu', sessionId: 's' }, T0)
    store.casStatus(id, 'scheduled', 'cancelled', T0)
  }
}

describe('scheduleCancel (confirm routes)', () => {
  it('1. GET /confirm/:id(status=scheduled,本人)→ 200,頁面含 schedule_wall + tz + 「取消排程」, 非本人 → 404', async () => {
    seed('cs-1', 'scheduled')
    const res = await fetch(`${base}/confirm/cs-1`, { headers: { cookie: 'be2mcp_sid=sid-owner' } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('已排程:將於 2026-09-01T09:00(Asia/Taipei)執行')
    // §8：banner 含倒數區段（值視 now 而定：約 N 分鐘後 / 即將 / 不到 1 分鐘）
    expect(text).toContain('執行 —— ')
    expect(text).toMatch(/分鐘後執行|即將執行/)
    expect(text).toContain('取消排程')
    expect(text).toContain('action="/confirm/cs-1/cancel"')

    const resOther = await fetch(`${base}/confirm/cs-1`, { headers: { cookie: 'be2mcp_sid=sid-other' } })
    expect(resOther.status).toBe(404)
  })

  it('2. POST /confirm/:id/cancel(scheduled)→ 200,status=cancelled,audit 記 changeset.cancel; 已 cancelled 再 POST → 409; pending_approval → 409', async () => {
    seed('cs-2', 'scheduled')
    const res = await fetch(`${base}/confirm/cs-2/cancel`, { method: 'POST', headers: { cookie: 'be2mcp_sid=sid-owner' } })
    expect(res.status).toBe(200)
    expect(store.get('cs-2')!.status).toBe('cancelled')
    
    // Check audit
    const log = db.prepare('SELECT * FROM audit_log WHERE tool = ? AND status = ?').get('changeset.cancel', 'ok')
    expect(log).toBeDefined()

    const resAgain = await fetch(`${base}/confirm/cs-2/cancel`, { method: 'POST', headers: { cookie: 'be2mcp_sid=sid-owner' } })
    expect(resAgain.status).toBe(409) // 已 cancelled

    seed('cs-3', 'pending_approval')
    const resPending = await fetch(`${base}/confirm/cs-3/cancel`, { method: 'POST', headers: { cookie: 'be2mcp_sid=sid-owner' } })
    expect(resPending.status).toBe(409) // 只有 scheduled 可取消
  })
})

describe('scheduleCancel (app tools)', () => {
  function mkCtx() {
    const readOids = new ReadOidStore(db, { now: () => T0 })
    const rateBudget = new RateBudget(db, { now: () => T0 })
    const nonces = new ApprovalNonceStore()
    const ctx = {
      gateway: {} as never, accessToken: 'fake', userLabel: 'owner@kkday.com', sessionId: 'sid-owner', bearerHash: 'bh',
      businessList: ['product.product-inventory.update', 'product.product-sale-status.update'], readOids, changeSets: store, rateBudget,
      baseUrl: 'http://127.0.0.1:8787', genId: () => 'cs1', now: () => T0,
      emitConfirmUrl: vi.fn(), scheduleTz: 'Asia/Taipei',
      nonces, approveAndExecute: vi.fn(),
    } as unknown as L2ToolContext & { nonces: ApprovalNonceStore }
    return { ctx, nonces }
  }

  it('3. 面板:app_get_changeset_view 對 scheduled 回 schedule + diff_version + nonce; app_confirm_changeset decision=cancel → cancelled; 對 pending_approval → NOT_CANCELLABLE', async () => {
    seed('cs-4', 'scheduled')
    const { ctx } = mkCtx()
    const getView = APP_TOOLS.find(t => t.name === 'app_get_changeset_view')!
    const envView = await getView.handler({ changeset_id: 'cs-4' }, ctx as never)
    expect(envView.items[0]).toHaveProperty('schedule')
    expect(envView.items[0]).toHaveProperty('diff_version')
    expect(envView.items[0]).toHaveProperty('nonce')

    const confirm = APP_TOOLS.find(t => t.name === 'app_confirm_changeset')!
    const envCancel = await confirm.handler({
      changeset_id: 'cs-4',
      decision: 'cancel',
      nonce: (envView.items[0] as { nonce: string }).nonce,
      diff_version: (envView.items[0] as { diff_version: string }).diff_version,
      confirmed_keys: []
    }, ctx as never)
    
    expect(envCancel.items[0]).toEqual({ changeset_id: 'cs-4', status: 'cancelled' })
    expect(store.get('cs-4')!.status).toBe('cancelled')

    seed('cs-5', 'pending_approval')
    const envView5 = await getView.handler({ changeset_id: 'cs-5' }, ctx as never)
    const envCancel5 = await confirm.handler({
      changeset_id: 'cs-5',
      decision: 'cancel',
      nonce: (envView5.items[0] as { nonce: string }).nonce,
      diff_version: (envView5.items[0] as { diff_version: string }).diff_version,
      confirmed_keys: []
    }, ctx as never)
    expect(envCancel5.errors[0]?.code).toBe('NOT_CANCELLABLE')
  })

  it('4. 取消後 scheduler tick 不執行', async () => {
    seed('cs-6', 'scheduled')
    const { ctx } = mkCtx()
    
    // Check initially listed
    const due = store.listDueScheduled(T0 + 3600_000 + 1)
    expect(due.length).toBe(1)
    expect(due[0]).toBe('cs-6')

    // Cancel it
    const getView = APP_TOOLS.find(t => t.name === 'app_get_changeset_view')!
    const envView = await getView.handler({ changeset_id: 'cs-6' }, ctx as never)
    const confirm = APP_TOOLS.find(t => t.name === 'app_confirm_changeset')!
    await confirm.handler({
      changeset_id: 'cs-6',
      decision: 'cancel',
      nonce: (envView.items[0] as { nonce: string }).nonce,
      diff_version: (envView.items[0] as { diff_version: string }).diff_version,
      confirmed_keys: []
    }, ctx as never)

    // Check again
    const dueAfter = store.listDueScheduled(T0 + 3600_000 + 1)
    expect(dueAfter.length).toBe(0)
    expect(store.get('cs-6')!.status).toBe('cancelled')
  })
})
