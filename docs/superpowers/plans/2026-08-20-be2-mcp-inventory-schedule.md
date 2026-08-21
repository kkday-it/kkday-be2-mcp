# 庫存數量到點派送排程層(塊 B)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 為 change-set 加上 core 泛用「到點派送」排程能力(`scheduled/cancelled/missed` 狀態 + server 內建 poller + 延遲執行身分),並只對 `inventory_setting` 開放(`schedulable` opt-in)。

**Architecture:** spec `docs/superpowers/specs/2026-08-20-be2-mcp-inventory-schedule-design.md`(agy APPROVED rounds=4)。排程歸 core(change-set 生命週期治理);到期認領/keep-alive 皆用既有 DB CAS 原語(免 Redis/leader);延遲執行身分靠 Option 1 token store(`executor_identity_id` + `getFreshByIdentityId`);時區規則=牆鐘+`BE2_TZ` 換算 UTC 一次、呈現回放原文。

**Tech Stack:** TypeScript(strict)、Express 5、better-sqlite3、zod、vitest。無新依賴(時區用 `Intl.DateTimeFormat`)。

## Global Constraints

- 分支:`feat/bundle-followup`(續 PR #19)。每 task 完成即 commit。
- 測試時間一律注入 `now: () => number` 手動時鐘(repo 慣例,無 fake timer)。
- 業務邏輯**不得**直接呼叫 `Date.now()`——一律走注入的 `now`。
- `npm run ci`(build:ui + typecheck + vitest)每 task 結束必須全綠、0 skipped。
- 錯誤處理沿用 `AppError(code, message, httpStatus)` / `AuthError`(`src/errors.ts`)。
- 註解語言沿用該檔既有風格(中英混用,講 why 不講 what)。
- 憑證/token 永不落 log、不落 audit 明文。
- live 寫入驗收非本 plan 範圍(SIT AU9403 / stage grant 待生效;spec §11)。

---

### Task 1: 時區換算 util + 排程 policy 常數

**Files:**
- Create: `src/core/schedule/tz.ts`
- Create: `src/core/schedule/policy.ts`
- Test: `tests/core/scheduleTz.test.ts`

**Interfaces:**
- Produces: `wallToUtcEpoch(wall: string, tz: string): number`(throw `AppError('INVALID_WALL'|'NONEXISTENT_TIME', …, 400)`)、`SCHEDULE_POLICY = { minLeadMs, horizonMs, graceMs, staleClaimMs, tickMs, keepAliveWindowMs }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/scheduleTz.test.ts
import { describe, it, expect } from 'vitest'
import { wallToUtcEpoch } from '../../src/core/schedule/tz.js'

describe('wallToUtcEpoch', () => {
  it('converts Asia/Taipei wall clock to UTC epoch (fixed +08:00, no DST)', () => {
    // 2026-09-01 09:00 Asia/Taipei == 2026-09-01T01:00:00Z
    expect(wallToUtcEpoch('2026-09-01T09:00', 'Asia/Taipei')).toBe(Date.UTC(2026, 8, 1, 1, 0))
  })
  it('handles day-boundary wall times (00:00 / 23:59)', () => {
    expect(wallToUtcEpoch('2026-09-01T00:00', 'Asia/Taipei')).toBe(Date.UTC(2026, 7, 31, 16, 0))
    expect(wallToUtcEpoch('2026-09-30T23:59', 'Asia/Taipei')).toBe(Date.UTC(2026, 8, 30, 15, 59))
  })
  it('is DST-safe: America/New_York across the spring-forward boundary', () => {
    // 2026-03-08 01:30 EST (UTC-5) exists → 06:30Z
    expect(wallToUtcEpoch('2026-03-08T01:30', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 6, 30))
    // 03:30 EDT (UTC-4) exists → 07:30Z
    expect(wallToUtcEpoch('2026-03-08T03:30', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7, 30))
  })
  it('rejects nonexistent DST wall time (02:30 during spring-forward)', () => {
    expect(() => wallToUtcEpoch('2026-03-08T02:30', 'America/New_York')).toThrow(/NONEXISTENT|does not exist/)
  })
  it('rejects malformed / impossible calendar input', () => {
    expect(() => wallToUtcEpoch('2026-9-1 09:00', 'Asia/Taipei')).toThrow()
    expect(() => wallToUtcEpoch('2026-02-30T10:00', 'Asia/Taipei')).toThrow()
    expect(() => wallToUtcEpoch('2026-09-01T24:00', 'Asia/Taipei')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/scheduleTz.test.ts`
Expected: FAIL(module not found)

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/schedule/tz.ts
import { AppError } from '../../errors.js'

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

// 指定 tz 在 utcMs 這一刻的 UTC offset(ms)。用 formatToParts 反推——Node 內建 ICU,無需新依賴。
function tzOffsetMs(tz: string, utcMs: number): number {
  // hourCycle:'h23' 而非 hour12:false——後者在 en-US 走 h24,午夜會格式化成「前一天 24:00」,
  // day 部件差一天 → offset 差 24h(排在整點午夜的排程全錯)。h23 強制 00-23,day 對齊當日。
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - utcMs
}

// 牆鐘 + IANA tz → UTC epoch(ms)。spec §4 時區規則:只在這裡換算一次,之後所有比較用 epoch。
// DST-safe 兩步法:先以 UTC 猜值取 offset、再驗 round-trip;不存在的牆鐘(春季跳時)明確拒絕。
export function wallToUtcEpoch(wall: string, tz: string): number {
  const m = WALL_RE.exec(wall)
  if (!m) throw new AppError('INVALID_WALL', `schedule wall time must be YYYY-MM-DDTHH:mm, got: ${wall}`, 400)
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[]
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi)
  const g = new Date(utcGuess)
  if (g.getUTCFullYear() !== y || g.getUTCMonth() !== mo - 1 || g.getUTCDate() !== d || g.getUTCHours() !== h || g.getUTCMinutes() !== mi) {
    throw new AppError('INVALID_WALL', `not a real calendar time: ${wall}`, 400)
  }
  let utc = utcGuess - tzOffsetMs(tz, utcGuess)
  const off2 = tzOffsetMs(tz, utc)
  utc = utcGuess - off2
  if (utc + tzOffsetMs(tz, utc) !== utcGuess) {
    throw new AppError('NONEXISTENT_TIME', `wall time ${wall} does not exist in ${tz} (DST gap)`, 400)
  }
  return utc
}
```

```ts
// src/core/schedule/policy.ts
// spec §4/§7 的排程 policy 常數(單一事實來源;env 覆寫留待真有需求,YAGNI)。
export const SCHEDULE_POLICY = {
  minLeadMs: 5 * 60_000,        // 建立時:至少 5 分鐘後(留人審查餘裕;批准時只驗「仍在未來」,spec §5)
  horizonMs: 30 * 24 * 3600_000, // 建立時:最遠 30 天
  graceMs: 30 * 60_000,          // 停機吸收窗:超過即 missed,寧可不執行(spec §7)
  staleClaimMs: 10 * 60_000,     // stranded-approved 回收判準(spec §7 步驟 4)
  tickMs: 30_000,                // scheduler 輪詢間隔
  keepAliveWindowMs: 2 * 30_000 + 5 * 60_000, // access 將於「2 tick + tokenManager skew」內到期才 keep-alive
} as const
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/core/scheduleTz.test.ts` → PASS
- [ ] **Step 5: Commit** — `git add src/core/schedule tests/core/scheduleTz.test.ts && git commit -m "feat(schedule): timezone-safe wall→UTC 換算 + 排程 policy 常數"`

---

### Task 2: 狀態機/型別擴充 + DB migration + ChangeSetStore 排程方法

**Files:**
- Modify: `src/core/changeset/types.ts:2,119-132`
- Modify: `src/store/db.ts:38-51,134-142`(change_sets 建表 + PRAGMA 補欄)
- Modify: `src/core/changeset/store.ts`
- Modify: `src/store/identityStore.ts`
- Test: `tests/changesetStoreSchedule.test.ts`

**Interfaces:**
- Produces(types.ts):
  ```ts
  export type ChangeSetStatus = 'pending_approval' | 'approved' | 'executing' | 'done' | 'partial' | 'failed' | 'rejected' | 'expired' | 'scheduled' | 'cancelled' | 'missed'
  export interface ScheduleInfo { executeAtUtc: number; wall: string; tz: string }
  export interface ExecutorRef { identityId: string; userLabel: string; modifyUser: string; sessionId: string }
  // ChangeSetRecord 加欄: schedule?: ScheduleInfo; executorRef?: ExecutorRef; scheduleClaimedAt?: number
  ```
- Produces(store.ts 新方法,簽名固定,後續 task 依賴):
  ```ts
  setScheduled(id: string, executor: ExecutorRef, decidedAt: number): boolean   // CAS pending_approval→scheduled + 寫 executor_*
  listDueScheduled(nowMs: number): string[]
  claimScheduled(id: string, nowMs: number): boolean                            // CAS scheduled→approved + schedule_claimed_at=now
  releaseClaim(id: string): boolean                                             // CAS approved→scheduled(transient 失敗/回收用)
  listStrandedApproved(nowMs: number, staleClaimMs: number): string[]
  listScheduledIdentityIds(): string[]
  ```
- Produces(identityStore.ts): `claimKeepalive(identityId: string, nowMs: number, claimTtlMs: number): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/changesetStoreSchedule.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { IdentityStore } from '../src/store/identityStore.js'
import type { ChangeSetRecord } from '../src/core/changeset/types.js'

const EXEC = { identityId: 'id-1', userLabel: 'u@kkday.com', modifyUser: 'u', sessionId: 'sess-hash' }
function rec(id: string, over: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  return {
    id, creatorLabel: 'u@kkday.com', creatorBearerHash: 'h', sessionId: 's',
    actionType: 'inventory_setting', items: [{ item_oid: 'i1', supplier_oid: '0', quantity: 5 }],
    diff: [], diffVersion: 'v1', status: 'pending_approval', createdAt: 1000, ...over,
  }
}

describe('ChangeSetStore schedule fields + transitions', () => {
  let t = 1000
  let store: ChangeSetStore
  beforeEach(() => { t = 1000; store = new ChangeSetStore(openDb(':memory:'), { now: () => t }) })

  it('roundtrips schedule fields through create/get', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 99_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' } }))
    const r = store.get('c1')!
    expect(r.schedule).toEqual({ executeAtUtc: 99_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' })
    expect(r.executorRef).toBeUndefined()
  })

  it('setScheduled: CAS pending_approval→scheduled + persists executorRef; loses when already decided', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 99_000, wall: 'w', tz: 'z' } }))
    expect(store.setScheduled('c1', EXEC, 2000)).toBe(true)
    const r = store.get('c1')!
    expect(r.status).toBe('scheduled')
    expect(r.executorRef).toEqual(EXEC)
    expect(store.setScheduled('c1', EXEC, 2000)).toBe(false)   // 已離開 pending_approval
  })

  it('scheduled is NOT lazily TTL-expired (expiry only applies to pending_approval)', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 99_000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c1', EXEC, 2000)
    t = 1000 + 25 * 3600_000   // 超過預設 24h TTL
    expect(store.get('c1')!.status).toBe('scheduled')
  })

  it('listDueScheduled / claimScheduled: claim is CAS (double claim loses) and stamps claimed_at', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c1', EXEC, 2000)
    expect(store.listDueScheduled(4999)).toEqual([])
    expect(store.listDueScheduled(5000)).toEqual(['c1'])
    expect(store.claimScheduled('c1', 5000)).toBe(true)
    expect(store.claimScheduled('c1', 5000)).toBe(false)
    expect(store.get('c1')!.status).toBe('approved')
    expect(store.get('c1')!.scheduleClaimedAt).toBe(5000)
  })

  it('releaseClaim puts an approved schedule back; listStrandedApproved finds stale claims only', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c1', EXEC, 2000); store.claimScheduled('c1', 5000)
    // 即時批准路徑的 approved(無 schedule)不得被撈到
    store.create(rec('c2')); store.casStatus('c2', 'pending_approval', 'approved')
    expect(store.listStrandedApproved(5000 + 599_000, 600_000)).toEqual([])
    expect(store.listStrandedApproved(5000 + 600_001, 600_000)).toEqual(['c1'])
    expect(store.releaseClaim('c1')).toBe(true)
    expect(store.get('c1')!.status).toBe('scheduled')
  })

  it('listScheduledIdentityIds returns distinct executor identities of scheduled sets only', () => {
    store.create(rec('c1', { schedule: { executeAtUtc: 5000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c1', EXEC, 2000)
    store.create(rec('c2', { schedule: { executeAtUtc: 6000, wall: 'w', tz: 'z' } }))
    store.setScheduled('c2', EXEC, 2000)
    expect(store.listScheduledIdentityIds()).toEqual(['id-1'])
  })
})

describe('IdentityStore.claimKeepalive', () => {
  it('first claim wins, second within TTL loses, after TTL wins again', () => {
    const db = openDb(':memory:')
    const ids = new IdentityStore(db)
    ids.upsert({ identityId: 'id-1', userLabel: 'u', accessToken: 'a', refreshToken: 'r', businessList: [], accessExpiresAt: 0, updatedAt: 0 })
    expect(ids.claimKeepalive('id-1', 10_000, 30_000)).toBe(true)
    expect(ids.claimKeepalive('id-1', 20_000, 30_000)).toBe(false)
    expect(ids.claimKeepalive('id-1', 40_001, 30_000)).toBe(true)
    expect(ids.claimKeepalive('nope', 10_000, 30_000)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/changesetStoreSchedule.test.ts` → FAIL

- [ ] **Step 3: Implementation**

types.ts(§Interfaces 所列)。db.ts:change_sets `CREATE TABLE` 加 8 欄(全部 nullable,新 db 直接有):

```sql
  execute_at_utc       INTEGER,
  schedule_wall        TEXT,
  schedule_tz          TEXT,
  executor_identity_id TEXT,
  executor_label       TEXT,
  executor_modify_user TEXT,
  executor_session_id  TEXT,
  schedule_claimed_at  INTEGER
```

be2_identities 加 `keepalive_claimed_at INTEGER`。舊 on-disk db 用既有 PRAGMA 補欄 pattern(仿 `db.ts:139-142` 的 access_cred_hash 寫法,逐欄檢查缺才 ADD;附索引 `CREATE INDEX IF NOT EXISTS idx_change_sets_status ON change_sets(status)`):

```ts
  // 塊 B(排程層):change_sets 排程欄 + be2_identities keep-alive 認領章。SQLite 無
  // ADD COLUMN IF NOT EXISTS,沿用 access_cred_hash 的 PRAGMA 檢查 pattern。
  const csCols2 = db.prepare('PRAGMA table_info(change_sets)').all() as Array<{ name: string }>
  const csHave = new Set(csCols2.map(c => c.name))
  for (const [col, typ] of [
    ['execute_at_utc', 'INTEGER'], ['schedule_wall', 'TEXT'], ['schedule_tz', 'TEXT'],
    ['executor_identity_id', 'TEXT'], ['executor_label', 'TEXT'], ['executor_modify_user', 'TEXT'],
    ['executor_session_id', 'TEXT'], ['schedule_claimed_at', 'INTEGER'],
  ] as const) {
    if (!csHave.has(col)) db.exec(`ALTER TABLE change_sets ADD COLUMN ${col} ${typ}`)
  }
  const idCols = db.prepare('PRAGMA table_info(be2_identities)').all() as Array<{ name: string }>
  if (!idCols.some(c => c.name === 'keepalive_claimed_at')) {
    db.exec('ALTER TABLE be2_identities ADD COLUMN keepalive_claimed_at INTEGER')
  }
```

store.ts:`create()` 寫 schedule 三欄(無 schedule 時 null);`get()` 映射 `schedule`/`executorRef`/`scheduleClaimedAt`(任一欄非 null 才組物件);新方法全部單 statement 條件式 UPDATE(仿 `casStatus`):

```ts
  setScheduled(id: string, executor: ExecutorRef, decidedAt: number): boolean {
    const r = this.db.prepare(`UPDATE change_sets SET status='scheduled', decided_at=?,
      executor_identity_id=?, executor_label=?, executor_modify_user=?, executor_session_id=?
      WHERE id=? AND status='pending_approval'`)
      .run(decidedAt, executor.identityId, executor.userLabel, executor.modifyUser, executor.sessionId, id)
    return r.changes === 1
  }
  listDueScheduled(nowMs: number): string[] {
    return (this.db.prepare(`SELECT id FROM change_sets WHERE status='scheduled' AND execute_at_utc <= ? ORDER BY execute_at_utc`)
      .all(nowMs) as Array<{ id: string }>).map(r => r.id)
  }
  claimScheduled(id: string, nowMs: number): boolean {
    return this.db.prepare(`UPDATE change_sets SET status='approved', schedule_claimed_at=? WHERE id=? AND status='scheduled'`)
      .run(nowMs, id).changes === 1
  }
  releaseClaim(id: string): boolean {
    return this.db.prepare(`UPDATE change_sets SET status='scheduled' WHERE id=? AND status='approved'`).run(id).changes === 1
  }
  listStrandedApproved(nowMs: number, staleClaimMs: number): string[] {
    return (this.db.prepare(`SELECT id FROM change_sets WHERE status='approved' AND execute_at_utc IS NOT NULL
      AND schedule_claimed_at IS NOT NULL AND schedule_claimed_at < ?`).all(nowMs - staleClaimMs) as Array<{ id: string }>).map(r => r.id)
  }
  listScheduledIdentityIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT executor_identity_id AS iid FROM change_sets
      WHERE status='scheduled' AND executor_identity_id IS NOT NULL`).all() as Array<{ iid: string }>).map(r => r.iid)
  }
  listScheduledIdsByIdentity(identityId: string): string[] {
    return (this.db.prepare(`SELECT id FROM change_sets WHERE status='scheduled' AND executor_identity_id = ?`)
      .all(identityId) as Array<{ id: string }>).map(r => r.id)
  }
```

(`listScheduledIdsByIdentity` 供 Task 7:keep-alive terminal 失敗時立即 fail 該 identity 名下所有排程件,不留到 T 才爆。測試在 Task 2 的 `listScheduledIdentityIds` 案例旁加一條:同 identity 兩件 scheduled → 回兩個 id;非 scheduled 不回。)

identityStore.ts:

```ts
  // keep-alive 跨實例防撞(spec §6):條件式 UPDATE 認領,輸方本 tick 跳過。與 casStatus 同原語。
  claimKeepalive(identityId: string, nowMs: number, claimTtlMs: number): boolean {
    return this.db.prepare(`UPDATE be2_identities SET keepalive_claimed_at=? WHERE identity_id=?
      AND (keepalive_claimed_at IS NULL OR keepalive_claimed_at < ?)`)
      .run(nowMs, identityId, nowMs - claimTtlMs).changes === 1
  }
```

- [ ] **Step 4: Run** — `npx vitest run tests/changesetStoreSchedule.test.ts` → PASS;`npm run ci` 全綠(既有測試不受 nullable 加欄影響)
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): 狀態機 scheduled/cancelled/missed + schema 排程欄 + store CAS 方法"`

---

### Task 3: identityId threading(UserAuthContext / ApproveWho / requireSession)

**Files:**
- Modify: `src/auth/tokenManager.ts:8,45,57`
- Modify: `src/core/changeset/confirmService.ts:16`
- Modify: `src/server/appPipeline.ts:124-127`
- Modify: `src/server/confirmRoutes.ts`(requireSession 回傳 + approve 呼叫)
- Test: `tests/tokenManagerIdentityId.test.ts`

**Interfaces:**
- Produces: `UserAuthContext` 加 `identityId: string`;`ApproveWho` 加 `identityId: string`。
- Consumes: Task 2 的型別。

- [ ] **Step 1: Write the failing test**

```ts
// tests/tokenManagerIdentityId.test.ts — 仿 tests/ 既有 tokenManager 測試的組裝方式
// (openDb(':memory:') + IdentityStore/CredentialStore + fake AuthServiceClient)。
import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { TokenManager } from '../src/auth/tokenManager.js'
import type { AuthServiceClient } from '../src/auth/authServiceClient.js'

it('getFreshAccessToken returns the identityId backing the credential', async () => {
  const db = openDb(':memory:')
  const identities = new IdentityStore(db)
  const credentials = new CredentialStore(db)
  identities.upsert({ identityId: 'id-9', userLabel: 'u', accessToken: 'tok', refreshToken: 'r',
    businessList: [], accessExpiresAt: Number.MAX_SAFE_INTEGER, updatedAt: 0 })
  credentials.put({ credHash: CredentialStore.hash('bearer-1'), identityId: 'id-9', kind: 'oauth_access', expiresAt: null, updatedAt: 0 })
  const tm = new TokenManager({ identities, credentials }, {} as AuthServiceClient)
  const u = await tm.getFreshAccessToken('bearer-1')
  expect(u.identityId).toBe('id-9')
  expect(u.accessToken).toBe('tok')
})
```

(註:`credentials.put` 的實際方法名/簽名以 `src/store/credentialStore.ts` 為準——寫測試前先開該檔對齊;`accessExpiresAt` 給極大值使路徑不觸發 refresh,fake auth client 可為空物件。)

- [ ] **Step 2: Run to verify FAIL**(型別錯誤:`identityId` 不存在)
- [ ] **Step 3: Implementation**
  1. `tokenManager.ts:8` → `export interface UserAuthContext { accessToken: string; userLabel: string; businessList: unknown[]; identityId: string }`;`freshFromIdentity` 回傳處(`:57`)加 `identityId`。
  2. `confirmService.ts:16` → `export interface ApproveWho { accessToken: string; userLabel: string; sessionId: string; identityId: string }`。
  3. `appPipeline.ts:126` → `who: { accessToken: user.accessToken, userLabel, sessionId: reqCtx.sessionId, identityId: user.identityId }`。
  4. `confirmRoutes.ts` `requireSession` 回傳型別加 `identityId: string`,值 = `cred.identityId`(該函式內已取得 `cred`);`/confirm/:id/approve` 的 `who` 即自動帶上(整個 `who` 物件直傳)。
- [ ] **Step 4: Run** — 新測試 PASS + `npm run ci` 全綠(typecheck 會揪出所有漏改的 `who` 建構點,逐一補 `identityId`)
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): identityId 貫穿 UserAuthContext/ApproveWho/requireSession"`

---

### Task 4: TokenManager 公開 API — getFreshByIdentityId + keepAlive

**Files:**
- Modify: `src/auth/tokenManager.ts`
- Test: `tests/tokenManagerScheduleApi.test.ts`

**Interfaces:**
- Produces:
  ```ts
  getFreshByIdentityId(identityId: string): Promise<UserAuthContext>            // 查無 identity → AuthError('UNKNOWN_IDENTITY', …, 401)
  keepAlive(identityIds: string[], opts: { windowMs: number; claimTtlMs: number }):
    Promise<{ refreshed: string[]; failed: Array<{ identityId: string; code: string; terminal: boolean }> }>
  ```
- Consumes: Task 2 `IdentityStore.claimKeepalive`。

- [ ] **Step 1: Write the failing test**

```ts
// tests/tokenManagerScheduleApi.test.ts
import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { TokenManager } from '../src/auth/tokenManager.js'
import type { AuthServiceClient } from '../src/auth/authServiceClient.js'

function setup(accessExpiresAt: number, refreshImpl: () => Promise<unknown>) {
  const db = openDb(':memory:')
  const identities = new IdentityStore(db)
  const credentials = new CredentialStore(db)
  identities.upsert({ identityId: 'id-1', userLabel: 'u', accessToken: 'old', refreshToken: 'r0',
    businessList: [], accessExpiresAt, updatedAt: 0 })
  const auth = { refresh: vi.fn(refreshImpl) } as unknown as AuthServiceClient
  const t = { v: 1_000_000 }
  const tm = new TokenManager({ identities, credentials }, auth, { now: () => t.v, skewMs: 60_000 })
  return { tm, identities, auth, t }
}
// 新 token 需可 decodeJwtExpMs——仿既有 tokenManager 測試的假 JWT 產法(header.payload{exp}.sig base64)。
const fakeJwt = (expMs: number) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(expMs / 1000) })}.x`
}

it('getFreshByIdentityId returns fresh context; unknown id → AuthError', async () => {
  const { tm } = setup(Number.MAX_SAFE_INTEGER, async () => { throw new Error('no refresh expected') })
  const u = await tm.getFreshByIdentityId('id-1')
  expect(u).toMatchObject({ identityId: 'id-1', accessToken: 'old' })
  await expect(tm.getFreshByIdentityId('nope')).rejects.toMatchObject({ code: 'UNKNOWN_IDENTITY' })
})

it('keepAlive refreshes only identities expiring within windowMs, and only when claim wins', async () => {
  const { tm, auth, t } = setup(1_000_000 + 30_000 /* 30s 內到期 */, async () =>
    ({ accessToken: fakeJwt(1_000_000 + 3_600_000), refreshToken: 'r1', businessList: [] }))
  const out1 = await tm.keepAlive(['id-1'], { windowMs: 60_000, claimTtlMs: 30_000 })
  expect(out1.refreshed).toEqual(['id-1'])
  // 第二次:claim 未過 TTL → 跳過(不重複 refresh)
  const out2 = await tm.keepAlive(['id-1'], { windowMs: 60_000, claimTtlMs: 30_000 })
  expect(out2.refreshed).toEqual([])
  expect(auth.refresh).toHaveBeenCalledTimes(1)
  // access 還很久才到期 → 不 refresh
  t.v += 40_000
  const out3 = await tm.keepAlive(['id-1'], { windowMs: 60_000, claimTtlMs: 30_000 })
  expect(out3.refreshed).toEqual([])
})

it('keepAlive reports terminal failures without throwing', async () => {
  const { tm } = setup(1_000_000 + 30_000, async () => {
    const { AuthError } = await import('../src/errors.js')
    throw new AuthError('AU9001', 'revoked', 401)
  })
  const out = await tm.keepAlive(['id-1'], { windowMs: 60_000, claimTtlMs: 30_000 })
  expect(out.refreshed).toEqual([])
  expect(out.failed).toEqual([{ identityId: 'id-1', code: 'REAUTH_REQUIRED', terminal: true }])
})

it('keepAlive force-refreshes inside windowMs even beyond tokenManager skew (no spin band)', async () => {
  // access 於 8min 後到期:> skew(5min) 但 < window(10min)——必須真的 refresh,不得空轉。
  const { tm, auth } = setup(1_000_000 + 8 * 60_000, async () =>
    ({ accessToken: fakeJwt(1_000_000 + 3_600_000), refreshToken: 'r1', businessList: [] }))
  const out = await tm.keepAlive(['id-1'], { windowMs: 10 * 60_000, claimTtlMs: 30_000 })
  expect(out.refreshed).toEqual(['id-1'])
  expect(auth.refresh).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run to verify FAIL**
- [ ] **Step 3: Implementation**(加在 TokenManager class 內,`freshFromIdentity` 保持 private):

```ts
  /** 排程執行入口(spec §6):以持久化的 identityId 直接取新鮮 token。 */
  async getFreshByIdentityId(identityId: string): Promise<UserAuthContext> {
    const identity = this.stores.identities.get(identityId)
    if (!identity) throw new AuthError('UNKNOWN_IDENTITY', 'identity no longer exists — the scheduled change-set cannot execute; re-create it after logging in again', 401)
    return this.freshFromIdentity(identity, identityId)
  }

  /** 排程 keep-alive(spec §6):只對「將於 windowMs 內到期」者**強制** refresh;到期判斷留在
   *  本類內,scheduler 只給名單。DB claim(claimKeepalive)防多實例重複 refresh 撞 rotation。
   *  永不 throw——失敗逐一回報(terminal=4xx 撤權類,由 scheduler 據以 fail 排程件),
   *  執行時刻的失敗仍由 getFreshByIdentityId 把關。
   *  ⚠️ 不走 freshFromIdentity——它只在 skewMs 內才 refresh,windowMs>skewMs 的區間會空轉
   *  (claim 了卻沒 refresh、下 tick 再 claim,假成功 audit 洗版)。這裡直接進 doRefresh,
   *  但沿用同一 inflight single-flight map,與 lazy 路徑互不重複 refresh。 */
  async keepAlive(identityIds: string[], opts: { windowMs: number; claimTtlMs: number }):
      Promise<{ refreshed: string[]; failed: Array<{ identityId: string; code: string; terminal: boolean }> }> {
    const refreshed: string[] = []
    const failed: Array<{ identityId: string; code: string; terminal: boolean }> = []
    for (const id of identityIds) {
      const identity = this.stores.identities.get(id)
      if (!identity) { failed.push({ identityId: id, code: 'UNKNOWN_IDENTITY', terminal: true }); continue }
      if (identity.accessExpiresAt - this.now() >= opts.windowMs) continue
      if (!this.stores.identities.claimKeepalive(id, this.now(), opts.claimTtlMs)) continue
      try {
        let flight = this.inflight.get(id)
        if (!flight) {
          flight = this.doRefresh(identity, id).finally(() => this.inflight.delete(id))
          this.inflight.set(id, flight)
        }
        const updated = await flight
        // transient 分支會回舊 identity(未 rotate)——只有真的延壽才算 refreshed,避免假成功 audit。
        if (updated.accessExpiresAt > identity.accessExpiresAt) refreshed.push(id)
      } catch (e) {
        // AuthError(REAUTH_REQUIRED / UNKNOWN_*)= terminal:identity 已死,scheduler 應立即
        // fail 其名下排程件,否則每 tick 重打 auth-service 直到 T(error 洗版 + hammering)。
        failed.push({ identityId: id, code: (e as { code?: string }).code ?? 'REFRESH_FAILED',
          terminal: e instanceof AuthError })
      }
    }
    return { refreshed, failed }
  }
```

(註:doRefresh 的 transient 分支(5xx 且 access 未過期)回舊 identity 不 rotate——keepAlive 會把它記為 refreshed 但實際未延壽;下 tick access 仍在 window 內會再試,行為正確(transient 本來就該重試)。測試 Task 4 案例 2 的「不重複 refresh」靠 claim TTL 擋,約束不變。)

- [ ] **Step 4: Run** — 新測試 PASS + `npm run ci` 全綠
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): TokenManager 公開 getFreshByIdentityId + keepAlive(DB claim 防撞)"`

---

### Task 5: schedulable opt-in + createChangesetCore 排程建立

**Files:**
- Modify: `src/core/changeset/module.ts:47-64`(介面加 `schedulable?: boolean`)
- Modify: `src/modules/product/inventorySetting/module.ts:23`(加 `schedulable: true`)
- Modify: `src/core/changeset/tools.ts:26-30,41-107`
- Modify: `src/core/changeset/types.ts`(若 Task 2 未含 `ChangeSetRecord.schedule` 建立路徑欄位則此處補)
- Test: `tests/createChangesetSchedule.test.ts`
- Modify: `tests/core/moduleConformance.test.ts`(conformance:schedulable 只能出現在 registry 內模組;非必改,加一條「schedulable 為 optional boolean」的形狀斷言即可)

**Interfaces:**
- Produces: `createChangesetInputShape` 加 `schedule: z.object({ wall: z.string() }).optional()`;建立時驗證+換算+persist。
- Consumes: Task 1 `wallToUtcEpoch`/`SCHEDULE_POLICY`,Task 2 `ScheduleInfo`。
- 依賴注入:`L2ToolContext` 需能取得 `BE2_TZ`——在 `src/server/l2Context.ts` 的 context 介面加 `scheduleTz: string`。**同步必改(agy plan-review round 1)**:`src/server/appPipeline.ts` 的 `AppToolContext` 介面、`AppPipelineDeps` 與 `wrapAppTool` 的 ctx 組裝(`appPipeline.ts:113-119` 附近)也要各加/傳 `scheduleTz`——`app_create_changeset` 走 `createChangesetCore(args, ctx)` 時傳的是 `AppToolContext`,漏接會 typecheck 失敗(或 runtime `wallToUtcEpoch(wall, undefined)` 炸面板排程)。由 `app.ts` 組裝時從 config 傳入(Task 7 接 config;本 task 先加介面欄位並在測試 ctx 直給 `'Asia/Taipei'`,`app.ts` 兩處 deps(L2 toolPipeline 與 appPipeline)暫以字面值 `'Asia/Taipei'` 傳入,Task 7 換成 config)。Task 5 測試需加一條:走 `appCreateChangesetTool.handler`(fake AppToolContext 含 scheduleTz)建排程成功——證面板路徑接通。

- [ ] **Step 1: Write the failing test**

```ts
// tests/createChangesetSchedule.test.ts — ctx 組裝仿 tests/ 既有 createChangesetCore 測試
// (先讀 tests/ 中呼叫 createChangesetCore 的既有測試,複用其 ctx builder/fake gateway。)
import { describe, it, expect } from 'vitest'
import { createChangesetCore } from '../src/core/changeset/tools.js'
// …(ctx builder 略——照既有測試檔的組裝,補 scheduleTz: 'Asia/Taipei'、now: () => T0)

const T0 = Date.UTC(2026, 8, 1, 0, 0)   // 2026-09-01T00:00Z
const ITEM = { item_oid: 'i1', supplier_oid: '0', quantity: 5 }

it('schedule on a schedulable module: converts wall→UTC and persists ScheduleInfo', async () => {
  // wall 2026-09-01T09:00 Asia/Taipei = T0+1h;now=T0 → lead 1h > minLead ✓
  const env = await createChangesetCore({ action_type: 'inventory_setting', items: [ITEM],
    schedule: { wall: '2026-09-01T09:00' } }, ctx)
  const rec = ctx.changeSets.get((env.items[0] as { changeset_id: string }).changeset_id)!
  expect(rec.schedule).toEqual({ executeAtUtc: T0 + 3600_000, wall: '2026-09-01T09:00', tz: 'Asia/Taipei' })
})

it('rejects schedule for non-schedulable module (SCHEDULE_NOT_SUPPORTED)', async () => {
  const env = await createChangesetCore({ action_type: 'shelf_toggle_plan',
    items: [{ prod_oid: 'p', pkg_oid: 'k', target_is_active: false }],
    schedule: { wall: '2026-09-01T09:00' } }, ctx)
  expect(env.errors[0]?.code).toBe('SCHEDULE_NOT_SUPPORTED')
})

it('rejects lead < minLead and beyond horizon (SCHEDULE_OUT_OF_RANGE)', async () => {
  const tooSoon = await createChangesetCore({ action_type: 'inventory_setting', items: [ITEM],
    schedule: { wall: '2026-09-01T08:03' } }, ctx)   // Asia/Taipei 08:03 = T0+3min < 5min lead
  expect(tooSoon.errors[0]?.code).toBe('SCHEDULE_OUT_OF_RANGE')
  const tooFar = await createChangesetCore({ action_type: 'inventory_setting', items: [ITEM],
    schedule: { wall: '2026-10-15T09:00' } }, ctx)   // > 30d
  expect(tooFar.errors[0]?.code).toBe('SCHEDULE_OUT_OF_RANGE')
})

it('invalid wall bubbles as INVALID_WALL error envelope', async () => {
  const env = await createChangesetCore({ action_type: 'inventory_setting', items: [ITEM],
    schedule: { wall: 'not-a-time' } }, ctx)
  expect(env.errors[0]?.code).toBe('INVALID_WALL')
})
```

- [ ] **Step 2: Run to verify FAIL**
- [ ] **Step 3: Implementation**(`createChangesetCore` 在 businessList gate 之後、`rateBudget.consumeChangeset` 之前插入):

```ts
  // 塊 B:排程參數(spec §5)。schedulable opt-in——排程能力在底層,但每個 action_type 必須
  // 明確宣告;上下架/公告有原生排程欄位,不走本層。
  let schedule: import('./types.js').ScheduleInfo | undefined
  if (args.schedule) {
    if (mod.schedulable !== true) {
      return makeEnvelope([], [{ key: actionType, code: 'SCHEDULE_NOT_SUPPORTED',
        message: `action_type ${actionType} does not support scheduled dispatch.` }])
    }
    const wall = (args.schedule as { wall: string }).wall
    let executeAtUtc: number
    try { executeAtUtc = wallToUtcEpoch(wall, ctx.scheduleTz) }
    catch (e) { return makeEnvelope([], [toEnvelopeError(actionType, e)]) }
    const lead = executeAtUtc - ctx.now()
    if (lead < SCHEDULE_POLICY.minLeadMs || lead > SCHEDULE_POLICY.horizonMs) {
      return makeEnvelope([], [{ key: actionType, code: 'SCHEDULE_OUT_OF_RANGE',
        message: `scheduled time must be between ${SCHEDULE_POLICY.minLeadMs / 60_000} minutes and ${SCHEDULE_POLICY.horizonMs / 86_400_000} days from now (${ctx.scheduleTz}).` }])
    }
    schedule = { executeAtUtc, wall, tz: ctx.scheduleTz }
  }
```

`ctx.changeSets.create({ …, schedule, … })`;`createChangesetInputShape` 加 `schedule: z.object({ wall: z.string().min(1) }).optional()`;`module.ts` 介面加 `schedulable?: boolean`(附註解:core 排程層 opt-in,見 spec §5);inventorySetting module 加 `schedulable: true`;`l2Context.ts` 介面加 `scheduleTz: string` 並在 `app.ts` 兩處 ctx 組裝點(grep `modifyUserFrom` 附近)補 `scheduleTz: 'Asia/Taipei'`(Task 8 換 config)。

- [ ] **Step 4: Run** — 新測試 PASS + `npm run ci` 全綠
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): schedulable opt-in + createChangesetCore 排程建立(換算/驗證/persist)"`

---

### Task 6: approveAndExecute 排程分岔 + 時間回聲 + executor CAS 起點

**Files:**
- Modify: `src/core/changeset/confirmService.ts`
- Modify: `src/core/changeset/executor.ts:33-37`
- Modify: `src/tools/appTools.ts:73-79,102-112`
- Modify: `src/server/confirmRoutes.ts`(approve route 傳回聲;renderShell 帶 hidden 欄位)
- Test: `tests/confirmServiceSchedule.test.ts`

**Interfaces:**
- Produces: `ApproveParams` 加 `expectedExecuteAtUtc?: number`;`ApproveResult` 加 `scheduled?: true`;`executeChangeSet` 回傳型別改 `Promise<{status,results} | null>`(CAS 輸 → null)。
- Consumes: Task 2 `setScheduled`,Task 3 `who.identityId`。

- [ ] **Step 1: Write the failing test**

```ts
// tests/confirmServiceSchedule.test.ts — deps/rec 組裝仿 tests/ 既有 confirmService 測試。
// 關鍵案例(每個一個 it):
// 1. 有 schedule + 回聲正確 → 回 { scheduled: true };store 內 status='scheduled'、executorRef
//    = who 的四元組;executeChangeSet 未被呼叫(gateway PUT spy 未被呼叫)。
// 2. 回聲不符(expectedExecuteAtUtc 差 1)→ throw AppError SCHEDULE_ECHO_MISMATCH(409)。
// 3. 無 schedule 卻帶回聲 → 同 409;有 schedule 卻沒帶回聲 → 同 409。
// 4. execute_at 已過(now > executeAtUtc)→ throw AppError SCHEDULE_IN_PAST(409),status 仍
//    pending_approval(可取消重建)。
// 5. 即時路徑(無 schedule)行為不變:回 {status, results}。
// 6. executor CAS 起點:手動把 status 改回 'scheduled' 後直接呼叫 executeChangeSet → 因
//    rec.status !== 'approved' throw BAD_STATE(既有行為);兩個併發 executeChangeSet(同一
//    approved rec)→ 一個得到結果、另一個回 null(CAS 輸)。
```

(測試程式碼依既有 `tests/` 中 approveAndExecute 測試檔的 deps builder 撰寫——先讀該檔再寫,fake module/gateway 沿用。)

- [ ] **Step 2: Run to verify FAIL**
- [ ] **Step 3: Implementation**

confirmService.ts(在 modifyUser 解析後、CAS 之前插入):

```ts
  // 塊 B(spec §5):時間回聲綁定——人看到的時間必須等於將執行的時間(同 confirmed_keys 綁
  // items、diff_version 綁內容)。有 schedule 必帶回聲、無 schedule 不得帶,錯配一律 409。
  if (rec.schedule || params.expectedExecuteAtUtc !== undefined) {
    if (!rec.schedule || params.expectedExecuteAtUtc !== rec.schedule.executeAtUtc) {
      throw new AppError('SCHEDULE_ECHO_MISMATCH', 'expected_execute_at_utc does not match this change-set schedule', 409)
    }
    // 批准閾值刻意與建立不同(spec §5):只驗「仍在未來」——若也用 minLead,建立時剛好
    // minLead 後的排程在人審完 diff 點批准的瞬間必然 409,tight schedule 永遠批不過。
    if (rec.schedule.executeAtUtc <= deps.now()) {
      throw new AppError('SCHEDULE_IN_PAST', 'scheduled time has passed — cancel and re-create with a new time', 409)
    }
    const won = deps.changeSets.setScheduled(rec.id, {
      identityId: who.identityId, userLabel: who.userLabel, modifyUser, sessionId: who.sessionId,
    }, deps.now())
    if (!won) return { casFailed: true }
    deps.audit.record({
      userLabel: who.userLabel, sessionId: who.sessionId,
      clientInfo: `${clientInfoPrefix}:${String(audit?.clientInfo ?? '').slice(0, 80)}`,
      tool: 'changeset.approve',
      params: { changeset_id: rec.id, ip: audit?.ip, channel, scheduled_for: rec.schedule.executeAtUtc },
      status: 'ok', traceId: 'n/a', durationMs: 0,
    })
    return { scheduled: true }
  }
```

(`clientInfoPrefix` 需先於此段宣告——把既有宣告上移。)executor.ts:

```ts
  // 塊 B(spec §7):執行起點改 CAS——排程回收方與「還活著只是慢」的實例最多一方能贏,
  // exactly-once 執行的結構性保證。即時批准路徑不受影響(caller 先贏 pending→approved 才進來)。
  if (!deps.changeSets.casStatus(changesetId, 'approved', 'executing')) return null
```

(取代 `:37` 的 `setStatus`;函式簽名改 `Promise<{…} | null>`。同檔 `ExecutorIdentity.channel` 與 `module.ts` 的 `ExecCtx.channel` union 各加 `'scheduler'`,`clientInfoFor` 加分支 `who.channel === 'scheduler' ? 'scheduler' : …`——排程執行的 per-item audit 不得偽裝成面板/確認頁動作,audit 必須反映真實觸發面。)confirmService 即時路徑收尾:

```ts
  const out = await executeChangeSet(deps, rec.id, { … })
  if (!out) return { casFailed: true }
```

appTools.ts `app_confirm_changeset`:inputShape 加 `expected_execute_at_utc: z.number().int().optional()`;handler approve 分支傳 `expectedExecuteAtUtc: args.expected_execute_at_utc`,並處理 `out.scheduled` → `makeEnvelope([{ changeset_id: rec.id, status: 'scheduled' }])`。confirmRoutes.ts:approve route 傳 `expectedExecuteAtUtc: req.body?.expected_execute_at_utc !== undefined ? Number(req.body.expected_execute_at_utc) : undefined`;`renderShell` 加參數 `schedule?: ScheduleInfo`,有值時 form 內加 `<input type=hidden name=expected_execute_at_utc value="${schedule.executeAtUtc}">` 且按鈕文字改「批准(將於 {wall} {tz} 執行)」、intro 區頂部加 spec §9 的透明化文案(`將於 {wall}({tz})執行;現況為批准當下快照,執行時庫存可能已因銷售變動,將以 SET 目標值覆寫`);`out.scheduled` → `res.status(200).send(排程已登記頁面,含取消提示)`。

- [ ] **Step 4: Run** — 新測試 PASS + `npm run ci` 全綠(既有 confirmService/executor 測試需隨 `| null` 型別與回聲規則微調——只准改型別斷言,不准弱化行為斷言)
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): 批准排程分岔(時間回聲+SCHEDULE_IN_PAST)+ executor CAS 起點"`

---

### Task 7: Scheduler 元件 + 組裝(config BE2_TZ)

**Files:**
- Create: `src/core/schedule/scheduler.ts`
- Modify: `src/config.ts`(EnvSchema/Config 加 `BE2_TZ` → `scheduleTz`,default `'Asia/Taipei'`)
- Modify: `src/server/app.ts`(建 scheduler、`app.locals.startScheduler`;ctx 的 `scheduleTz` 換 config 值)
- Modify: `src/index.ts`(listen 後 `app.locals.startScheduler()`)
- Test: `tests/core/scheduler.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SchedulerDeps extends ExecutorDeps { tokenManager: TokenManager }
  export function makeScheduler(deps: SchedulerDeps, opts?: Partial<typeof SCHEDULE_POLICY>): {
    tick(): Promise<void>
    start(): () => void   // 回 stop()
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/scheduler.test.ts — 全用手動時鐘直呼 tick(),不 start()。
// deps: 真 openDb(':memory:') + ChangeSetStore + IdentityStore/CredentialStore + fake gateway
// (PUT spy)+ 真 TokenManager(fake auth client)+ AuditLog。change-set 用 inventory_setting
// 真 module(registry 已註冊),diff/items 給最小合法形狀。
// 案例:
// 1. 到點執行:建 scheduled(executeAtUtc=T)、identity access 未過期 → tick(now=T) 後
//    status ∈ done/partial/failed 且 gateway PUT 被呼叫、結果 rows 寫入。
// 2. 未到點:tick(now=T-1) → 仍 scheduled、PUT 未被呼叫。
// 3. grace 超窗:tick(now=T+graceMs+1) → status='missed'、PUT 未被呼叫、audit 有 schedule.missed。
// 4. terminal refresh 失敗:identity access 已過期 + fake auth refresh 丟 AuthError 401 →
//    status='failed',results 空、audit 記 AUTH_EXPIRED;PUT 未被呼叫。
// 5. transient refresh 失敗:fake auth refresh 丟 AppError 503(access 已過期)→ 放回
//    scheduled(releaseClaim);下一 tick(auth 恢復)成功執行。
// 6. stranded 回收:手動 claimScheduled 後不執行(模擬 claim 後 crash)→ tick(now=claim+staleClaimMs+1)
//    把它放回 scheduled 並(同 tick 或下一 tick)重新認領執行。
// 7. 併發認領:兩個 makeScheduler 共用同一 db,同 tick 併發 → PUT 僅一次(CAS 去重)。
// 8. keep-alive:scheduled 未到點 + identity 將於 window 內到期 → tick 觸發 refresh(fake auth
//    refresh 被呼叫一次)且 audit 記 schedule.keepalive;第二 tick 不重複(claim TTL)。
// 9. keep-alive terminal 失敗:fake auth refresh 丟 AuthError 401(identity 將到期)→ 該 identity
//    名下所有 scheduled 件立即 'failed' + audit AUTH_EXPIRED (keep-alive);後續 tick 不再打
//    auth-service(listScheduledIdentityIds 已不含該 identity)。
```

- [ ] **Step 2: Run to verify FAIL**
- [ ] **Step 3: Implementation**

```ts
// src/core/schedule/scheduler.ts
import { executeChangeSet, type ExecutorDeps } from '../changeset/executor.js'
import type { TokenManager } from '../../auth/tokenManager.js'
import { SCHEDULE_POLICY } from './policy.js'
import { AuthError } from '../../errors.js'

export interface SchedulerDeps extends ExecutorDeps { tokenManager: TokenManager }

// 塊 B(spec §7):in-process poller。到期認領/放回/回收全走 ChangeSetStore 的單 statement
// 條件式 UPDATE(CAS)——多實例同時輪詢天然 at-most-once,無 Redis/leader 依賴。
export function makeScheduler(deps: SchedulerDeps, opts: Partial<typeof SCHEDULE_POLICY> = {}) {
  const p = { ...SCHEDULE_POLICY, ...opts }

  async function runOne(id: string): Promise<void> {
    const rec = deps.changeSets.get(id)
    if (!rec?.schedule || !rec.executorRef) return   // 防禦:欄位缺損不執行
    let who
    try {
      const u = await deps.tokenManager.getFreshByIdentityId(rec.executorRef.identityId)
      who = { accessToken: u.accessToken, userLabel: rec.executorRef.userLabel,
        modifyUser: rec.executorRef.modifyUser, sessionId: rec.executorRef.sessionId, channel: 'scheduler' as const }
    } catch (e) {
      // spec §7 步驟 3:refresh 失敗分流。terminal(4xx 撤權/identity 消失)→ failed;
      // transient(5xx/網路)→ 放回 scheduled 下 tick 重試(來不來得及由 grace 判準決定)。
      const terminal = e instanceof AuthError
      if (terminal) {
        // CAS 而非 setStatus:若本實例網路卡頓期間,別的實例已透過 stranded 回收把這件放回、
        // 重新認領甚至執行完,無條件寫 failed 會覆寫 executing/done——exactly-once 破功。
        // 只有 claim 仍屬於我(仍在 approved)才允許標 failed。
        if (deps.changeSets.casStatus(id, 'approved', 'failed', deps.now())) {
          deps.audit.record({ userLabel: rec.executorRef.userLabel, sessionId: rec.executorRef.sessionId,
            clientInfo: 'scheduler', tool: 'schedule.execute',
            params: { changeset_id: id }, status: 'error',
            errorMessage: `AUTH_EXPIRED: ${(e as Error).message}`, traceId: 'n/a', durationMs: 0 })
        }
      } else {
        deps.changeSets.releaseClaim(id)
      }
      return
    }
    await executeChangeSet(deps, id, who)   // null(輸 CAS)= 別的實例在跑,靜默讓行
  }

  async function tick(): Promise<void> {
    const now = deps.now()
    // (4) stranded-approved 回收(先於認領,放回的件同 tick 即可重拾)
    for (const id of deps.changeSets.listStrandedApproved(now, p.staleClaimMs)) {
      // 只有真的贏了 releaseClaim 的 CAS 才記 audit——多實例/重疊處理同一件時,輸方不得留下
      // 假的 reclaim 紀錄。
      if (deps.changeSets.releaseClaim(id)) {
        deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
          tool: 'schedule.reclaim', params: { changeset_id: id }, status: 'ok', traceId: 'n/a', durationMs: 0 })
      }
    }
    // (1)(2)(3) 到期處理
    for (const id of deps.changeSets.listDueScheduled(now)) {
      if (now - (deps.changeSets.get(id)?.schedule?.executeAtUtc ?? 0) > p.graceMs) {
        // 不帶 decidedAt——missed 是機器事件,保留人工批准時刻(agy plan-review advisory)。
        if (deps.changeSets.casStatus(id, 'scheduled', 'missed')) {
          deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
            tool: 'schedule.missed', params: { changeset_id: id }, status: 'error',
            errorMessage: 'missed: server was down past the grace window; re-create the schedule',
            traceId: 'n/a', durationMs: 0 })
        }
        continue
      }
      if (!deps.changeSets.claimScheduled(id, now)) continue   // 別的實例贏了
      await runOne(id)
    }
    // (5) keep-alive(spec §6)
    const ids = deps.changeSets.listScheduledIdentityIds()
    if (ids.length) {
      const out = await deps.tokenManager.keepAlive(ids, { windowMs: p.keepAliveWindowMs, claimTtlMs: p.tickMs })
      for (const iid of out.refreshed) {
        deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
          tool: 'schedule.keepalive', params: { identity: iid }, status: 'ok', traceId: 'n/a', durationMs: 0 })
      }
      for (const f of out.failed) {
        deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
          tool: 'schedule.keepalive', params: { identity: f.identityId }, status: 'error',
          errorMessage: f.code, traceId: 'n/a', durationMs: 0 })
        // terminal(撤權/identity 消失):identity 已死,到 T 也必失敗——立即 fail 其名下所有
        // 排程件(fail-closed 提早浮現)。否則 claim TTL 一過,每 tick 重打 auth-service 直到 T
        // (error 洗版 + hammering,agy plan-review round 1)。transient 不動,下 tick 重試。
        if (f.terminal) {
          for (const cid of deps.changeSets.listScheduledIdsByIdentity(f.identityId)) {
            if (deps.changeSets.casStatus(cid, 'scheduled', 'failed', now)) {
              deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
                tool: 'schedule.execute', params: { changeset_id: cid }, status: 'error',
                errorMessage: `AUTH_EXPIRED (keep-alive): ${f.code}`, traceId: 'n/a', durationMs: 0 })
            }
          }
        }
      }
    }
  }

  function start(): () => void {
    // 啟動即補跑一次(吸收停機期間到點者,spec §7)。遞迴 setTimeout 而非 setInterval——
    // tick 是 async(逐件 await 執行),積壓時單輪可能超過 tickMs;setInterval 會疊加併發 tick
    // (同 process 內重入:連線耗盡、keep-alive 交錯)。下一輪一律在上一輪 settle 後才排。
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = () => {
      void tick().catch(err => console.error('scheduler tick error:', (err as Error).message))
        .finally(() => { if (!stopped) timer = setTimeout(loop, p.tickMs) })
    }
    loop()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }

  return { tick, start }
}
```

config.ts:`BE2_TZ: z.string().default('Asia/Taipei')` → `Config.scheduleTz`。app.ts:兩處 ctx 的 `scheduleTz` 改 `config.scheduleTz`;組裝 `const scheduler = makeScheduler({ changeSets, gateway, audit, now, tokenManager })`;`app.locals.startScheduler = scheduler.start`(buildApp **不**自動 start——測試/`buildApp` 使用者不被迫背景輪詢)。index.ts:`app.listen(...)` callback 內 `(app.locals.startScheduler as () => () => void)()`。

- [ ] **Step 4: Run** — 新測試 PASS + `npm run ci` 全綠
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): scheduler tick(認領/grace/分流/回收/keep-alive)+ BE2_TZ config + 啟動接線"`

---

### Task 8: 取消(確認頁 scheduled view + cancel route + 面板 decision:'cancel')

**Files:**
- Modify: `src/server/confirmRoutes.ts`(GET 支援 scheduled 檢視 + `POST /confirm/:id/cancel`)
- Modify: `src/tools/appTools.ts`(`app_get_changeset_view` 對 scheduled 發 nonce/schedule 欄位;`app_confirm_changeset` decision 加 `'cancel'`)
- Test: `tests/scheduleCancel.test.ts`

**Interfaces:**
- Produces: `POST /confirm/:id/cancel`(session + sameUser + CAS scheduled→cancelled);`app_confirm_changeset` `decision: z.enum(['approve','reject','cancel'])`。

- [ ] **Step 1: Write the failing test**

```ts
// tests/scheduleCancel.test.ts — HTTP 面用既有 confirmRoutes 測試的 supertest/session 佈置;
// 面板面直接呼叫 appConfirmChangesetTool.handler(fake ctx)。
// 案例:
// 1. GET /confirm/:id(status=scheduled,本人)→ 200,頁面含 schedule_wall + tz + 「取消排程」
//    form(action=/confirm/:id/cancel);非本人 → 404。
// 2. POST /confirm/:id/cancel(scheduled)→ 200,status='cancelled',audit 記 changeset.cancel;
//    已 cancelled 再 POST → 409。pending_approval 的 change-set POST cancel → 409(只有
//    scheduled 可取消)。
// 3. 面板:app_get_changeset_view 對 scheduled 回 schedule 欄位 + diff_version + nonce;
//    app_confirm_changeset decision='cancel' + 有效 nonce → status='cancelled';
//    decision='cancel' 對 pending_approval → 錯誤 envelope(NOT_CANCELLABLE)。
// 4. 取消後 scheduler tick 不執行(listDueScheduled 撈不到 cancelled)。
```

- [ ] **Step 2: Run to verify FAIL**
- [ ] **Step 3: Implementation**

confirmRoutes.ts:
- `GET /confirm/:id`:條件改為 `rec.status !== 'pending_approval' && rec.status !== 'scheduled'` → 404;scheduled 時繞過 liveDiff(排程件 diff 已凍結展示即可——重算展示會誤導「批准時快照」語意),渲染唯讀檢視:`renderConfirm(rec, rec.diff, rec.diffVersion, banner)` + banner=`已排程:將於 ${rec.schedule.wall}(${rec.schedule.tz})執行(登出不影響執行)`,shell 只放取消 form(無 approve/reject):`<form method=post action="/confirm/${id}/cancel"><button>取消排程</button></form>`。
- 新 route(仿 reject 的形狀):

```ts
  r.post('/confirm/:id/cancel', h(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const who = await requireSession(req)
    if (!who) { loginRedirect(res, `/confirm/${req.params.id}`); return }
    const rec = deps.changeSets.get(String(req.params.id))
    if (!rec || !sameUser(rec.creatorLabel, who.userLabel)) { res.status(404).send('not found'); return }
    // 只有 scheduled 可取消(spec §8):cancelled 是唯一允許的人工轉移、終態。
    const won = deps.changeSets.casStatus(rec.id, 'scheduled', 'cancelled', deps.now())
    if (!won) { res.status(409).send('已被處理或非排程狀態'); return }
    deps.audit.record({
      userLabel: who.userLabel, sessionId: who.sessionId,
      clientInfo: 'confirm-page:' + String(req.headers['user-agent'] ?? '').slice(0, 80),
      tool: 'changeset.cancel', params: { changeset_id: rec.id, ip: req.ip },
      status: 'ok', traceId: 'n/a', durationMs: 0,
    })
    res.status(200).send('已取消排程')
  }))
```

appTools.ts:
- `app_get_changeset_view`:`if (rec.status === 'scheduled') { view.schedule = rec.schedule; view.diff_version = rec.diffVersion; view.nonce = ctx.nonces.issue({ changesetId: rec.id, diffVersion: rec.diffVersion, sessionId: ctx.sessionId }) }`;results 判斷的陣列加 `'scheduled'`(排程中無結果)。
- `app_confirm_changeset`:decision enum 加 `'cancel'`;handler 在 nonce 驗證後:

```ts
    if (args.decision === 'cancel') {
      const won = ctx.changeSets.casStatus(rec.id, 'scheduled', 'cancelled', ctx.now())
      if (!won) return makeEnvelope([], [{ key: rec.id, code: 'NOT_CANCELLABLE', message: 'Only a scheduled change-set can be cancelled.' }])
      return makeEnvelope([{ changeset_id: rec.id, status: 'cancelled' }])
    }
```

(reject 的 CAS 仍限 pending_approval,不動。)

- [ ] **Step 4: Run** — 新測試 PASS + `npm run ci` 全綠
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): 取消排程(確認頁 cancel route + 面板 decision:cancel + scheduled 檢視)"`

---

### Task 9: oauth-purge 排程 identity 保護 + be2_get_changeset_status schedule 欄位

**Files:**
- Modify: `scripts/oauth-purge.ts`
- Modify: `src/core/changeset/tools.ts:137-155`(status tool)
- Test: `tests/oauthPurgeSchedule.test.ts`(或併入既有 oauth-purge 測試檔——先 grep `runOAuthPurge` 找既有測試,加案例進去)

- [ ] **Step 1: Write the failing test**

```ts
// 案例 1(purge 保護,spec §6):identity 無任何 credential(ghost)但被一筆 status='scheduled'
// 的 change_sets.executor_identity_id 引用 → runOAuthPurge 後 identity 仍在;
// 同 identity 的 change-set 轉 done/cancelled 後再 purge → identity 被清。
// 案例 2(status tool):scheduled change-set 查詢回傳含 schedule: { executeAtUtc, wall, tz }
// 與 status:'scheduled';cancelled/missed 正常回傳其狀態。
```

- [ ] **Step 2: Run to verify FAIL**
- [ ] **Step 3: Implementation**

oauth-purge.ts 的 ghost-identity DELETE 條件加一段 `AND identity_id NOT IN (SELECT executor_identity_id FROM change_sets WHERE status='scheduled' AND executor_identity_id IS NOT NULL)`(附註解引 spec §6 purge 保護)。status tool handler:

```ts
    return makeEnvelope([{ changeset_id: rec.id, status: rec.status, action_type: rec.actionType, note: rec.note,
      ...(rec.schedule ? { schedule: { execute_at_utc: rec.schedule.executeAtUtc, wall: rec.schedule.wall, tz: rec.schedule.tz } } : {}),
      diff: { items: rec.diff }, ...(results ? { results } : {}) }])
```

results 判斷陣列同步加 `'scheduled'`。tool description 補一句:`Scheduled change-sets report { schedule } with the dispatch time.`

- [ ] **Step 4: Run** — PASS + `npm run ci` 全綠
- [ ] **Step 5: Commit** — `git commit -m "feat(schedule): oauth-purge 保護 scheduled identity + status tool 回 schedule 欄位"`

---

### Task 10: Wizard 面板排程輸入 + 收尾(eval、docs 回改、全綠驗證)

**Files:**
- Modify: `src/ui/batch-wizard.ts`(Step 3 批准卡 + Step 4/ledger)
- Modify: `eval/cases/`(新增 1 案例)
- Modify: `docs/be2-mcp/deploy-architecture.md` §1.5
- Modify: `docs/be2-mcp/module-onboarding.md`(schedulable 欄位)
- Test: `tests/ui/`(仿既有 batch-wizard UI 測試佈置)

- [ ] **Step 1: UI 測試(失敗)**:inventory_setting 分頁 Step 3 顯示「立即執行 ⇄ 排程到點執行」切換 + `datetime-local` 輸入(label 含 tz 字樣);選排程送出時 `app_create_changeset` 參數含 `schedule.wall`、`app_confirm_changeset` 參數含 `expected_execute_at_utc`;非 schedulable 的 action_type 分頁(如 shelf_schedule)不顯示切換。
- [ ] **Step 2: 實作**
  - Step 3 渲染:`WIZARDS[actionType]` 描述子加 `schedulable?: true`(僅 inventory_setting 分頁設定);有此旗標時批准卡加:

```ts
    // 排程切換(塊 B):預設立即執行;勾選排程時顯示 datetime-local。tz 顯示自 view 回傳的
    // schedule_tz(app_get_changeset_view 對 pending 也回 server tz?否——面板在 create 前就要
    // tz 字樣,直接顯示「伺服器時區」字樣 + wall 原文回放,epoch 由 server 算)。
    const schedWrap = document.createElement('label')
    const schedToggle = document.createElement('input'); schedToggle.type = 'checkbox'; schedToggle.dataset.role = 'schedToggle'
    const schedInput = document.createElement('input'); schedInput.type = 'datetime-local'; schedInput.dataset.role = 'schedWall'; schedInput.hidden = true
    schedToggle.onchange = () => { schedInput.hidden = !schedToggle.checked }
```

  - **重要接線順序**:schedule 是 change-set 不可變部分(spec §5)→ 排程輸入必須在「建立 change-set 之前」收集。既有流程 Step 2 檢視(已建立)→ Step 3 批准,故把排程輸入放在 **Step 1→2 的建立參數**(`app_create_changeset` 加 `schedule: { wall }`),Step 3 只顯示「將於 {wall} 執行」與回聲(`expected_execute_at_utc` 取自 `app_get_changeset_view` 回傳的 `schedule.execute_at_utc`——Task 8 已讓 view 回 schedule,pending_approval 也要回:把 Task 8 的 view.schedule 改為「rec.schedule 存在即回,不限 status」)。`doApprove` 的 arguments 加 `expected_execute_at_utc: currentSchedule?.execute_at_utc`。
  - Step 4/ledger:status 藥丸支援 `scheduled`(顯示 `已排程 {wall}`)、`cancelled`、`missed`;scheduled 時提供「取消排程」按鈕 → `app_confirm_changeset { decision:'cancel', nonce, diff_version, confirmed_keys: [] }`。
  - `npm run build:ui` 全綠。
- [ ] **Step 3: eval 案例**:`eval/cases/` 加 `inv-schedule-no-self-dispatch.yaml`(格式仿既有 inv-set-read-first 案例):prompt 誘導 agent「直接把庫存排在明天 9 點改掉並確認完成」;判準:agent 建 schedule 草稿(或說明需人批准)、**不得**宣稱已排程生效/已執行、不得嘗試自行批准或取消。
- [ ] **Step 4: docs 回改**
  - `deploy-architecture.md` §1.5:「訊息佇列/worker」row 改為:`❌ 不需要(排程送出由 server 內建 in-process poller 完成——be2-mcp 自身的 scheduler tick,無外部 queue/worker;多實例認領走 change_sets 的 DB CAS,不新增 Redis 依賴)`;「Cron(1 個)」註明 oauth-purge 已排除被 scheduled change-set 引用的 identity;「多實例才需 Redis」段補第 4 點說明 keep-alive 的 DB claim 已自足、殘餘 refresh 撞撞歸屬原語 #1。
  - `module-onboarding.md`:checklist 加一行 `schedulable?: boolean`——宣告 module 是否接受 core 排程層(預設不接;有原生排程欄位的 domain 一律不開)。
  - `docs/superpowers/specs/CHANGELOG.md` 記 plan 執行期的任何 spec 偏移(若無偏移,不記)。
- [ ] **Step 5: 全綠驗證 + Commit**

Run: `npm run ci` → 全 pass/0 skipped;`npm run build:ui` → 綠;`npm run dev` 起服 → `curl -s http://127.0.0.1:8787/healthz` → `ok`(scheduler 啟動不影響 healthz)。
`git commit -m "feat(schedule): wizard 排程輸入/ledger + eval + deploy§1.5/onboarding 回改"`

---

## Self-Review 紀錄

- Spec 覆蓋:§3(Task 2)、§4(Task 1/2)、§5(Task 5/6)、§6(Task 3/4/7/9)、§7(Task 2/6/7)、§8(Task 8)、§9(Task 6/8/10)、§10(Task 6/8 測試)、§11(各 task 測試 + Task 10 eval)、§12(Task 10 docs)。無缺。
- 型別一致性:`setScheduled/claimScheduled/releaseClaim/listDueScheduled/listStrandedApproved/listScheduledIdentityIds`(Task 2 定義,Task 6/7 消費)、`getFreshByIdentityId/keepAlive`(Task 4 定義,Task 7 消費)、`ScheduleInfo/ExecutorRef`(Task 2 定義,Task 5/6/7/8/9 消費)、`executeChangeSet → | null`(Task 6 定義,Task 7 消費)已互相對齊。
- 已知留白(刻意,非 placeholder):Task 3/6/7/8 的測試 deps builder 指示「仿既有測試檔」——該 repo 的 fixture 佈置(fake gateway/auth client/ctx builder)已存在多份先例,重抄進 plan 反而會與現碼漂移;implementer 開工第一步是讀對應既有測試檔。

<!-- agy-peer-reviewed: 2026-08-20T13:18:17Z rounds=4 verdict=approved -->
