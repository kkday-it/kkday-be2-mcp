# SQLite→PostgreSQL 遷移實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** store 從 better-sqlite3 換成 PostgreSQL（生產 pg.Pool / 測試 PGlite），關閉 cloud-ready 約束 #4/#5/#6/#7/#8。

**Architecture:** 薄 `Db` 介面（`query`/`transaction`/`close`）兩個 transport 實作跑同一套 PG 方言 SQL；schema 全部移進 `db/migrations/*.sql`（自製 runner，runtime 零 DDL）；10 個 store 類別全面 async；兩支 cron HTTP endpoint（oauth-purge、scheduler-tick）。CAS 語義由「單條條件式 UPDATE + rowCount===1」保證，PGlite 測方言、真 PG 測併發。

**Tech Stack:** TypeScript ESM（`.js` import 後綴）、`pg`（生產）、`@electric-sql/pglite`（測試/本地）、vitest、express。

**Spec:** `docs/superpowers/specs/2026-09-03-pg-migration-design.md`（agy approved）。任務執行者遇本 plan 與 spec 矛盾時，以 spec 為準並回報。

## Global Constraints

- 一套 SQL、**PG 方言**；參數 placeholder 一律 `$1..$n`（better-sqlite3 的 `?`/`@name` 全改掉）。
- **runtime 路徑零 DDL**：`CREATE/ALTER/DROP` 只准出現在 `db/migrations/*.sql` 與 `scripts/db-migrate.ts`。
- timestamp 欄一律 **BIGINT（ms）**，不用 timestamptz；`consumed` 欄用 **BOOLEAN**（TS 介面維持 `number` 0/1，store 層轉換）；`*_json` 欄維持 **TEXT**。
- `pg.Pool`：`max=5`、`connectionTimeoutMillis=5000`、`idleTimeoutMillis=30000`、`statement_timeout=15000`、TLS `ssl:{rejectUnauthorized:false}`。
- module 介面零改動：**嚴禁碰 `src/modules/**` 的介面**（conformance harness 必須原樣過）。
- MCP 工具對外 schema/行為零改動。
- secret 值永不印出/落 log（沿用 config.ts 慣例：只印變數名）。
- 每個 task 結尾 commit；commit message 繁中、慣例同 repo（`feat:`/`refactor:`/`test:`/`docs:`）。
- 測試檔案不做 `sleep`/真時鐘等待——時間全用注入的 `now()`。

---

### Task 1: PGlite spike（方言與行為驗證，spec §14 風險 gate）

**Files:**
- Create: `tests/pgliteSpike.test.ts`
- Modify: `package.json`（devDependencies + dependencies）

**Interfaces:**
- Produces: 依賴裝好（`pg`、`@types/pg`、`@electric-sql/pglite`）；spike 測試證實 PGlite 支撐後續全部 pattern。此檔為**永久保留**的方言 conformance 測試。

- [ ] **Step 1: 裝依賴**

```bash
npm install pg && npm install -D @types/pg @electric-sql/pglite
```

- [ ] **Step 2: 寫 spike 測試（先寫、直接跑——本 task 驗證的是外部庫行為，非 TDD 紅綠）**

```ts
// tests/pgliteSpike.test.ts
// PGlite 方言/行為 conformance（spec §14 風險 gate）。永久保留：升級 PGlite 時此檔守住
// 我們依賴的每一個 PG 行為。若本檔任一 case 失敗 → PGlite 不可用，退 testcontainers（spec §14）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

describe('PGlite dialect conformance', () => {
  let pg: PGlite
  beforeAll(async () => {
    pg = new PGlite()  // in-memory
    await pg.exec(`
      CREATE TABLE t_identity (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE t_upsert (k TEXT PRIMARY KEY, n BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE t_cas (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE t_bool (k TEXT PRIMARY KEY, consumed BOOLEAN NOT NULL DEFAULT FALSE);
      CREATE TABLE t_audit (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, msg TEXT NOT NULL);
      CREATE FUNCTION t_audit_immutable() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER t_audit_no_update BEFORE UPDATE ON t_audit FOR EACH ROW EXECUTE FUNCTION t_audit_immutable();
      CREATE TRIGGER t_audit_no_delete BEFORE DELETE ON t_audit FOR EACH ROW EXECUTE FUNCTION t_audit_immutable();
    `)
  })
  afterAll(async () => { await pg.close() })

  it('IDENTITY 自增', async () => {
    await pg.query(`INSERT INTO t_identity (v) VALUES ($1)`, ['a'])
    await pg.query(`INSERT INTO t_identity (v) VALUES ($1)`, ['b'])
    const r = await pg.query<{ id: number | bigint }>(`SELECT id FROM t_identity ORDER BY id`)
    expect(Number(r.rows[0].id)).toBe(1)
    expect(Number(r.rows[1].id)).toBe(2)
  })

  it('ON CONFLICT DO UPDATE（upsert 計數）', async () => {
    await pg.query(`INSERT INTO t_upsert (k, n) VALUES ($1, 1) ON CONFLICT (k) DO UPDATE SET n = t_upsert.n + 1`, ['x'])
    await pg.query(`INSERT INTO t_upsert (k, n) VALUES ($1, 1) ON CONFLICT (k) DO UPDATE SET n = t_upsert.n + 1`, ['x'])
    const r = await pg.query<{ n: number | string | bigint }>(`SELECT n FROM t_upsert WHERE k = $1`, ['x'])
    expect(Number(r.rows[0].n)).toBe(2)
  })

  it('ON CONFLICT DO NOTHING', async () => {
    const a = await pg.query(`INSERT INTO t_upsert (k) VALUES ($1) ON CONFLICT DO NOTHING`, ['y'])
    const b = await pg.query(`INSERT INTO t_upsert (k) VALUES ($1) ON CONFLICT DO NOTHING`, ['y'])
    expect(a.affectedRows ?? 0).toBe(1)
    expect(b.affectedRows ?? 0).toBe(0)
  })

  it('CAS：條件式 UPDATE 的 affectedRows 恰為 0/1', async () => {
    await pg.query(`INSERT INTO t_cas (id, status) VALUES ('c1', 'pending')`)
    const win = await pg.query(`UPDATE t_cas SET status='approved' WHERE id='c1' AND status='pending'`)
    const lose = await pg.query(`UPDATE t_cas SET status='approved' WHERE id='c1' AND status='pending'`)
    expect(win.affectedRows).toBe(1)
    expect(lose.affectedRows).toBe(0)
  })

  it('BOOLEAN round-trip', async () => {
    await pg.query(`INSERT INTO t_bool (k, consumed) VALUES ($1, $2)`, ['b1', false])
    await pg.query(`UPDATE t_bool SET consumed = TRUE WHERE k = $1`, ['b1'])
    const r = await pg.query<{ consumed: boolean }>(`SELECT consumed FROM t_bool WHERE k = $1`, ['b1'])
    expect(r.rows[0].consumed).toBe(true)  // 回 JS boolean，非 0/1
  })

  it('append-only trigger 擋 UPDATE/DELETE', async () => {
    await pg.query(`INSERT INTO t_audit (msg) VALUES ('x')`)
    await expect(pg.query(`UPDATE t_audit SET msg='y' WHERE id=1`)).rejects.toThrow(/append-only/)
    await expect(pg.query(`DELETE FROM t_audit WHERE id=1`)).rejects.toThrow(/append-only/)
  })

  it('transaction rollback', async () => {
    await expect(pg.transaction(async (tx) => {
      await tx.query(`INSERT INTO t_cas (id, status) VALUES ('tx1', 'pending')`)
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const r = await pg.query(`SELECT 1 FROM t_cas WHERE id='tx1'`)
    expect(r.rows.length).toBe(0)
  })

  it('BIGINT 取值可正規化為 number（ms timestamp 值域）', async () => {
    const ts = 1756900000000  // ~2^40.7，遠低於 2^53
    await pg.query(`INSERT INTO t_upsert (k, n) VALUES ($1, $2)`, ['ts', ts])
    const r = await pg.query<{ n: unknown }>(`SELECT n FROM t_upsert WHERE k = $1`, ['ts'])
    // PGlite 對 int8 的回傳型別（number/bigint/string）在此定案；PgliteDb wrapper 據此正規化
    expect(Number(r.rows[0].n)).toBe(ts)
  })

  it('COUNT(*) 可正規化為 number', async () => {
    const r = await pg.query<{ c: unknown }>(`SELECT COUNT(*) c FROM t_upsert`)
    expect(Number(r.rows[0].c)).toBeGreaterThan(0)
  })

  it('pg_advisory_lock 可用（migration runner 依賴）', async () => {
    await pg.query(`SELECT pg_advisory_lock(42)`)
    await pg.query(`SELECT pg_advisory_unlock(42)`)
  })
})
```

- [ ] **Step 3: 跑 spike**

Run: `npx vitest run tests/pgliteSpike.test.ts`
Expected: 全 PASS。**任一 FAIL → 停下回報使用者（spec §14：退 testcontainers 的決策點），不得自行繞過。**
記下實際觀察：`affectedRows` 欄位名、int8 回傳型別（number/bigint/string）——Task 3 的 wrapper 正規化以此為準。

- [ ] **Step 4: 確認既有測試不受影響**

Run: `npm run test`
Expected: 全 PASS（新依賴不影響既有 470 tests）。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tests/pgliteSpike.test.ts
git commit -m "test: PGlite 方言 conformance spike（IDENTITY/ON CONFLICT/CAS/BOOLEAN/trigger/tx/int8）+ 裝 pg 依賴"
```

---

### Task 2: baseline migration SQL + migration 執行函式庫 + `db:migrate` runner

**Files:**
- Create: `db/migrations/0001_baseline.sql`
- Create: `db/migrations/0002_grants.sql`
- Create: `src/store/migrate.ts`
- Create: `scripts/db-migrate.ts`
- Create: `tests/migrate.test.ts`
- Modify: `package.json`（scripts 加 `"db:migrate": "tsx scripts/db-migrate.ts"`）

**Interfaces:**
- Consumes: Task 1 的 PGlite。
- Produces: `runMigrations(db: MigrationTarget, dir?: string): Promise<string[]>`（回傳本次套用的檔名；`MigrationTarget = { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>; exec(sql: string): Promise<void> }`）。Task 3 的 `openTestDb()` 與 `scripts/db-migrate.ts` 共用。

- [ ] **Step 1: 寫 baseline SQL（現行 11 張表的 PG 定稿，含歷次 ad-hoc migration 最終形狀）**

```sql
-- db/migrations/0001_baseline.sql
-- 現行 11 張表（src/store/db.ts 於 main 8441188 的最終形狀）之 PG 定稿。
-- legacy `user_tokens`（Phase A 已 DROP）不入 baseline。
-- 方言決策見 spec §5：timestamp=BIGINT(ms)、consumed=BOOLEAN、*_json=TEXT。

CREATE TABLE audit_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts            BIGINT NOT NULL,
  user_label    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  client_info   TEXT NOT NULL,
  tool          TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  status        TEXT NOT NULL,
  error_message TEXT,
  trace_id      TEXT NOT NULL,
  duration_ms   INTEGER NOT NULL
);
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE rate_counters (
  counter_key  TEXT PRIMARY KEY,
  count        BIGINT NOT NULL DEFAULT 0,
  window_start BIGINT NOT NULL
);

CREATE TABLE session_read_oids (
  session_id  TEXT NOT NULL,
  oid         TEXT NOT NULL,
  recorded_at BIGINT NOT NULL,
  PRIMARY KEY (session_id, oid)
);

CREATE TABLE change_sets (
  id                   TEXT PRIMARY KEY,
  creator_label        TEXT NOT NULL,
  creator_bearer_hash  TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  action_type          TEXT NOT NULL,
  items_json           TEXT NOT NULL,
  diff_json            TEXT NOT NULL,
  diff_version         TEXT NOT NULL,
  note                 TEXT,
  status               TEXT NOT NULL,
  created_at           BIGINT NOT NULL,
  decided_at           BIGINT,
  execute_at_utc       BIGINT,
  schedule_wall        TEXT,
  schedule_tz          TEXT,
  executor_identity_id TEXT,
  executor_label       TEXT,
  executor_modify_user TEXT,
  executor_session_id  TEXT,
  schedule_claimed_at  BIGINT
);
CREATE INDEX idx_change_sets_status ON change_sets(status);

CREATE TABLE change_set_results (
  changeset_id  TEXT NOT NULL,
  item_key      TEXT NOT NULL,
  status        TEXT NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  error_code    TEXT,
  error_message TEXT,
  trace_id      TEXT NOT NULL,
  PRIMARY KEY (changeset_id, item_key)
);

CREATE TABLE web_sessions (
  session_id   TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);

CREATE TABLE be2_identities (
  identity_id          TEXT PRIMARY KEY,
  user_label           TEXT NOT NULL,
  access_token         TEXT NOT NULL,
  refresh_token        TEXT NOT NULL,
  business_list_json   TEXT NOT NULL,
  access_expires_at    BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  keepalive_claimed_at BIGINT
);

CREATE TABLE credentials (
  cred_hash   TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  expires_at  BIGINT,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX idx_credentials_identity ON credentials(identity_id);

CREATE TABLE oauth_clients (
  client_id          TEXT PRIMARY KEY,
  redirect_uris_json TEXT NOT NULL,
  created_at         BIGINT NOT NULL
);

CREATE TABLE oauth_auth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  identity_id    TEXT NOT NULL,
  exp            BIGINT NOT NULL,
  consumed       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE oauth_refresh (
  refresh_hash     TEXT PRIMARY KEY,
  identity_id      TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  exp              BIGINT NOT NULL,
  consumed         BOOLEAN NOT NULL DEFAULT FALSE,
  access_cred_hash TEXT
);
CREATE INDEX idx_oauth_refresh_identity ON oauth_refresh(identity_id);
CREATE INDEX idx_oauth_refresh_access_cred ON oauth_refresh(access_cred_hash);
```

- [ ] **Step 2: 寫 grants migration（role 分離，spec §8.2；測試/本地無這些 role 時 no-op）**

```sql
-- db/migrations/0002_grants.sql
-- Role model（spec §8.2）：be2mcp_owner 跑 migration（schema owner）、be2mcp_app 只 CRUD。
-- audit_log 對 app role 只給 INSERT/SELECT（append-only 第二道保險，第一道是 trigger）。
-- 測試（PGlite）與本地單帳號環境沒有 be2mcp_app role → DO 區塊判斷後跳過，migration 仍可重跑。
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'be2mcp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO be2mcp_app;
    REVOKE UPDATE, DELETE ON audit_log FROM be2mcp_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO be2mcp_app;
  END IF;
END $$;
```

- [ ] **Step 3: 寫 migration 執行函式庫的失敗測試**

```ts
// tests/migrate.test.ts
import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { runMigrations } from '../src/store/migrate.js'

function target(pg: PGlite) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const r = await pg.query<Record<string, unknown>>(sql, params as never[])
      return { rows: r.rows }
    },
    exec: async (sql: string) => { await pg.exec(sql) },
  }
}

describe('runMigrations', () => {
  it('空 DB 套用全部 migration、建出 schema_migrations 記錄', async () => {
    const pg = new PGlite()
    const applied = await runMigrations(target(pg))
    expect(applied).toEqual(['0001_baseline.sql', '0002_grants.sql'])
    const t = await pg.query(`SELECT filename FROM schema_migrations ORDER BY filename`)
    expect(t.rows.map((r: Record<string, unknown>) => r.filename)).toEqual(['0001_baseline.sql', '0002_grants.sql'])
    // 11 張表存在抽查
    await pg.query(`SELECT 1 FROM change_sets LIMIT 0`)
    await pg.query(`SELECT 1 FROM audit_log LIMIT 0`)
    await pg.close()
  })

  it('重跑 = no-op（冪等）', async () => {
    const pg = new PGlite()
    await runMigrations(target(pg))
    const second = await runMigrations(target(pg))
    expect(second).toEqual([])
    await pg.close()
  })

  it('migration 檔失敗時整檔 rollback、不記錄', async () => {
    const pg = new PGlite()
    await expect(runMigrations(target(pg), 'tests/fixtures/bad-migrations')).rejects.toThrow()
    const t = await pg.query(`SELECT filename FROM schema_migrations`)
    expect(t.rows.length).toBe(0)
    await pg.close()
  })
})
```

同時建 `tests/fixtures/bad-migrations/0001_bad.sql`：

```sql
CREATE TABLE ok_table (id TEXT PRIMARY KEY);
THIS IS NOT SQL;
```

- [ ] **Step 4: 跑測試確認失敗**

Run: `npx vitest run tests/migrate.test.ts`
Expected: FAIL（`runMigrations` 不存在）。

- [ ] **Step 5: 實作 `src/store/migrate.ts`**

```ts
// src/store/migrate.ts
// Forward-only SQL migration 執行器（cloud spec §2.5）：字典序、單 transaction/檔、
// schema_migrations 記錄、advisory lock 防並行、可重跑。
// 被 scripts/db-migrate.ts（生產，經 pg client）與 tests/support/testDb.ts（PGlite）共用。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MigrationTarget {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  exec(sql: string): Promise<void>
}

const LOCK_KEY = 727_001  // 任意固定值：be2-mcp migration 全域鎖

export async function runMigrations(db: MigrationTarget, dir = 'db/migrations'): Promise<string[]> {
  await db.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`)
    const done = new Set(
      (await db.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename as string))
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    const applied: string[] = []
    for (const f of files) {
      if (done.has(f)) continue
      const sql = readFileSync(join(dir, f), 'utf8')
      // 單 transaction/檔：BEGIN + 檔內容 + 記錄 + COMMIT；任一步失敗 ROLLBACK、不記錄。
      await db.exec('BEGIN')
      try {
        await db.exec(sql)
        await db.query('INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, $2)', [f, Date.now()])
        await db.exec('COMMIT')
      } catch (e) {
        await db.exec('ROLLBACK')
        throw new Error(`migration ${f} failed: ${(e as Error).message}`)
      }
      applied.push(f)
    }
    return applied
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
  }
}
```

- [ ] **Step 6: 跑測試確認通過**

Run: `npx vitest run tests/migrate.test.ts`
Expected: PASS ×3。

- [ ] **Step 7: 寫 `scripts/db-migrate.ts`（生產 runner，pg 直連）**

```ts
// scripts/db-migrate.ts
// `npm run db:migrate` — CI / k8s Job 用（cloud spec §2.5、部署序：migrate 成功才 rollout）。
// 連線 env 與 app 相同（DB_* 或 DATABASE_URL），但應以 be2mcp_owner 帳號執行（spec §8.2）。
import pg from 'pg'
import { runMigrations } from '../src/store/migrate.js'
import { resolveDbConnection } from '../src/config.js'

async function main(): Promise<void> {
  const conn = resolveDbConnection(process.env)   // Task 4 提供；缺 env 會 throw（只印變數名）
  const client = new pg.Client({ ...conn, ssl: conn.ssl })
  await client.connect()
  try {
    const applied = await runMigrations({
      query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }),
      exec: async (sql) => { await client.query(sql) },
    })
    console.log(applied.length === 0
      ? 'db-migrate: up to date (no pending migrations)'
      : `db-migrate: applied ${applied.join(', ')}`)
  } finally {
    await client.end()
  }
}
main().catch((e) => { console.error('db-migrate FAILED:', (e as Error).message); process.exit(1) })
```

註：`resolveDbConnection` 在 Task 4 才存在——本 task 先寫 `scripts/db-migrate.ts` 但 **不加進 typecheck 驗證**；Task 4 完成後它自然編譯。若 subagent 需要本 task 內 tsc 全綠，暫時在檔頭加 `// @ts-nocheck` 並在 Task 4 移除（Task 4 的驗收含移除此行）。

- [ ] **Step 8: 加 npm script + commit**

`package.json` scripts 加：`"db:migrate": "tsx scripts/db-migrate.ts"`。

```bash
npx vitest run tests/migrate.test.ts tests/pgliteSpike.test.ts
git add db/migrations src/store/migrate.ts scripts/db-migrate.ts tests/migrate.test.ts tests/fixtures/bad-migrations package.json
git commit -m "feat: db/migrations baseline（11 表 PG 定稿 + grants）+ forward-only migration runner"
```

---

### Task 3: `Db` 介面 + `PgliteDb` + 測試 helper `openTestDb()`

**Files:**
- Create: `src/store/dbTypes.ts`
- Create: `src/store/pgliteDb.ts`
- Create: `tests/support/testDb.ts`
- Test: `tests/dbInterface.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `runMigrations`。
- Produces:
  - `interface Db { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>; transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>; close(): Promise<void> }`（`src/store/dbTypes.ts`）
  - `createPgliteDb(): Promise<Db>`（`src/store/pgliteDb.ts`）
  - `openTestDb(): Promise<Db>`（`tests/support/testDb.ts`）——**每呼叫一個獨立 in-memory PGlite + migrations 已套用**；Task 5-8 所有測試檔用它取代 `openDb(':memory:')`。

- [ ] **Step 1: 寫介面**

```ts
// src/store/dbTypes.ts
// transport 抽象（pg.Pool / PGlite），非雙 backend——兩實作跑同一套 PG 方言 SQL（spec §3.1）。
export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>
  /** fn 內所有 tx.query 走同一連線；fn throw → ROLLBACK 後 rethrow，正常返回 → COMMIT */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}
```

- [ ] **Step 2: 寫 `Db` 行為測試（對 PGlite 實作跑；Task 4 的 PgDb 併發測試在 test:pg 層）**

```ts
// tests/dbInterface.test.ts
import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'

describe('Db (PGlite transport)', () => {
  it('query 回 rows + rowCount；int8 正規化為 number', async () => {
    const db = await openTestDb()
    await db.query(`INSERT INTO rate_counters (counter_key, count, window_start) VALUES ($1, $2, $3)`, ['k', 7, 1756900000000])
    const r = await db.query<{ count: number; window_start: number }>(`SELECT count, window_start FROM rate_counters WHERE counter_key = $1`, ['k'])
    expect(r.rowCount).toBe(1)
    expect(r.rows[0].count).toBe(7)
    expect(typeof r.rows[0].count).toBe('number')
    expect(r.rows[0].window_start).toBe(1756900000000)
    await db.close()
  })

  it('UPDATE 的 rowCount 反映 affected rows（CAS 依賴）', async () => {
    const db = await openTestDb()
    await db.query(`INSERT INTO web_sessions (session_id, identity_id, created_at, last_seen_at) VALUES ('s','i',1,1)`)
    const hit = await db.query(`UPDATE web_sessions SET last_seen_at = 2 WHERE session_id = 's'`)
    const miss = await db.query(`UPDATE web_sessions SET last_seen_at = 2 WHERE session_id = 'nope'`)
    expect(hit.rowCount).toBe(1)
    expect(miss.rowCount).toBe(0)
    await db.close()
  })

  it('transaction：throw 即 rollback', async () => {
    const db = await openTestDb()
    await expect(db.transaction(async (tx) => {
      await tx.query(`INSERT INTO web_sessions (session_id, identity_id, created_at, last_seen_at) VALUES ('t','i',1,1)`)
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const r = await db.query(`SELECT 1 FROM web_sessions WHERE session_id = 't'`)
    expect(r.rowCount).toBe(0)
    await db.close()
  })

  it('openTestDb 每次獨立（隔離不互汙）', async () => {
    const a = await openTestDb()
    const b = await openTestDb()
    await a.query(`INSERT INTO web_sessions (session_id, identity_id, created_at, last_seen_at) VALUES ('iso','i',1,1)`)
    const r = await b.query(`SELECT 1 FROM web_sessions WHERE session_id = 'iso'`)
    expect(r.rowCount).toBe(0)
    await Promise.all([a.close(), b.close()])
  })
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run tests/dbInterface.test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 4: 實作 `PgliteDb` 與 `openTestDb`**

```ts
// src/store/pgliteDb.ts
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { Db } from './dbTypes.js'

// int8 正規化：PGlite 對 BIGINT 的原生回傳型別以 Task 1 spike 觀察為準；
// 統一在這裡把 bigint/string 轉 number（值域 = ms timestamp/count，<< 2^53，spec §5）。
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) {
    if (typeof row[k] === 'bigint') row[k] = Number(row[k])
  }
  return row
}

function wrap(q: PGlite | Transaction): Pick<Db, 'query'> {
  return {
    async query<R>(sql: string, params?: unknown[]) {
      const r = await q.query<Record<string, unknown>>(sql, params as never[])
      return { rows: r.rows.map(normalizeRow) as R[], rowCount: r.affectedRows ?? r.rows.length }
    },
  }
}

export async function createPgliteDb(): Promise<Db> {
  const pg = new PGlite()
  return {
    query: (sql, params) => wrap(pg).query(sql, params),
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return pg.transaction(async (t) => fn({
        query: (sql, params) => wrap(t).query(sql, params),
        transaction: () => { throw new Error('nested transaction not supported') },
        close: async () => { throw new Error('close inside transaction not supported') },
      })) as Promise<T>
    },
    close: () => pg.close(),
  }
}
```

（註：`rowCount` 用 `affectedRows ?? rows.length`——SELECT 時 PGlite 的 affectedRows 可能為 0/undefined，以 rows.length 兜底；INSERT/UPDATE/DELETE 用 affectedRows。以 Task 1 spike 實際觀察為準修正，dbInterface 測試守住正確性。）

```ts
// tests/support/testDb.ts
import type { Db } from '../../src/store/dbTypes.js'
import { createPgliteDb } from '../../src/store/pgliteDb.js'
import { runMigrations } from '../../src/store/migrate.js'

// 取代舊 openDb(':memory:')：每呼叫一個全新 in-memory PGlite + 全部 migrations。
// vitest 每檔一個 worker process，檔內多次呼叫也各自獨立 → 隔離語義與 :memory: 等價。
export async function openTestDb(): Promise<Db> {
  const db = await createPgliteDb()
  await runMigrations({
    query: async (sql, params) => ({ rows: (await db.query(sql, params)).rows }),
    exec: async (sql) => { await db.query(sql) },
  })
  return db
}
```

（註：`exec` 以 `db.query` 實作——PGlite 的 `query` 走 extended protocol 一次一句，migration 檔是多語句。若 Step 5 跑出多語句錯誤，改為在 `pgliteDb.ts` 的 `Db` 上加一個內部 `exec` 直通 `pg.exec`，並讓 `openTestDb` 用它。以實跑為準。）

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/dbInterface.test.ts tests/migrate.test.ts`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/store/dbTypes.ts src/store/pgliteDb.ts tests/support/testDb.ts tests/dbInterface.test.ts
git commit -m "feat: Db transport 介面 + PGlite 實作 + openTestDb 測試 helper"
```

---

### Task 4: `PgDb`（pg.Pool）+ config.ts DB env

**Files:**
- Create: `src/store/pgDb.ts`
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`（既有檔，加 case）

**Interfaces:**
- Consumes: Task 3 的 `Db`。
- Produces:
  - `createPgDb(conn: DbConnection): Db`（`src/store/pgDb.ts`）
  - `resolveDbConnection(env: NodeJS.ProcessEnv): DbConnection`（`src/config.ts` export；`DbConnection = { connectionString?: string; host?: string; port?: number; user?: string; password?: string; database?: string; ssl: false | { rejectUnauthorized: false } }`）
  - `Config` 介面：**移除 `dbPath`**，新增 `db: DbConnection`、`cronSecret?: string`、`schedulerMode: 'poller' | 'http'`。

- [ ] **Step 1: 寫 config 測試（加進既有 `tests/config.test.ts`）**

```ts
// tests/config.test.ts 追加（保留既有 case；BASE_ENV 為該檔既有的合法 env 底座——
// 若無此常數，用該檔現行 pattern 組一份含 AUTHSVC_URL/GATEWAY_URL/API_AUTH_SERVICE_KEY 的底座）
describe('DB config', () => {
  const base = { AUTHSVC_URL: 'https://a.example', GATEWAY_URL: 'https://g.example', API_AUTH_SERVICE_KEY: 'k' }

  it('DATABASE_URL 短路', () => {
    const cfg = loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@h:5432/d' } as NodeJS.ProcessEnv)
    expect(cfg.db.connectionString).toBe('postgres://u:p@h:5432/d')
  })
  it('DB_* 分開注入', () => {
    const cfg = loadConfig({ ...base, DB_HOST: 'h', DB_PORT: '5432', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'd' } as NodeJS.ProcessEnv)
    expect(cfg.db.host).toBe('h'); expect(cfg.db.database).toBe('d')
  })
  it('缺 DB env → fail fast 且錯誤訊息只含變數名', () => {
    expect(() => loadConfig({ ...base } as NodeJS.ProcessEnv)).toThrow(/DB_HOST|DATABASE_URL/)
    try { loadConfig({ ...base, DB_HOST: 'h' } as NodeJS.ProcessEnv) } catch (e) {
      expect((e as Error).message).not.toContain('p@')  // 不回顯值
    }
  })
  it('APP_DB_PATH 不再被接受為必要條件（已移除）', () => {
    const cfg = loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@h/d' } as NodeJS.ProcessEnv)
    expect((cfg as Record<string, unknown>).dbPath).toBeUndefined()
  })
  it('SCHEDULER_MODE 預設 poller、可設 http；CRON_SECRET 選填', () => {
    const a = loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@h/d' } as NodeJS.ProcessEnv)
    expect(a.schedulerMode).toBe('poller')
    const b = loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@h/d', SCHEDULER_MODE: 'http', CRON_SECRET: 's' } as NodeJS.ProcessEnv)
    expect(b.schedulerMode).toBe('http'); expect(b.cronSecret).toBe('s')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗** — `npx vitest run tests/config.test.ts` → FAIL。

- [ ] **Step 3: 改 `src/config.ts`**

EnvSchema 變更：移除 `APP_DB_PATH`；加：

```ts
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_NAME: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  SCHEDULER_MODE: z.enum(['poller', 'http']).default('poller'),
```

新增 export：

```ts
export interface DbConnection {
  connectionString?: string
  host?: string; port?: number; user?: string; password?: string; database?: string
  ssl: false | { rejectUnauthorized: false }
}

// TLS：本機/測試（localhost 或 PGlite）不需要；RDS 一律 no-verify（cloud spec §2.5）。
// 規則：DATABASE_URL 含 sslmode=disable 或 host 為 localhost/127.0.0.1 → ssl:false，否則 no-verify。
export function resolveDbConnection(env: NodeJS.ProcessEnv): DbConnection {
  if (env.DATABASE_URL) {
    const noSsl = env.DATABASE_URL.includes('sslmode=disable') || /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL)
    return { connectionString: env.DATABASE_URL, ssl: noSsl ? false : { rejectUnauthorized: false } }
  }
  const missing = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter(k => !env[k])
  if (missing.length > 0) throw new Error(`Invalid or missing env vars: DATABASE_URL or ${missing.join(', ')}`)
  const local = env.DB_HOST === 'localhost' || env.DB_HOST === '127.0.0.1'
  return { host: env.DB_HOST, port: Number(env.DB_PORT ?? 5432), user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, ssl: local ? false : { rejectUnauthorized: false } }
}
```

`Config` 介面：`dbPath: string` → `db: DbConnection; cronSecret?: string; schedulerMode: 'poller' | 'http'`；`loadConfig` 內呼叫 `resolveDbConnection(env)`（在 zod parse 之後）並移除 dbPath 推導。
同時移除 Task 2 在 `scripts/db-migrate.ts` 加的 `// @ts-nocheck`（若有）。
**注意**：此步會讓 `src/index.ts`、`scripts/{oauth-purge,bootstrap-user,live-4a-acceptance}.ts` 的 `cfg.dbPath` 編譯錯——本 task 先把 `src/index.ts` 的 `openDb(config.dbPath)` 行改為暫時性 `openDb('./data/be2-mcp-transition.sqlite')`（硬編、待 Task 7 刪除），三支 scripts 同樣暫改硬編字串。目的：讓 tsc 每個 task 結尾都綠、真正的切換收在 Task 7/9。

- [ ] **Step 4: 實作 `src/store/pgDb.ts`**

```ts
// src/store/pgDb.ts
import pg from 'pg'
import type { Db } from './dbTypes.js'
import type { DbConnection } from '../config.js'

// int8(BIGINT/COUNT) → Number：全碼庫值域為 ms timestamp 與 count（<< 2^53），spec §5。
pg.types.setTypeParser(20, (v: string) => Number(v))

export function createPgDb(conn: DbConnection): Db {
  const pool = new pg.Pool({
    ...(conn.connectionString ? { connectionString: conn.connectionString } : {
      host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database,
    }),
    ssl: conn.ssl,
    max: 5,                            // spec §7：單 pod 小池
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  })
  const wrap = (q: Pick<pg.PoolClient, 'query'>): Pick<Db, 'query'> => ({
    async query<R>(sql: string, params?: unknown[]) {
      const r = await q.query(sql, params)
      return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 }
    },
  })
  return {
    query: (sql, params) => wrap(pool).query(sql, params),
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn({
          query: (sql, params) => wrap(client).query(sql, params),
          transaction: () => { throw new Error('nested transaction not supported') },
          close: async () => { throw new Error('close inside transaction not supported') },
        })
        await client.query('COMMIT')
        return result
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}
```

- [ ] **Step 5: 跑測試 + typecheck**

Run: `npx vitest run tests/config.test.ts && npm run typecheck`
Expected: 全 PASS、tsc clean（含暫時硬編的過渡行）。

- [ ] **Step 6: Commit**

```bash
git add src/store/pgDb.ts src/config.ts src/index.ts scripts tests/config.test.ts
git commit -m "feat: PgDb（pg.Pool、TLS、int8 parser、timeout）+ config DB_*/CRON_SECRET/SCHEDULER_MODE"
```

---

### Task 5: 葉端 store 轉換（7 個類別 → `Db` + async + PG SQL）

**Files:**
- Modify: `src/store/credentialStore.ts`、`src/store/identityStore.ts`、`src/store/readOidStore.ts`、`src/oauth/oauthStore.ts`、`src/limits/rateBudget.ts`、`src/audit/auditLog.ts`、`src/server/webSessionStore.ts`
- Test: 各自既有單元測試檔（`tests/credentialStore.test.ts` 等——以 `grep -l "openDb(':memory:')" tests/` 中**只 import 這 7 個 store**的檔為準）改用 `openTestDb()`

**Interfaces:**
- Consumes: Task 3 `Db`、`openTestDb`。
- Produces: 7 個 store 建構子改 `constructor(private db: Db, ...)`；**所有查詢方法回 `Promise<...>`**（方法名、參數、回傳內容不變，只是 async 化）。`WebSessionStore.onDelete` 回呼型別改 `(sessionId: string) => void | Promise<void>`，`delete()` 內 `await this.onDelete?.(...)`。

**轉換配方（每個 store 逐方法套用）：**

1. `import type Database from 'better-sqlite3'` → `import type { Db } from './dbTypes.js'`（路徑依檔案位置調整）。
2. `this.db.prepare(SQL).get(a, b)` → `(await this.db.query(SQL_PG, [a, b])).rows[0]`（undefined 判斷不變）。
3. `this.db.prepare(SQL).all(...)` → `(await this.db.query(SQL_PG, [...])).rows`。
4. `this.db.prepare(SQL).run(...)` → `await this.db.query(SQL_PG, [...])`；需要 `.changes` 時改用 `.rowCount`。
5. `?` placeholder → `$1..$n`（**依序編號**）；`@name` 具名參數 → `$n` + 陣列參數（照原欄位順序展開）。
6. SQLite 方言替換（spec §5）：
   - `credentialStore.insert`: `INSERT OR REPLACE INTO credentials (...)` → `INSERT INTO credentials (cred_hash,identity_id,kind,expires_at,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (cred_hash) DO UPDATE SET identity_id=EXCLUDED.identity_id, kind=EXCLUDED.kind, expires_at=EXCLUDED.expires_at, updated_at=EXCLUDED.updated_at`
   - `webSessionStore.create`: `INSERT OR REPLACE INTO web_sessions ...` → `INSERT INTO web_sessions (session_id,identity_id,created_at,last_seen_at) VALUES ($1,$2,$3,$4) ON CONFLICT (session_id) DO UPDATE SET identity_id=EXCLUDED.identity_id, created_at=EXCLUDED.created_at, last_seen_at=EXCLUDED.last_seen_at`
   - `readOidStore.record`: `INSERT OR IGNORE` → `INSERT INTO session_read_oids (session_id,oid,recorded_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`；`db.transaction(fn)(oids)` → `await this.db.transaction(async (tx) => { for (const oid of oids) await tx.query(INS, [sessionId, oid, this.now()]) })`
   - `identityStore.upsert`: 既有 `ON CONFLICT(identity_id) DO UPDATE SET user_label=@userLabel,...` → 改 `$1..$7` + `EXCLUDED.*` 寫法（PG 的 DO UPDATE SET 不能引用 insert 參數名）：`... ON CONFLICT (identity_id) DO UPDATE SET user_label=EXCLUDED.user_label, access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token, business_list_json=EXCLUDED.business_list_json, access_expires_at=EXCLUDED.access_expires_at, updated_at=EXCLUDED.updated_at`
   - `rateBudget.bump`: `ON CONFLICT(counter_key) DO UPDATE SET count = count + 1` → `ON CONFLICT (counter_key) DO UPDATE SET count = rate_counters.count + 1`（PG 需表名限定）；並用 `RETURNING count` 合併原本的第二查：

```ts
  private async bump(key: string): Promise<number> {
    const r = await this.db.query<{ count: number }>(`
      INSERT INTO rate_counters (counter_key, count, window_start) VALUES ($1, 1, $2)
      ON CONFLICT (counter_key) DO UPDATE SET count = rate_counters.count + 1
      RETURNING count`, [key, this.now()])
    return r.rows[0].count
  }
```

   - `oauthStore` consumed 欄（BOOLEAN）：寫入 `consumed: rec.consumed` 改傳 `rec.consumed === 1`；`consumeAuthCode`/`markRefreshConsumed` 的 `SET consumed = 1` → `SET consumed = TRUE`；讀取 `consumed: r.consumed as number` → `consumed: (r.consumed as boolean) ? 1 : 0`（TS 介面維持 number，呼叫端零改動）。
   - `identityStore.claimKeepalive`（CAS）：`.changes === 1` → `.rowCount === 1`，SQL 直翻：`UPDATE be2_identities SET keepalive_claimed_at=$1 WHERE identity_id=$2 AND (keepalive_claimed_at IS NULL OR keepalive_claimed_at < $3)`。
   - `auditLog.recent`: SQL 不變（`ORDER BY id DESC LIMIT $1`）。

- [ ] **Step 1: 逐 store 先改其單元測試檔為 async + openTestDb**（範例——其餘檔同 pattern）：

```ts
// tests/credentialStore.test.ts 的 setup 改法
import { openTestDb } from './support/testDb.js'
// before: const db = openDb(':memory:'); const store = new CredentialStore(db)
const db = await openTestDb()
const store = new CredentialStore(db)
// 每個呼叫點加 await：await store.insert(...) / await store.get(...)
```

- [ ] **Step 2: 跑該 store 測試確認失敗**（型別/行為不符）
- [ ] **Step 3: 依配方轉換該 store 實作**
- [ ] **Step 4: 跑該 store 測試至綠**（`npx vitest run tests/<store>.test.ts`）
**read-then-write 盤點（spec §3.3 驗收要求，記錄於此）**：
- `webSessionStore.get()` 的 idle 過期（read → delete）：race 輸家重複 delete 同 pk，冪等無害——**保留現狀**。
- `rateBudget.consume/consumeChangeset` 的 retention DELETE → bump：DELETE 冪等、bump 是原子 upsert——**保留現狀**。
- `changeSetStore.get()` 的過期標記：**已改寫**（Task 6，單條條件式 UPDATE）。
- 其餘 store 方法皆單語句，無 read-then-write。

- [ ] **Step 5: 7 個 store 全部完成後 commit**

```bash
npx vitest run tests/credentialStore.test.ts tests/identityStore.test.ts tests/readOidStore.test.ts tests/oauthStore.test.ts tests/rateBudget.test.ts tests/auditLog.test.ts tests/webSessionStore.test.ts
git add -A src/store src/oauth/oauthStore.ts src/limits/rateBudget.ts src/audit/auditLog.ts src/server/webSessionStore.ts tests
git commit -m "refactor: 7 個葉端 store 換 Db+async+PG 方言（upsert/ON CONFLICT/BOOLEAN/RETURNING）"
```

（**預期狀態註記**：本 task 結束時 `npm run typecheck` **尚未全綠**——上層 call site（app.ts、tokenManager、routes、changeset）還在同步呼叫。這是 Task 5-8 流水的既定過渡狀態，只驗「已轉換 store 的單元測試綠」。）

---

### Task 6: ChangeSetStore 轉換（CAS 核心 + lazy expiry 改寫）

**Files:**
- Modify: `src/core/changeset/store.ts`
- Test: `tests/changesetStore.test.ts`（若無獨立檔，以 `grep -l "ChangeSetStore" tests/` 找到的最小單元測試檔為準；仍無 → 新建 `tests/changesetStore.test.ts` 覆蓋 get/casStatus/updateDiff/claim 系列）

**Interfaces:**
- Consumes: Task 3 `Db`。
- Produces: `ChangeSetStore` 全方法 async；**方法名/參數/回傳語義不變**；`get()` 的過期標記改單條條件式 UPDATE（spec §3.3）。

**關鍵改寫（完整代碼）：**

```ts
  // lazy expiry：原 read-then-write（get 後判斷再 UPDATE）在 async 下有交錯窗口 →
  // 改單條條件式 UPDATE 先行，再 SELECT（spec §3.3）。UPDATE 冪等、輸掉 race 也無害。
  async get(id: string): Promise<ChangeSetRecord | undefined> {
    await this.db.query(
      `UPDATE change_sets SET status = 'expired' WHERE id = $1 AND status = 'pending_approval' AND created_at + $2 < $3`,
      [id, this.ttlMs, this.now()])
    const r = (await this.db.query(`SELECT * FROM change_sets WHERE id = $1`, [id])).rows[0]
    if (!r) return undefined
    // ……欄位映射與現行 rowToRecord 完全相同（status 直接取 r.status，不再本地覆寫）
  }
```

CAS 方法直翻（全部 `.changes === 1` → `.rowCount === 1`）：

```ts
  async casStatus(id: string, from: ChangeSetStatus, to: ChangeSetStatus, decidedAt?: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE change_sets SET status = $1, decided_at = COALESCE($2, decided_at) WHERE id = $3 AND status = $4`,
      [to, decidedAt ?? null, id, from])
    return r.rowCount === 1
  }
```

（`setStatus`/`updateDiff`/`setScheduled`/`claimScheduled`/`releaseClaim`/`listDueScheduled`/`listStrandedApproved`/`listScheduledIdentityIds`/`listScheduledIdsByIdentity`/`listExecutingScheduled` 同法逐條翻：`?`→`$n`、run→query、changes→rowCount。）

`recordResults`（INSERT OR REPLACE → ON CONFLICT + transaction）：

```ts
  async recordResults(id: string, results: ItemResult[]): Promise<void> {
    const SQL = `INSERT INTO change_set_results (changeset_id, item_key, status, before_json, after_json, error_code, error_message, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (changeset_id, item_key) DO UPDATE SET status=EXCLUDED.status, before_json=EXCLUDED.before_json,
      after_json=EXCLUDED.after_json, error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message, trace_id=EXCLUDED.trace_id`
    await this.db.transaction(async (tx) => {
      for (const r of results) {
        await tx.query(SQL, [id, r.item_key, r.status,
          r.before === undefined ? null : JSON.stringify(r.before),
          r.after === undefined ? null : JSON.stringify(r.after),
          r.error_code ?? null, r.error_message ?? null, r.trace_id])
      }
    })
  }
```

- [ ] **Step 1: 改/建單元測試（openTestDb + await；含「get() 過期後 status=expired 且 DB 已持久化」case）**
- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 轉換實作（上述代碼 + 其餘方法直翻）**
- [ ] **Step 4: 跑測試至綠** — `npx vitest run tests/changesetStore.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "refactor: ChangeSetStore 換 Db+async；lazy expiry 改單條條件式 UPDATE"`

---

### Task 7: 上層 call site 全面 await 化（app/routes/tokenManager/scheduler/executor/shutdown/index）

**Files:**
- Modify: `src/server/app.ts`（`ServerDeps.db: Db`、readyz、auth middleware、store 組裝）
- Modify: `src/server/shutdown.ts`（`db: { close: () => Promise<void> }` + `finally` 內 `await deps.db.close()`）
- Modify: `src/index.ts`（`openDb(...)` → `createPgDb(config.db)`；刪 Task 4 的暫時硬編）
- Modify: **所有 tsc 報錯的 call site**（預期範圍：`src/auth/tokenManager.ts`、`src/oauth/*Routes.ts`、`src/server/{confirmRoutes,ssoRoutes,devPanelRoutes}.ts`、`src/core/changeset/*`（confirmService/executor/scheduler/createChangesetCore）、`src/tools/*`——以 tsc 輸出為完整清單，逐一加 `await` 與 async 傳染）
- Delete: `src/store/db.ts`（舊 openDb + MIGRATIONS 常數整檔刪除）

**Interfaces:**
- Consumes: Task 4 `createPgDb`、Task 5/6 的 async stores。
- Produces: `buildApp({ config, db }: { config: Config; db: Db })`；全 src 無 better-sqlite3 import；runtime 零 DDL。

**執行法（機械、以編譯器驅動）：**

- [ ] **Step 1: 改 `ServerDeps`/`buildApp` 的 db 型別為 `Db`、readyz 改 `await db.query('SELECT 1')`（handler 加 async）、devPanelRoutes 兩處 db 直查改 await（SQL：`SELECT identity_id FROM be2_identities ORDER BY updated_at DESC LIMIT 1`、credentials upsert 改 `$1..$4` + `ON CONFLICT (cred_hash) DO UPDATE SET identity_id = EXCLUDED.identity_id, updated_at = EXCLUDED.updated_at`）**
- [ ] **Step 2: 改 shutdown.ts（介面 + `await deps.db.close()`；спec §3.2——finally 內 await，pool drain 完才 exit）**

```ts
// ShutdownDeps.db 型別改：
db: { close: () => Promise<void> }
// finally 區塊改：
} finally {
  try { await deps.db.close() } catch (e) { hadError = true; console.error('[be2-mcp] db.close error during shutdown:', (e as Error).message) }
  clearTimeout(timer)
  exit(hadError ? 1 : 0)
}
```

- [ ] **Step 3: 改 index.ts**

```ts
import { createPgDb } from './store/pgDb.js'
const db = createPgDb(config.db)
const app = buildApp({ config, db })
```

- [ ] **Step 4: `rm src/store/db.ts`，然後迴圈：`npm run typecheck` → 修下一批報錯（加 await/async）→ 直到 tsc clean**

規則：只加 `await` 與 async 傳染、不改邏輯。凡「if (store.x(...))」「return store.x(...)」「const v = store.x(...)」都要 await。**Promise.all 只用於原本就平行的呼叫，序列語義（如 executor 逐件）保持序列。**

- [ ] **Step 5: 全測試現況盤點（預期大量 FAIL——測試檔還在餵 sqlite）**

Run: `npx vitest run tests/pgliteSpike.test.ts tests/migrate.test.ts tests/dbInterface.test.ts tests/config.test.ts`（本 task 只保證這些綠 + tsc clean）

- [ ] **Step 6: Commit** — `git commit -m "refactor: 全 call site await 化；ServerDeps.db=Db；刪 openDb/runtime DDL；shutdown await close"`

---

### Task 8: 測試全面切換 `openTestDb()` + 移除 better-sqlite3 + 全綠 gate

**Files:**
- Modify: 全部仍用 `openDb(':memory:')` 的測試檔（`grep -rl "openDb" tests/` 為準，~52 檔）
- Modify: `package.json`（移除 `better-sqlite3`、`@types/better-sqlite3` 依賴）

**Interfaces:**
- Consumes: Task 3 `openTestDb`。
- Produces: `npm run ci` 全綠（470+ tests）；repo 零 better-sqlite3。

**機械配方（每檔）：**
1. `import { openDb } from '../src/store/db.js'` → `import { openTestDb } from './support/testDb.js'`
2. `const db = openDb(':memory:')` → `const db = await openTestDb()`（所在函式加 async；頂層則搬進 `beforeAll`/`beforeEach`）
3. 測試內直接 `db.prepare(...)` 斷言 DB 狀態者 → `await db.query(...)`（`$n` 參數）；`.changes` → `.rowCount`。
4. store 方法呼叫點加 `await`（tsc 不查測試檔的 floating promise——**逐檔跑過才算數**）。

- [ ] **Step 1: 逐檔轉換（每 5-10 檔跑一次 `npx vitest run tests/<改過的檔>`，立即修）**
- [ ] **Step 2: 移除依賴**

```bash
npm uninstall better-sqlite3 @types/better-sqlite3
grep -rn "better-sqlite3" src tests scripts package.json   # expected: 無任何輸出
```

- [ ] **Step 3: 全綠 gate**

Run: `npm run ci`
Expected: build + typecheck + 全測試 PASS（470+，conformance harness 原樣過）。

- [ ] **Step 4: runtime 零 DDL 驗收（spec §13.2）**

```bash
grep -rn "CREATE TABLE\|ALTER TABLE\|DROP TABLE" src/ | grep -v "migrate.ts"   # expected: 無輸出
```
（`src/store/migrate.ts` 只含 `schema_migrations` 的 CREATE TABLE IF NOT EXISTS——它只被 `db:migrate`/openTestDb 呼叫，不在 server runtime 路徑；此為允許的唯一例外，驗收記錄註明。）

- [ ] **Step 5: Commit** — `git commit -m "test: 全測試切 openTestDb（PGlite）；移除 better-sqlite3；ci 全綠"`

---

### Task 9: CLI scripts 改接 PgDb（oauth-purge / bootstrap-user / live-4a-acceptance）

**Files:**
- Modify: `scripts/oauth-purge.ts`（`runOAuthPurge` 改吃 `Db` + async；main 殼改 `createPgDb(resolveDbConnection(process.env))`）
- Modify: `scripts/bootstrap-user.ts`、`scripts/live-4a-acceptance.ts`（同法：刪 Task 4 暫時硬編、改 PgDb + await）
- Test: `tests/oauthPurge.test.ts`（既有測試改 openTestDb；含 ghost 清理不變式 case：「被 scheduled change-set 引用的 identity 不被刪」——功能測試，非 CAS 併發，spec §6 附註）

- [ ] **Step 1: 改 `runOAuthPurge(db: Db, nowMs: number): Promise<{...}>`——三條 DELETE 直翻 `$n`；回傳值 `changes` → `rowCount`**
- [ ] **Step 2: 跑 `npx vitest run tests/oauthPurge.test.ts` 至綠**
- [ ] **Step 3: 另兩支 script 改完後 `npm run typecheck` clean；main 殼手動冒煙不強制（需真 DB）**
- [ ] **Step 4: Commit** — `git commit -m "refactor: CLI scripts（oauth-purge/bootstrap-user/live-4a）改接 PgDb"`

---

### Task 10: cron HTTP endpoints（`/api/jobs/oauth-purge` + `/api/jobs/scheduler-tick`）+ SCHEDULER_MODE

**Files:**
- Create: `src/server/jobRoutes.ts`
- Modify: `src/server/app.ts`（掛 router、傳 deps）
- Modify: `src/index.ts`（`SCHEDULER_MODE=http` 時不 startScheduler）
- Test: `tests/jobRoutes.test.ts`

**Interfaces:**
- Consumes: `runOAuthPurge`（Task 9）、`app.locals` 既有 scheduler 的 `tick`（`src/core/schedule/scheduler.ts` 的 `makeScheduler(...)` 已回傳 `{ tick, start, auditStranded }`——buildApp 需把 tick 引用暴露給 jobRoutes deps）。
- Produces: `buildJobRoutes(deps: { cronSecret?: string; runPurge: () => Promise<Record<string, number>>; runTick: () => Promise<void> }): express.Router`

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/jobRoutes.test.ts（用既有 buildApp 測試 pattern + supertest/fetch 慣例，照 repo 現行 serverIntegration 測試的呼叫方式）
// case 1: 無 CRON_SECRET 設定 → POST /api/jobs/oauth-purge 回 503（fail-closed）
// case 2: 錯 bearer → 401；對 bearer 比對是常數時間（timingSafeEqual）
// case 3: 對 bearer → 200 + JSON 摘要 {expiredAuthCodes, expiredRefresh, ghostIdentities}
// case 4: POST /api/jobs/scheduler-tick 對 bearer → 200 {ok:true}；重複打不炸（冪等靠 CAS）
// case 5: SCHEDULER_MODE=http 時 index 不啟動 poller —— 以 buildApp 層驗證：app.locals.startScheduler 仍存在，
//         但 index.ts 的分支由 tests/schedulerMode.test.ts 直測 config（schedulerMode==='http'）+ 檢視 index 邏輯抽出的純函式
```

- [ ] **Step 2: 實作 `jobRoutes.ts`**

```ts
// src/server/jobRoutes.ts
import { Router } from 'express'
import { timingSafeEqual } from 'node:crypto'

export function buildJobRoutes(deps: {
  cronSecret?: string
  runPurge: () => Promise<Record<string, number>>
  runTick: () => Promise<void>
}): Router {
  const r = Router()
  const authed = (header: string | undefined): boolean => {
    if (!deps.cronSecret || !header?.startsWith('Bearer ')) return false
    const got = Buffer.from(header.slice(7)); const want = Buffer.from(deps.cronSecret)
    return got.length === want.length && timingSafeEqual(got, want)
  }
  r.post('/api/jobs/:name', async (req, res) => {
    if (!deps.cronSecret) { res.status(503).json({ error: 'CRON_SECRET not configured' }); return }
    if (!authed(req.headers.authorization)) { res.status(401).json({ error: 'unauthorized' }); return }
    try {
      if (req.params.name === 'oauth-purge') { res.json(await deps.runPurge()); return }
      if (req.params.name === 'scheduler-tick') { await deps.runTick(); res.json({ ok: true }); return }
      res.status(404).json({ error: 'unknown job' })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
  return r
}
```

- [ ] **Step 3: buildApp 掛載（在 auth middleware 之前、host guard 之後——它自帶 bearer 驗證）；index.ts 分支：**

```ts
// index.ts listen callback 內：
stopScheduler = config.schedulerMode === 'poller'
  ? (app.locals.startScheduler as (() => () => Promise<void>) | undefined)?.()
  : undefined
// http 模式：startScheduler 不呼叫；auditStranded 啟動警示仍要跑一次（scheduler.ts 的
// auditStranded 從 app.locals 暴露，http 模式下 index 直接呼叫它）。
```

- [ ] **Step 4: 跑測試至綠 + `npm run ci` 全綠**
- [ ] **Step 5: Commit** — `git commit -m "feat: cron HTTP endpoints（oauth-purge/scheduler-tick、CRON_SECRET、常數時間比對）+ SCHEDULER_MODE"`

---

### Task 11: 真 PG 併發測試 suite（`test:pg`）+ docker compose + CI 掛載驗證

**Files:**
- Create: `docker/pg-test.yml`
- Create: `tests-pg/casConcurrency.test.ts`
- Create: `vitest.pg.config.ts`
- Modify: `package.json`（`"test:pg": "vitest run --config vitest.pg.config.ts"`）
- Modify: `.woodpecker.yml`（若存在——掛 PG service；不存在則記錄於 plan 執行 notes 交使用者）

**Interfaces:**
- Consumes: Task 4 `createPgDb`、Task 2 `runMigrations`、Task 5/6 stores。
- Produces: 6 個 CAS 原語的雙連線併發測試；`TEST_PG_URL` 未設 → 文件化 SKIP。

- [ ] **Step 1: docker compose**

```yaml
# docker/pg-test.yml — 本地跑 test:pg 用：docker compose -f docker/pg-test.yml up -d
services:
  pg:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: test, POSTGRES_PASSWORD: test, POSTGRES_DB: be2mcp_test }
    ports: ["55432:5432"]
```

- [ ] **Step 2: 併發測試（核心 pattern——每原語一 case）**

```ts
// tests-pg/casConcurrency.test.ts
// 真 PG 雙連線併發：PGlite 是 single-connection，CAS 的多連線互斥必須在真 PostgreSQL 上證明（spec §6）。
// TEST_PG_URL 未設 → 整檔 SKIP（文件化，沿用 eval 先例）；CI 必須設（spec §13.3）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPgDb } from '../src/store/pgDb.js'
import { runMigrations } from '../src/store/migrate.js'
import { ChangeSetStore } from '../src/core/changeset/store.js'
import { IdentityStore } from '../src/store/identityStore.js'

const URL = process.env.TEST_PG_URL   // e.g. postgres://test:test@localhost:55432/be2mcp_test
const d = URL ? describe : describe.skip
if (!URL) console.log('[test:pg] SKIP — TEST_PG_URL not set (docker compose -f docker/pg-test.yml up -d)')

d('CAS 併發（真 PG、兩個獨立 pool）', () => {
  let a: ReturnType<typeof createPgDb>, b: ReturnType<typeof createPgDb>
  beforeAll(async () => {
    a = createPgDb({ connectionString: URL!, ssl: false })
    b = createPgDb({ connectionString: URL!, ssl: false })
    await a.query('DROP SCHEMA public CASCADE'); await a.query('CREATE SCHEMA public')
    await runMigrations({ query: async (s, p) => ({ rows: (await a.query(s, p)).rows }), exec: async (s) => { await a.query(s) } })
  })
  afterAll(async () => { await a.close(); await b.close() })

  it('casStatus：兩連線同搶 pending→approved，恰一個贏', async () => {
    const sa = new ChangeSetStore(a), sb = new ChangeSetStore(b)
    await sa.create(mkRec('cs-cas'))            // mkRec: 測試 fixture 工廠，見檔內定義（完整必填欄位）
    const [ra, rb] = await Promise.all([
      sa.casStatus('cs-cas', 'pending_approval', 'approved', 1),
      sb.casStatus('cs-cas', 'pending_approval', 'rejected', 1),
    ])
    expect([ra, rb].filter(Boolean).length).toBe(1)
  })
  // 同 pattern 各一 case：setScheduled、claimScheduled、releaseClaim、updateDiff、claimKeepalive(IdentityStore)
  // 每 case 都是 Promise.all 兩連線 → 斷言恰一 winner（或 releaseClaim/updateDiff 的對應不變式）
})
```

（檔內含 `mkRec(id)` fixture：填 `ChangeSetRecord` 全必填欄位——creatorLabel/creatorBearerHash/sessionId/actionType='shelf_toggle_product'/items=[]/diff=[]/diffVersion='v'/status='pending_approval'/createdAt=1。6 原語全覆蓋，不得只做 casStatus 一個。）

- [ ] **Step 3: vitest.pg.config.ts**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests-pg/**/*.test.ts'] } })
```

- [ ] **Step 4: 本地驗證**

```bash
docker compose -f docker/pg-test.yml up -d && sleep 3
TEST_PG_URL=postgres://test:test@localhost:55432/be2mcp_test npm run test:pg   # expected: 全 PASS
npm run test:pg   # 不設 URL → 全 SKIP、exit 0
docker compose -f docker/pg-test.yml down
```

- [ ] **Step 5: CI 掛載——檢查 repo 是否有 `.woodpecker.yml`；有則加 PG service + `TEST_PG_URL` step；無 CI 設定檔則在 commit message 與 PR 描述記「CI 掛載待 DevOps（spec §13.3 驗收：合併前至少一次實跑記錄——本地實跑輸出貼 PR）」。**
- [ ] **Step 6: Commit** — `git commit -m "test: 真 PG CAS 併發 suite（6 原語×雙連線）+ docker compose + test:pg script"`

---

### Task 12: DB observability（OTel query span + pool 指標）

**Files:**
- Modify: `src/store/pgDb.ts`（query 包 span）、`src/store/pgliteDb.ts`（同介面、span 可選）
- Test: `tests/dbObservability.test.ts`

**Interfaces:**
- Consumes: repo 既有 `src/otel.ts` 的 tracer 取得方式（實作前先讀該檔，照既有 span 建立 pattern——與 MCP/tool span 同一套，不另起爐灶）。
- Produces: 每個 `db.query` 產生 `db.query` span：attrs = `db.statement_summary`（SQL 首 keyword + 第一個表名，**絕不含參數值**）、`db.row_count`；pg.Pool 每 60s 輸出 `{total, idle, waiting}` 到 stdout log（`OTEL_MODE=off` 時 span 零開銷、pool log 仍保留）。

- [ ] **Step 1: 寫測試（span 產生 + statement summary 不含參數值；用 otel.ts 既有測試 pattern 的 in-memory exporter；若 repo 無此 pattern → 以 console mode 斷言 log 行）**
- [ ] **Step 2: 實作（wrap 函式加 span；`setInterval(...).unref()` 輸出 pool 統計，shutdown 時 clearInterval——掛在 close()）**
- [ ] **Step 3: `npm run ci` 全綠 + commit** — `git commit -m "feat: db.query OTel span + pool 指標 log"`

---

### Task 13: env/docs 收尾 + 最終驗收

**Files:**
- Modify: `.env.example`（DB_*/DATABASE_URL/CRON_SECRET/SCHEDULER_MODE 三分類註明；移除 APP_DB_PATH）
- Modify: `CLAUDE.md`（開發指令加 `db:migrate`/`test:pg`；SQLite 敘述改 PG；`bootstrap-user`/`oauth-purge` 描述更新）
- Modify: `docs/be2-mcp/deploy-architecture.md`（§1.5 DB 需求改 PG+兩 role、§6 表更新、§7 env 表、§9 申請清單加兩組 DB 帳號 + CronJob×2、§8 補「切換日 SQLite 檔歸檔程序」：壓縮 + sha256 + 存放位置與保留期限，spec §9）
- Modify: `docs/be2-mcp/stage-eks-migration-devops.md`（§8 差距表 #4-#8 標關閉）
- Modify: `docs/be2-mcp/pg-migration-handoff.md`（頂部加「已由 spec/plan 接手實作完成」標記）
- Modify: `docs/superpowers/specs/CHANGELOG.md`（若 spec 有任何實作期修訂）

- [ ] **Step 1: .env.example（三分類照 cloud spec §2.2：runtime secret = DB_PASSWORD/CRON_SECRET/API_AUTH_SERVICE_KEY；runtime 非機密 = 其餘）**
- [ ] **Step 2: 文件逐檔更新**
- [ ] **Step 3: 最終驗收清單（spec §13 逐項，輸出核對記錄到 commit message）**

```bash
npm run ci                                              # 1. 全綠
grep -rn "better-sqlite3" src tests scripts package.json  # 2. 無輸出
grep -rn "CREATE TABLE\|ALTER TABLE\|DROP TABLE" src/ | grep -v migrate.ts   # 2. 無輸出
docker compose -f docker/pg-test.yml up -d && sleep 3
DATABASE_URL=postgres://test:test@localhost:55432/be2mcp_test npm run db:migrate   # 4. applied 2 files
DATABASE_URL=postgres://test:test@localhost:55432/be2mcp_test npm run db:migrate   # 4. up to date（重跑安全）
TEST_PG_URL=postgres://test:test@localhost:55432/be2mcp_test npm run test:pg       # 3. CAS 併發全 PASS
docker compose -f docker/pg-test.yml down
```

（驗收 5 per-env 隔離：Task 3 dbInterface 測試的「openTestDb 每次獨立」case + config 測試 DB_NAME 注入已覆蓋語義；驗收 6 audit append-only：Task 1 spike trigger case + baseline 內 REVOKE。）

- [ ] **Step 4: Commit** — `git commit -m "docs: PG 遷移收尾——env 三分類、部署文件、差距表 #4-#8 關閉、最終驗收記錄"`

---

## 執行注意（給編排者）

- **分工鐵則**（memory `agy-work-allocation`）：實作外包 agy（accept-edits），Claude 編排/review/驗證/commit。
- Task 5-8 是連續流水（中間 tsc 不全綠是預期狀態，見各 task 註記）；**不可在 Task 8 之前宣稱任何「完成」**。
- Task 1 spike 任一 FAIL = 停下回報（testcontainers 退路決策屬使用者）。
- 執行完成後走 `superpowers:verification-before-completion` → `code-review`（雙軸）→ `verify`。
