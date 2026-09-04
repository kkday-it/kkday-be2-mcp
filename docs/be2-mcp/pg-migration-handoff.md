# Handoff：SQLite→PostgreSQL 遷移（cloud-ready 第一階段核心）— 2026-09-03

> ✅ 已由 spec+plan+feat/pg-migration 分支實作完成（2026-09-03）——本檔僅存檔。

> 給新 session 的交接。流程照 CLAUDE.md 主管線：`superpowers:brainstorming` →
> spec 寫進 `docs/superpowers/specs/`（過 agy-peer-review 到 APPROVED）→ `writing-plans`（再過 agy）→
> `subagent-driven-development` + TDD。實作分工照 memory `agy-work-allocation`（實作外包 agy，Claude 編排/review/commit）。

## 為什麼做（一句話）

be2-mcp 要上 EKS（服務申請單已於 2026-09-03 提交 cloud team／Paul），cloud-ready 12 條硬約束**禁 SQLite/檔案型 DB、DB=外部 PostgreSQL+TLS、runtime 不做 DDL**；PG store 一動同時解掉多條約束，是第一階段（單副本）唯一的大工程。

## 起點狀態

- branch `main`（HEAD `8441188`），`npm run ci` 綠（Phase 5 時 470 passed / 0 skipped）。
- 現況 store = better-sqlite3 單檔（`APP_DB_PATH`，per-env 後綴 `-{sit|stage|prod}.sqlite`）。
- **12 張 `CREATE TABLE` 全在 `src/store/db.ts`，runtime 啟動時執行**（違反「runtime 不做 DDL」，migration 流程是本案一部分）。
- **11 個檔案直接 import better-sqlite3**：`src/store/{db,credentialStore,identityStore,readOidStore}.ts`、`src/oauth/oauthStore.ts`、`src/limits/rateBudget.ts`、`src/core/changeset/store.ts`、`src/audit/auditLog.ts`、`src/server/{app,webSessionStore,devPanelRoutes}.ts`。

## Brainstorm 必須面對的關鍵決策（先想清楚再寫 spec）

1. **同步→非同步的漣漪**：better-sqlite3 是同步 API，pg 是 async。全部 call site 改 async 是本案最大隱藏成本——評估「全面 async 化」vs「store 介面先 async、SQLite adapter 用同步實作包 Promise」的過渡路徑。
2. **雙 backend 還是一刀切**：本地開發/測試是否保留 SQLite adapter（快、零依賴），或測試也跑 PG（testcontainers / docker）？CI 環境有無 PG 可用？
3. **migration 工具選型**：node-pg-migrate / drizzle / 手寫 SQL 檔＋簡單 runner。約束：runtime 不做 DDL、migration 是獨立步驟（`npm run migrate`，部署 pipeline 或 k8s Job 跑）。
4. **SQL 方言差異盤點**：`INSERT OR REPLACE`、`ON CONFLICT`、CAS 條件式 UPDATE（change-set 防重複執行、scheduler 認領——多實例正確性靠它們，不能改壞）、`datetime()`、boolean/integer。
5. **交易與鎖**：SQLite 單寫者掩蓋的併發問題在 PG 會露出來；單副本階段 in-process 鎖仍在（Redis 是 HA 階段），但 PG 連線池（小池）+ 交易邊界要明確。
6. **scope 邊界**：oauth-purge HTTP endpoint（dkron 要打，現在只有 CLI `scripts/oauth-purge.ts`）與 scheduler poller HTTP tick（約束 #8，可能跟 Paul 談單副本豁免）——併入本 spec 還是另開小案？建議 brainstorm 時定案。

## 先讀（依序）

1. `docs/be2-mcp/vibe-cloud-ready-spec.md` — 12 條硬約束（本案的驗收基準）
2. `docs/be2-mcp/stage-eks-migration-devops.md` §8 — 現況差距與「store 一動解多條」的槓桿分析
3. `docs/be2-mcp/deploy-architecture.md` §1.5/§6/§7 — 11 張表用途分群、per-env store 隔離、env/機密規範
4. `src/store/db.ts` — 現行 schema 與 DDL 位置
5. `docs/be2-mcp/module-catalog.md` — core/module 邊界（store 是 core 底層，**嚴禁動 module 介面**）

## 驗收基準（spec 要寫進去）

- `npm run ci` 全綠（470+ tests，conformance harness 不能壞）；typecheck clean。
- 12 條約束中 #4/#5/#6/#7 由本案關閉；DDL 全部移出 runtime。
- per-env store 隔離語義保留（SIT/stage/prod token store 不互汙）。
- CAS 語義（change-set status 條件式 UPDATE、scheduler claim）在 PG 上有測試證明等價。
- audit_log append-only 與備份需求不退化。

## 環境備註

- SIT 錨定 be2-220（`.env` 已有 SIT service key）；stage service key 已在服務申請單申請中。
- Redis 不在本案：HA（多副本）階段才申請（服務申請單已註明）。
