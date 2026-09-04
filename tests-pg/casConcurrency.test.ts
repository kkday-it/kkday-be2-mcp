// tests-pg/casConcurrency.test.ts
// 真 PG 雙連線併發：PGlite 是 single-connection，CAS 的多連線互斥必須在真 PostgreSQL 上證明（spec §6）。
// TEST_PG_URL 未設 → 整檔 SKIP（文件化，沿用 eval 先例）；CI 必須設（spec §13.3）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPgDb } from '../src/store/pgDb.js'
import { runMigrations } from '../src/store/migrate.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { IdentityStore, type Identity } from '../src/store/identityStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import type { ChangeSetRecord, ExecutorRef } from '../src/core/changeset/types.js'

const URL = process.env.TEST_PG_URL   // e.g. postgres://test:test@localhost:55432/be2mcp_test
const d = URL ? describe : describe.skip
if (!URL) console.log('[test:pg] SKIP — TEST_PG_URL not set (docker compose -f docker/pg-test.yml up -d)')

// 每 case 用獨立 id，彼此互不踩線（fileParallelism:false 只是保守起見，非正確性依賴）。
function mkRec(id: string): ChangeSetRecord {
  return {
    id,
    creatorLabel: 'tester',
    creatorBearerHash: 'bearer-hash',
    sessionId: 'sess-1',
    actionType: 'shelf_toggle_product',
    items: [],
    diff: [],
    diffVersion: 'v',
    status: 'pending_approval',
    createdAt: 1,
  }
}

function mkIdentity(identityId: string): Identity {
  return {
    identityId,
    userLabel: 'user-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    businessList: [],
    accessExpiresAt: Date.now() + 3_600_000,
    updatedAt: Date.now(),
  }
}

d('CAS 併發（真 PG、兩個獨立 pool）', () => {
  let a: ReturnType<typeof createPgDb>, b: ReturnType<typeof createPgDb>
  beforeAll(async () => {
    // migration 一定要用「單一專用連線」跑（同 scripts/db-migrate.ts）：pg.Pool#query 每句
    // 換連線，pg_advisory_lock 會鎖在隨機 idle 連線上永久外洩、BEGIN/COMMIT 邊界四散。
    const pg = await import('pg')
    const admin = new pg.default.Client({ connectionString: URL!, ssl: false })
    await admin.connect()
    await admin.query('DROP SCHEMA public CASCADE'); await admin.query('CREATE SCHEMA public')
    await runMigrations({
      query: async (s, p) => ({ rows: (await admin.query(s, p as unknown[])).rows }),
      exec: async (s) => { await admin.query(s) },
    })
    await admin.end()
    a = createPgDb({ connectionString: URL!, ssl: false })
    b = createPgDb({ connectionString: URL!, ssl: false })
  })
  afterAll(async () => { await a.close(); await b.close() })

  it('casStatus：兩連線同搶 pending→approved，恰一個贏', async () => {
    const sa = new ChangeSetStore(a), sb = new ChangeSetStore(b)
    const id = 'cs-casstatus'
    await sa.create(mkRec(id))
    const [ra, rb] = await Promise.all([
      sa.casStatus(id, 'pending_approval', 'approved', 1),
      sb.casStatus(id, 'pending_approval', 'rejected', 1),
    ])
    expect([ra, rb].filter(Boolean).length).toBe(1)
    const rec = await sa.get(id)
    expect(rec!.status).toBe(ra ? 'approved' : 'rejected')
  })

  it('setScheduled：兩連線同搶 pending_approval→scheduled，恰一個贏', async () => {
    const sa = new ChangeSetStore(a), sb = new ChangeSetStore(b)
    const id = 'cs-setscheduled'
    await sa.create(mkRec(id))
    const execA: ExecutorRef = { identityId: 'identity-a', userLabel: 'user-a', modifyUser: 'modify-a', sessionId: 'sess-a' }
    const execB: ExecutorRef = { identityId: 'identity-b', userLabel: 'user-b', modifyUser: 'modify-b', sessionId: 'sess-b' }
    const [ra, rb] = await Promise.all([
      sa.setScheduled(id, execA, 10),
      sb.setScheduled(id, execB, 20),
    ])
    expect([ra, rb].filter(Boolean).length).toBe(1)
    const rec = await sa.get(id)
    expect(rec!.status).toBe('scheduled')
    // 贏家的 executorRef 才落地，輸家的完全不留痕跡（非部分覆蓋）。
    expect(rec!.executorRef?.identityId).toBe(ra ? 'identity-a' : 'identity-b')
  })

  it('claimScheduled：兩連線同搶 scheduled→approved，恰一個贏', async () => {
    const sa = new ChangeSetStore(a), sb = new ChangeSetStore(b)
    const id = 'cs-claimscheduled'
    await sa.create(mkRec(id))
    const exec: ExecutorRef = { identityId: 'identity-c', userLabel: 'user-c', modifyUser: 'modify-c', sessionId: 'sess-c' }
    const setOk = await sa.setScheduled(id, exec, 5)
    expect(setOk).toBe(true)
    const [ra, rb] = await Promise.all([
      sa.claimScheduled(id, 100),
      sb.claimScheduled(id, 200),
    ])
    expect([ra, rb].filter(Boolean).length).toBe(1)
    const rec = await sa.get(id)
    expect(rec!.status).toBe('approved')
    expect(rec!.scheduleClaimedAt).toBe(ra ? 100 : 200)
  })

  it('releaseClaim：與 casStatus(approved→executing) 賽跑，恰一個贏（互斥不變式：只有其一能把 approved 帶走）', async () => {
    const sa = new ChangeSetStore(a), sb = new ChangeSetStore(b)
    const id = 'cs-releaseclaim'
    await sa.create(mkRec(id))
    // 先把狀態推進到 approved（releaseClaim 唯一合法起點）。
    const toApproved = await sa.casStatus(id, 'pending_approval', 'approved', 2)
    expect(toApproved).toBe(true)
    const [releaseWon, execWon] = await Promise.all([
      sa.releaseClaim(id),                                  // approved -> scheduled
      sb.casStatus(id, 'approved', 'executing', 3),          // approved -> executing
    ])
    // 兩者起點與終點都經由同一個 status 欄位互斥：一旦有人先把 status 從 approved 帶走，
    // 另一人的 WHERE status='approved' 就不再成立，故恰一個贏，不會兩者皆贏、也不會兩者皆輸
    // （row 一開始確實是 approved，至少有一個 UPDATE 會撞上這個初始狀態而成功）。
    expect([releaseWon, execWon].filter(Boolean).length).toBe(1)
    const rec = await sa.get(id)
    expect(rec!.status).toBe(releaseWon ? 'scheduled' : 'executing')
  })

  it('updateDiff：與 casStatus(pending_approval→approved) 賽跑，終態與贏家一致', async () => {
    const sa = new ChangeSetStore(a), sb = new ChangeSetStore(b)
    const id = 'cs-updatediff'
    await sa.create(mkRec(id))
    const newDiff = [{ prod_oid: 'p1', target_is_active: true, no_op: false }]
    const [casWon, diffWon] = await Promise.all([
      sa.casStatus(id, 'pending_approval', 'approved', 4),
      sb.updateDiff(id, newDiff, 'v2'),
    ])
    // updateDiff 的不變式只綁「仍在 pending_approval」，不跟 casStatus 爭同一個終態值，故不是
    // 「恰一個贏」的形狀——casStatus 不受 updateDiff 影響一定成功；updateDiff 只在它先於
    // casStatus 落地（此時 row 仍是 pending_approval）才成功。用讀回的終態驗證兩者一致：
    expect(casWon).toBe(true)
    const rec = await sa.get(id)
    expect(rec!.status).toBe('approved')
    if (diffWon) {
      // updateDiff 先落地：新 diff 留存，casStatus 隨後在「仍 pending_approval」的 row 上成功。
      expect(rec!.diffVersion).toBe('v2')
    } else {
      // casStatus 先落地：row 已離開 pending_approval，updateDiff 的 WHERE 落空，diff 維持原值。
      expect(rec!.diffVersion).toBe('v')
    }
  })

  it('consumeAuthCode：兩連線同搶消費同一支 authorization code，恰一個贏（F1：不雙發 token）', async () => {
    const oa = new OAuthStore(a), ob = new OAuthStore(b)
    const codeHash = 'code-cas'
    await oa.insertAuthCode({ codeHash, clientId: 'c', redirectUri: 'http://x/cb', codeChallenge: 'ch', identityId: 'I1', exp: Date.now() + 60_000, consumed: 0 })
    const [ra, rb] = await Promise.all([
      oa.consumeAuthCode(codeHash),
      ob.consumeAuthCode(codeHash),
    ])
    // 恰一個 CAS 翻轉成功——兩個並發請求不會都拿到 code 去各自發一組 token。
    expect([ra, rb].filter(Boolean).length).toBe(1)
    expect((await oa.getAuthCode(codeHash))!.consumed).toBe(1)
  })

  it('markRefreshConsumed：兩連線同搶消費同一顆 refresh，恰一個贏（F1：輸家 = reuse 訊號）', async () => {
    const oa = new OAuthStore(a), ob = new OAuthStore(b)
    const refreshHash = 'refresh-cas'
    await oa.insertRefresh({ refreshHash, identityId: 'I1', clientId: 'c', exp: Date.now() + 60_000, consumed: 0 })
    const [ra, rb] = await Promise.all([
      oa.markRefreshConsumed(refreshHash),
      ob.markRefreshConsumed(refreshHash),
    ])
    // 恰一個贏；輸家（回 false）在 route 層即為 reuse-detection family revoke 的觸發訊號。
    expect([ra, rb].filter(Boolean).length).toBe(1)
    expect((await oa.getRefresh(refreshHash))!.consumed).toBe(1)
  })

  it('claimKeepalive (IdentityStore)：兩連線同搶同一 identity 的 keepalive claim，恰一個贏', async () => {
    const ia = new IdentityStore(a), ib = new IdentityStore(b)
    const identityId = 'identity-keepalive'
    await ia.upsert(mkIdentity(identityId))
    const now = Date.now()
    const [ra, rb] = await Promise.all([
      ia.claimKeepalive(identityId, now, 60_000),
      ib.claimKeepalive(identityId, now, 60_000),
    ])
    expect([ra, rb].filter(Boolean).length).toBe(1)
  })
})
