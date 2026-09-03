# SQLite→PostgreSQL 遷移設計（cloud-ready 第一階段核心）

> 日期：2026-09-03。狀態：DRAFT（待 agy-peer-review）。
> 來源：`docs/be2-mcp/pg-migration-handoff.md` 的 6 個必答決策，經 brainstorm + Codex 獨立 review
> （task-mtlalxq5-jmd1yp，逐項 verdict 已採納）定案。
> 分支：`feat/pg-migration`（自 main `8441188` 切出）。

## 1. 目標與非目標

**目標**：store 從 better-sqlite3 單檔換成外部 PostgreSQL，關閉 cloud-ready 12 條硬約束
（`docs/be2-mcp/vibe-cloud-ready-spec.md`）中的：

- **#4** 不寫本機磁碟（除 /tmp）——刪除 `./data/*.sqlite`
- **#5** 禁 SQLite / 檔案型 DB
- **#6** DB = 外部 PostgreSQL、連線資訊來自 env、TLS
- **#7** runtime 不做 DDL；schema 變更 = repo 內 forward-only SQL migration
- **#8** 排程 = HTTP endpoint（本 spec §8：`oauth-purge` + `scheduler-tick` 兩支 job endpoint）

**非目標**（明確不做）：

- Redis / 分散式鎖：HA（多副本）階段才做。三個 in-process 原語（tokenManager single-flight、
  inventory per-key mutex、approval nonce）**本案不動**——單副本階段行為正確。
- module 介面：store 是 core 底層，`src/modules/**` 與 `ActionModule` 介面零改動
  （conformance harness 必須原樣通過）。
- MCP 工具對外行為：工具 schema、參數、回傳、錯誤格式全部不變。
- 既有 SQLite 資料的 row-level 搬遷（見 §9：fresh start + 歸檔）。

## 2. 決策總表

| # | 決策 | 定案 | Codex verdict |
|---|---|---|---|
| D1 | async 漣漪 | 一刀切全面 async | Agree |
| D2 | 測試 backend | PG-only；PGlite 跑方言/功能測試 + 真 PG 跑 CAS 併發測試 | Agree w/ reservations（已採納補強） |
| D3 | migration 工具 | 手寫 SQL + 自製 runner（不用 node-pg-migrate/drizzle） | Agree w/ reservations（已採納：11 張表、role 分離） |
| D4 | SQL 方言 | 對照表見 §5；TEXT 不用 JSONB；int8 parser 設定 | Agree w/ reservations（已修正理由 + 補 parser） |
| D5 | 交易與連線池 | pool≤5、顯式交易 helper、timeout/retry 政策 | Agree w/ reservations（已補 timeout/retry/close） |
| D6 | scope：cron endpoints | `oauth-purge` **與** `scheduler-tick` 皆併入本案 | Disagree 原案 →（已採納 Codex 建議） |
| D7 | per-env 隔離 + 資料 | 每環境一個 database；fresh start；audit 舊檔歸檔 | Agree w/ reservations（已補歸檔條款） |
| D8 | 補遺（Codex 提出） | role 分離、type parsing、RDS 瞬斷政策、DB observability、test isolation、secrets 分類 | —（新增） |

## 3. 架構：`Db` 介面與兩個 transport

### 3.1 介面（`src/store/db.ts` 重寫）

```ts
export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>
  // fn 內以同一連線執行；丟出即 ROLLBACK，正常返回即 COMMIT
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}
```

- **一套 SQL、PG 方言**。`Db` 只是 transport 抽象（pg.Pool vs PGlite），不是雙 backend——
  兩個實作跑同一份 SQL 字串。參數 placeholder 統一 `$1..$n`。
- 生產實作 `PgDb`：包 `pg.Pool`；`transaction` = `pool.connect()` → `BEGIN/COMMIT/ROLLBACK` → release。
- 測試實作 `PgliteDb`：包 `@electric-sql/pglite`（WASM 真 Postgres、免 docker）；
  `transaction` 走 PGlite 原生 `.transaction()`。
- **better-sqlite3 依賴完全移除**（package.json、11 個 import 檔全清）。

### 3.2 全面 async（D1）

- 10 個 store/service 類別（`credentialStore`、`identityStore`、`readOidStore`、`oauthStore`、
  `rateBudget`、`core/changeset/store`、`auditLog`、`webSessionStore`、`devPanelRoutes` 內 upsert、
  `app.ts` 組裝）方法全改 `async`；call site 一次 await 化。
- 不做「同步實作包 Promise」過渡——避免雙態期掩蓋交錯問題。
- 漏 await 的防護：`tsc --noEmit`（Promise 型別不符）+ 既有 470 tests。repo 無 ESLint，
  不為本案引入；review 時專掃「呼叫 store 方法但未 await」pattern。
- `src/server/shutdown.ts` 的 `db.close(): void` 假設一併 async 化（Codex D5 指出）。

### 3.3 async 化的唯一語義差異（同步性原子帶）

better-sqlite3 同步呼叫期間不可能插入其他請求；async 後每個 await 點都可交錯。因應：

- 所有跨請求正確性**只依賴 SQL 層原子性**（單條條件式 UPDATE / ON CONFLICT），不依賴 JS 執行順序。
- `ChangeSetStore.get()` 的 lazy 過期標記由 read-then-write 改為單條：
  `UPDATE change_sets SET status='expired' WHERE id=$1 AND status='pending_approval' AND created_at + $ttl < $now`，
  再 SELECT（消滅本來就存在的理論競態）。
- spec 驗收（§13）要求逐一盤點 read-then-write 點並記錄「為何安全或已改寫」。

## 4. Schema baseline

- `db/migrations/0001_baseline.sql` = 現行 **11 張表**的 PG 定稿：`audit_log`、`rate_counters`、
  `session_read_oids`、`change_sets`、`change_set_results`、`web_sessions`、`be2_identities`、
  `credentials`、`oauth_clients`、`oauth_auth_codes`、`oauth_refresh`。
- 歷次 runtime ad-hoc migration（`approval_token_hash` DROP、`access_cred_hash`/排程欄/
  `keepalive_claimed_at` ADD、web_sessions 重建）的**最終形狀**直接收進 baseline，一次收乾淨。
- legacy `user_tokens`（Phase A 已 DROP）**不入 baseline**，在檔頭註解記為 dropped legacy。
- `openDb()` 的 runtime DDL（`CREATE TABLE`/`ALTER`/`DROP`/PRAGMA 檢查）**全部刪除**；
  runtime 路徑零 DDL（驗收：grep + app role 無 DDL 權限雙保險）。

## 5. SQL 方言對照（D4）

| 現行 SQLite | PG 譯法 | 位置 |
|---|---|---|
| `INSERT OR REPLACE` | `INSERT ... ON CONFLICT (pk) DO UPDATE SET ...` | `change_set_results`、`credentials`、`web_sessions` |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` | `session_read_oids` |
| 既有 `ON CONFLICT ... DO UPDATE` ×3 | 原生相容，照搬 | `rate_counters`、`be2_identities`、`devPanelRoutes` |
| audit trigger `RAISE(ABORT)` | PG trigger function `RAISE EXCEPTION` + 對 app role `REVOKE UPDATE, DELETE ON audit_log`（雙保險） | `audit_log` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT GENERATED ALWAYS AS IDENTITY` | `audit_log.id` |
| INTEGER ms timestamp | `BIGINT`（**不轉 timestamptz**——全碼庫比較皆 numeric ms：TTL、due schedule、OAuth exp、rate window；轉型別是無收益的行為變更。psql 除錯輔以 `to_timestamp(col/1000.0)` 或 debug view） | 全部 `*_at`/`ts`/`exp` 欄 |
| `consumed INTEGER 0/1` | `BOOLEAN`（store 層讀寫轉換，測試驗等價） | `oauth_auth_codes`、`oauth_refresh` |
| `*_json TEXT` | 維持 `TEXT`。理由：round-trip 保真、現行 `JSON.parse` 路徑零改動、無 SQL 內查 JSON 的需求。（註：diff hash 是 module 端 canonical string，不 hash DB text，故 JSONB 不會破 hash——但也沒有採用 JSONB 的收益） | 各 `*_json` 欄 |

**int8 parser（D8）**：node-postgres 預設把 `BIGINT`/`COUNT(*)` 回成 string。`PgDb` 建構時設
`pg.types.setTypeParser(20, Number)`（int8→Number）。安全性：所有值為 ms timestamp（~2^41）
與 count，遠低於 2^53。PGlite 同步設定，兩 transport 行為一致（等價測試覆蓋）。

## 6. CAS 語義等價（驗收硬項）

7 個 CAS 原語全是「單條條件式 UPDATE + affected-rows===1 判贏」，PG 直翻（`rowCount === 1`）：

| 原語 | 保護的不變式 |
|---|---|
| `casStatus` | change-set 批准/拒絕 execute-exactly-once（防雙擊/重試） |
| `setScheduled` | pending→scheduled 單次轉換 |
| `claimScheduled` | 排程到點認領 at-most-once |
| `releaseClaim` | stranded 回收不覆寫已推進狀態 |
| `updateDiff` | 只在 pending_approval 期間回寫 live diff |
| `claimKeepalive`（identityStore） | keep-alive 認領防重複 refresh |
| `runOAuthPurge` 的 ghost 清理 | 不刪被 scheduled change-set 引用的 identity |

**測試策略（兩層，D2 定案）**：

1. **PGlite 層**（`npm run test`，CI 必跑）：語法/語義正確性——每個原語「條件符合→rowCount 1、
   條件不符→rowCount 0、連呼兩次只有第一次贏」。PGlite 是真 Postgres，方言層完全保真。
2. **真 PG 併發層**（`npm run test:pg`，需 `TEST_PG_URL`）：PGlite 是 single-connection
   （官方文件；multi-connection multiplexer 不保證所有情境），**不足以證明多連線併發正確性**。
   故 7 個原語各寫一個「兩個真連線同時搶、恰一個贏」的測試，打真 PostgreSQL
   （本地 `docker compose -f docker/pg-test.yml up`；CI 掛 PG service container）。
   `TEST_PG_URL` 未設 → 文件化 SKIP（沿用 eval 先例，不算失敗）；**驗收要求 CI 必須實跑**
   （Woodpecker PG service 可用性在 plan 階段第一個 task 驗證，不可用則 CI 起 docker PG 為退路）。

## 7. 交易、連線池、瞬斷政策（D5 + D8）

- **交易**：現行僅 2 處（`recordResults`、`ReadOidStore.record` 批次），改用 `Db.transaction()`。
  其餘 store 方法皆單語句 → autocommit。不引入新的長交易。
- **連線池**：`pg.Pool` `max=5`（單 pod 個位數，pods×5 遠低於 RDS max_connections）、
  `connectionTimeoutMillis=5000`、`idleTimeoutMillis=30000`、`statement_timeout=15000`（session 級）。
- **TLS**：`ssl: { rejectUnauthorized: false }`（= `sslmode=no-verify`，cloud spec §2.5 指定，
  `require` 在部分 driver 會被當 verify-full 而失敗）。
- **env**：`DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` 分開注入；
  `DATABASE_URL` 存在時短路（本機便利）。缺必要 DB env → 啟動 fail fast（沿用 config.ts 慣例，
  只印變數名不印值）。
- **RDS 瞬斷政策**：不做 query 級自動重試（多數寫入非冪等，重試會雙寫）。策略 =
  fail fast + 上層語義兜底：MCP tool call 失敗回錯誤由使用者/agent 重試；scheduler tick 失敗
  下一 tick 自然重跑（CAS 保 at-most-once）；pool 內連線壞死由 pg.Pool 自身汰換。
  `/healthz` 維持**不查 DB**（約束 #11）；既有 `/readyz`（現行 `SELECT 1` 查 DB，`app.ts:246`）
  語義沿用、改 async `db.query`——它不接 liveness probe，DB 抖動只影響 readiness。
- **advisory lock**：只用在 migration runner（防兩個 CI/Job 並行套 migration），runtime 零使用。

## 8. Migration runner 與 DB role model（D3 + D8）

### 8.1 Runner（自製，~100 行，不用 node-pg-migrate/drizzle）

cloud spec §2.5 已把需求寫死，自製 runner 逐條滿足：

- 目錄 `db/migrations/NNNN_<描述>.sql`，四位數零補、字典序執行、forward-only、
  已套用檔案永不改名/改內容。
- runner（`scripts/db-migrate.ts`，`npm run db:migrate`）：從 env 讀連線 → `pg_advisory_lock` →
  `CREATE TABLE IF NOT EXISTS schema_migrations(filename TEXT PRIMARY KEY, applied_at BIGINT)` →
  逐檔（未記錄者）在單一 transaction 內執行 + 記錄 → unlock。重複執行安全。
- 不支援 `CREATE INDEX CONCURRENTLY` 等 no-transaction 語句（內部系統資料量秒級，普通
  `CREATE INDEX` 即可；cloud spec 同見解）。
- 部署序：CI/k8s Job 跑 `db:migrate` 成功後才 rollout 新 image（migration 失敗擋部署）。

### 8.2 Role 分離（Codex 指出的 gap）

| Role | 權限 | 使用者 |
|---|---|---|
| `be2mcp_owner`（migration role） | schema owner；執行 DDL | `db:migrate`（CI/k8s Job） |
| `be2mcp_app`（runtime role） | 表級 CRUD；**audit_log 只有 INSERT/SELECT**（REVOKE UPDATE/DELETE）；零 DDL | app runtime |

- baseline migration 內含 `GRANT` 語句（owner 建表後 GRANT CRUD 給 app role）。
- REVOKE 與 runner 不衝突：REVOKE 只對 app role，owner 的 ALTER 權限是 owner inherent。
- 本地 dev / PGlite 測試不分 role（單 superuser），role 分離只在共用 PG 環境生效；
  app role 無 DDL 這件事由 **「runtime 碼零 DDL」的 grep 驗收**在測試層兜住。
- RDS 帳號開通時要向 DevOps 申請兩組帳密（部署文件註明；`deploy-architecture.md` §9 申請清單更新）。

## 9. per-env 隔離與資料遷移（D7）

- **隔離**：從「檔名後綴」改為「**每環境一個 database**」——config-manager per-env 注入不同
  `DB_NAME`（如 `be2mcp_sit` / `be2mcp_stage` / `be2mcp_prod`）或不同 RDS instance。
  `APP_ENV` 維持純標籤。SIT/stage/prod token store 不互汙的語義保留。
- **資料**：**fresh start，不做 row migration**。token/session/credential 全是短命可重登資料；
  change-set 歷史無執行中依賴（切換窗口清空 pending/scheduled，公告週知）。
- **audit_log 歸檔（合規）**：切換當日將各環境 `./data/*.sqlite` 檔案本體歸檔
  （壓縮 + sha256 記錄，存放位置與保留期限沿用現行 audit 備份規範，`deploy-architecture.md` §8），
  查詢方式 = 任何 SQLite client 開檔即查。PG 側 audit_log 從零開始，append-only 保證不退化
  （trigger + REVOKE 雙保險，見 §5）。

## 10. 排程與 cron endpoints（D6，採 Codex 建議）

兩支 job endpoint 皆併入本案，關閉約束 #8：

1. **`POST /api/jobs/oauth-purge`**：包現有 `runOAuthPurge()`（純函式已存在）。
   驗 `Authorization: Bearer $CRON_SECRET`（常數時間比對）、idempotent（純刪過期資料，天然冪等）、
   回 JSON 摘要 `{expiredAuthCodes, expiredRefresh, ghostIdentities}` 並寫 audit。
   CLI `npm run oauth-purge` 保留（改走同一函式）。
2. **`POST /api/jobs/scheduler-tick`**：包現有 `scheduler.tick()`（已是 bounded、逐件 CAS 認領、
   idempotent——重複觸發安全，claim 保 at-most-once）。同 `CRON_SECRET` 驗證。
   回 JSON 摘要（本輪處理件數）。
3. **poller 模式切換**：新 env `SCHEDULER_MODE=poller|http`（預設 `poller`，本地 dev 零設定不變）；
   `http` 模式下 `index.ts` 不呼叫 `startScheduler()`，到點執行完全由外部 cron
   （k8s CronJob / dkron）打 endpoint 驅動。`auditStranded()` 啟動警示兩模式都保留。
   部署文件註明：prod/EKS 一律 `http` 模式 + CronJob 頻率（建議每分鐘）。
- `CRON_SECRET` 新增為 runtime secret（APP SECRET 類）。

## 11. Config 與 secrets（D8）

`src/config.ts` 變更：

- 移除 `APP_DB_PATH`/`dbPath`；新增 `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`（或
  `DATABASE_URL` 短路）、`CRON_SECRET`、`SCHEDULER_MODE`。
- `.env.example` 更新並照 cloud spec 三分類逐個註明（build-time / runtime secret / runtime 非機密）：
  `DB_PASSWORD`、`CRON_SECRET`、`API_AUTH_SERVICE_KEY` 標 **APP SECRET**；其餘標非機密。
- 鐵則不變：任何輸出/LOG/錯誤訊息不得出現 secret 值（config.ts 既有慣例沿用）。

## 12. Observability 與測試結構（D8）

- **DB observability**：`Db.query` 包一層 OTel span（`db.query`，attrs：statement 摘要
  （首 keyword + 表名，**不含參數值**）、duration、rowCount）；pg.Pool 的
  `totalCount/idleCount/waitingCount` 在既有 metrics/log 通道定期輸出（沿用 OTEL_MODE 開關，
  `off` 時零開銷）。
- **Test isolation**：現行 `:memory:` 每檔天然隔離；PGlite 化後 `openTestDb()` 保證等價隔離——
  **每測試檔一個獨立 in-memory PGlite instance**（vitest 預設 per-file worker process，天然對齊），
  helper 內跑 `db/migrations/*.sql`（migration 本身因此在每次測試被反覆驗證）。
  若整體測速退化明顯，plan 階段可用 PGlite `dumpDataDir/loadDataDir` snapshot 加速，非本 spec 承諾。
- **`npm run ci`** 維持 `build + typecheck + test`；`test:pg`（§6）在 CI 以 PG service 跑。

## 13. 驗收基準

1. `npm run ci` 全綠（470+ tests、conformance harness 原樣通過）；`tsc` clean。
2. 約束 **#4/#5/#6/#7/#8 關閉**：無 better-sqlite3 依賴、無本機 DB 檔、PG+TLS、
   runtime 路徑零 DDL（grep `CREATE TABLE|ALTER TABLE|DROP TABLE` 只出現在 `db/migrations/` 與
   runner）、兩支 job endpoint 可 `curl -H "Authorization: Bearer $CRON_SECRET"` 觸發且重複安全。
3. **CAS 等價**：§6 兩層測試全過；真 PG 併發層在 CI 實跑（7 原語 × 併發搶測試）。
4. **migration 可重跑**：空 PG 跑 `db:migrate` 建出完整 schema；再跑一次不失敗（CI 驗證）。
5. **per-env 隔離**：不同 `DB_NAME` 互不可見（測試以兩個 PGlite/兩個 database 驗語義）。
6. **audit append-only 不退化**：PG trigger 擋 UPDATE/DELETE 的測試 + REVOKE 語句在 baseline 內。
7. `.env.example` 三分類完整；缺 DB env 啟動 fail fast 且不印值。

## 14. 風險與退路

| 風險 | 緩解/退路 |
|---|---|
| PGlite 相容性坑（trigger、IDENTITY、行為差異） | plan 第一個 task = PGlite spike（trigger/ON CONFLICT/IDENTITY/transaction/int8 逐項驗）；不可行 → 全面退 testcontainers（測試變慢但保真） |
| Woodpecker CI 無 PG service | plan 早期 task 驗證；退路 = CI job 內 docker 起 PG、或 test:pg 降級為 nightly/手動 gate（驗收 3 改為「合併前至少一次實跑記錄」） |
| 470 tests 大面積 await 化改壞語義 | 機械化改動 + 每類 store 改完即跑該檔測試；conformance harness 兜 module 層 |
| int8→Number 精度 | 全碼庫值域 ms timestamp/count << 2^53；parser 測試含極值 case |
| fresh start 遺失 pending change-set | 切換窗口公告 + 切換前 `listDueScheduled`/pending 清單人工確認為空 |

## 15. 對既有文件的連動更新（實作時一併）

- `CLAUDE.md`：開發指令補 `db:migrate`/`test:pg`；SQLite 敘述改 PG。
- `docs/be2-mcp/deploy-architecture.md` §1.5/§6/§7/§9：DB 需求改 PG（兩 role 帳號）、
  cron 需求補 scheduler-tick、env 表更新。
- `docs/be2-mcp/stage-eks-migration-devops.md` §8 差距表：#4-#8 標關閉。
- `docs/be2-mcp/pg-migration-handoff.md`：標記已由本 spec 接手。
