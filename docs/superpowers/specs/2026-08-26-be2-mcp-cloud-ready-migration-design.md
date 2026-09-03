# be2 MCP — Cloud-Ready（EKS）遷移設計 spec

> 目標：把 be2-mcp 從「本機優先」設計對齊 `docs/be2-mcp/vibe-cloud-ready-spec.md` 的 12 條 EKS 硬約束，
> 使其可容器化、無狀態、多副本部署於公司內部 AWS EKS。**本 spec 只定設計方向與分階段策略；實際重構走
> writing-plans → subagent-driven，分批落地。** 差距分析見 `docs/be2-mcp/stage-eks-migration-devops.md` §8。
>
> 前置事實（2026-08-26 subagent 查證）：kkday-vibe-framework 的 `platform_sdk/ts` **不提供 `ctx.db` adapter**
> （只有 secrets/logger/notify/storage/browser），framework roadmap R3/R4（DB/job）尚未實作 → **be2-mcp 的
> store→PostgreSQL 必須自建抽象，不能等 ctx.* SDK**。

## 1. 範圍與非目標

**範圍**：讓 be2-mcp 符合 cloud-ready 12 約束中目前違反的項（#1/#3/#4/#5/#6/#7/#8）+ 補齊 #10 結構化 log、
#12 adapter 化、容器化（prod build/Dockerfile）、`PROJECT.yaml` + registry 登記。

**非目標（本波不做，另立）**：
- 貢獻回 kkday-vibe-framework（R8 change-set/紅區 approval、MCP server 型態）——需先與 framework owner 談，見
  `vibe-framework-contribution-proposal.md` §4「外部-需先問」。
- 業務功能（工作台、價格域 3b 等）——與本遷移正交。
- DCR + CIMD 雙模（TODO A5）——獨立 OAuth 外殼工作，與本遷移可並行但不綁。

## 2. 治理不變式（遷移中一律維持）

Core 治理（Authn/Authz 委派 `/verify`、businessList fail-fast、change-set 狀態機、draft-only、scope-gate、
nonce 批准、稽核 append-only）**行為不得改變**。遷移只換「狀態存哪、鎖在哪、排程怎麼觸發、綁哪個介面」，
不動治理語義。所有既有測試（CI 660）須保持綠；store 換底層後行為等價由既有測試 + conformance 保證。

## 3. 逐約束設計決策

### 3.1 狀態儲存：SQLite → PostgreSQL（約束 #4/#5/#6/#7）——核心

現況：`src/store/*`（identity/credential/readOid/changeSet）全 `better-sqlite3`；`openDb()` 啟動跑 `CREATE TABLE`（runtime DDL）。

**決策：Store 介面抽象 + 雙後端。**
- 定義 `Store` 介面（每個 sub-store 一組同步/非同步方法），現有 SQLite 實作收斂到介面後面。
- 新增 **PostgreSQL 實作**（`pg` driver，連線參數 `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`，允許 `DATABASE_URL` 短路；TLS `sslmode=no-verify`；**小連線池**，`pod 數 × pool` 遠低於 RDS max_connections）。
- **後端由 env 選**：`DB_DRIVER=sqlite|postgres`（或有 `DB_HOST` 即 postgres）。**本機/CI 續用 SQLite**（快、零依賴）；stage/prod 用 PostgreSQL。
- App DB 帳號**只 CRUD**；**runtime 不做 DDL**——schema 改成 **repo 內 forward-only SQL migration**（`migrations/NNNN_*.sql`），`openDb` 不再 `CREATE TABLE`。
- **migration runner 對兩後端都要有**（否則移除 runtime DDL 後本機/CI 對空 DB 開機即掛）：提供 `migrate` script 依序套用 `migrations/*.sql`；**本機/CI**：測試/啟動前跑一次 `migrate`（對 SQLite 檔）；**stage/prod**：由 DevOps 部署流程對 PostgreSQL 套用（先 migration 後 rollout）。SQL 需兩後端相容（方言差由 store 介面吸收，見 §6）。
- 只用標準 PostgreSQL 功能；如需 extension 事先列出確認。
- **CAS + 稽核同交易**：需同時做原子 CAS（如 change-set 狀態轉移）與 append-only audit insert 的操作，包在同一 DB 交易內，避免網路抖動下「CAS 成功但 audit 失敗」的 split-brain（SQLite 亦以交易保證）。
- **決策理由（vs Redis）**：durable 狀態（identity/token/changeSet/audit）語義是關聯資料 + 需持久 + 需交易一致 → PostgreSQL（符 spec #6）。Redis 僅適合 cache/ephemeral；本專案 durable 資料為主，統一走 PG、少一個依賴。

考量：SQLite 目前多用同步 API（better-sqlite3），PG 是非同步。介面設計需一開始就 async（SQLite 實作包成 async），避免二次改。

### 3.2 跨請求狀態 / 鎖：in-process → 外部（約束 #3）

現況：`tokenManager` single-flight、`scheduler` poller 認領、`inventorySetting/executor` mutex 全 **in-process**（多副本會各跑一份 → 重複 refresh、雙重寫入、排程重跑）。

**關鍵約束：這三處的臨界區都包住外部網路 I/O（auth-service refresh、gateway get/put）。故絕不可用「跨越網路 I/O 的 DB 交易鎖」（`pg_advisory_xact_lock` 綁在 pooled 交易上）——那會讓每個等鎖的請求占住一條 pooled 連線直到 HTTP 往返結束，小連線池瞬間耗盡、全服務阻塞。** 對每一處分別選最輕的正確機制，而非統一上鎖：

- **scheduler 到期認領**：**不上鎖**——`scheduler.ts` 已有原子 CAS `claimScheduled(id, now)`（`UPDATE … WHERE status='scheduled'`，註解「別的實例贏了」），天生多副本安全。搬到 PostgreSQL 後 CAS 語義照舊即可。
- **inventory executor 的 per-(item,supplier) lost-update 防護**：改**樂觀並發（不跨 I/O 上鎖）**——讀現況 → 算 diff → 寫入時帶版本/條件式（CAS 或 `WHERE`），寫入前不持有任何 DB 鎖；併發只會讓其一寫入落空（可偵測、可重試），不會鎖住連線。跨 change-set 同 key 的一致性最終由 be2 後端 + 這層 CAS 保證，不由 app 端長鎖保證。
- **L2 token refresh single-flight**：維持**每 pod in-process single-flight + rotation 容忍**（現有設計本就容忍併發 refresh：rotate 天然正確、舊 refresh 撞 rotation 會失敗重取）。跨 pod 偶發重複 refresh 是可接受的（rotation-safe），**不需**分散式鎖。
- 若未來確有「必須跨副本互斥且不含長 I/O」的臨界區，才考慮 Redis 分散式鎖或**專用非 pooled 連線上的 session-level advisory lock（在長 I/O 前釋放）**；本波三處都不需要。
- 行程內 cache 只能是「有更快、沒有也正確」的最佳努力（符 spec #3）。

### 3.3 排程：in-process poller → HTTP 觸發（約束 #8）

現況：`src/core/schedule/scheduler.ts` 是 `setInterval` 類 in-process poller（多副本重複跑、縮容即消失）。

**決策：排程執行改「對外可觸發的 HTTP endpoint」。**
- 新增 `POST /internal/scheduler/tick`（帶 `CRON_SECRET` bearer、**idempotent**、認領用 3.2 的 CAS `claimScheduled`），做一次「掃到期 change-set → 執行」。
- **必須有批次上限 + 提早返回**（cloud-ready spec §2.7）：單次 tick 最多處理 N 件（如 `SCHEDULER_TICK_BATCH`，預設個位數），回報處理/剩餘數即返回；未處理的到期件下次 CronJob tick 再撈（CAS 認領保證不重複）。**不可同步清空無上限 backlog**——否則超過 ingress/ALB(~60s)/Node timeout。
- 由 **Kubernetes CronJob** 定時打這個 endpoint（宣告在 k8s manifest，非程式內 timer）。
- **stranded 偵測改租約制（多副本安全）**：現況 `auditStranded()` 在 `start()` 啟動時把所有 `executing` 記為 error——多副本下 pod B 啟動會誤判 pod A 正在跑的件。改為：認領時寫 claim 時戳（lease），`executing` 且 lease 過 TTL 未完成才視為 stranded，由 **tick 內**回收/告警（`scheduler.ts` 已有「stranded-approved 回收先於認領」的雛形，擴為 lease TTL）。**移除 `start()`-time 的無條件 `auditStranded()`**（去掉 in-process poller 後它也不該存在）。
- 本機開發可保留一個「dev-only in-process ticker 打自己的 tick」的便利旗標（`SCHEDULER_DEV_TICK=1`），但**生產一律靠 CronJob**。

### 3.4 綁定與啟動（約束 #1）

- 監聽改綁 `0.0.0.0`、讀 `process.env.PORT`（保留 `APP_PORT` 為 compat，見 3.6）。本機仍可連 loopback。
- **Host header 白名單（硬阻斷，勿漏）**：`hostGuard.ts` 現只放行 `127.0.0.1/localhost/::1`（DNS-rebinding 防護），ingress 帶的部署域名 Host 會被 403。**必須設 `APP_ALLOWED_HOSTS`=部署域名**（從 `APP_BASE_URL` 推導以免 drift）。這是 stage-eks doc §7 三個硬阻斷之一。
- 容器：multi-stage Dockerfile（build 裝全依賴、runtime 只留 prod 產物 + prod 依賴）、非 root、假設 FS 唯讀只 `/tmp` 可寫、鎖 lockfile、base image 釘 major（`node:22-alpine`）、`.dockerignore`、**處理 SIGTERM**（停收新請求、排空、退出）。
- **補 prod build**（stage-eks doc 已列缺口）：加 `build` script，**須同時產出**：(a) `tsc` 編 server code 到 `dist/`、(b) **`npm run build:ui`** 產面板 HTML（`dist/ui/*.html`）——漏了它 prod image 沒面板資產、MCP Apps 面板永久退化成純文字。加 `start`（`node dist/index.js`）；現在只有 `dev = tsx`。

### 3.5 Log：結構化 stdout（約束 #10）

現況 `console.*` 進 stdout/stderr（方向對），但無 level、非結構化。

**決策**：導入輕量結構化 logger（如 `pino`），輸出 JSON 到 stdout，`LOG_LEVEL` 控制。稽核（append-only audit）維持進 DB，不與 app log 混。

### 3.6 設定與 secret（約束 #2）+ 命名對齊

- `.env.example` 進版控，**每個值註明三分類**（build-time 公開 / runtime secret / runtime 非機密）——這是交平台 config-manager 的唯一依據。
- 對外 base URL 一律來自 env（`APP_BASE_URL`／沿用推導 OAuth callback）。
- **命名 compat**：`config.ts` 同時吃平台慣例 `APP_ENV`/`APP_PORT`（fallback 到既有 `APP_ENV`/`APP_PORT`）。auth-service key 平台命名 `API_AUTH_SERVICE_*`，我方 `*_AUTHSVC_SERVICE_KEY`——保留對映層並在 `.env.example` 標註，**確認需要的 scope**（read/write/gateway）。
- 缺必要 env **啟動就 fail fast**（只印 key 名不印值，現況已如此）。

### 3.7 治理宣告（framework registry）

- 加 repo 內 `PROJECT.yaml`（owner / risk_tier / touches / PII / schedule / external connections）——草稿見 `vibe-framework-contribution-proposal.md`（`risk_tier: red`；**team slug 待確認**）。
- 登記進 `kkday-vibe-framework` 的 `registry/registry.yaml`（[外部-低風險]，一行）——**待使用者拍板才動外部 repo**。

## 4. 分階段策略（不破壞現況）

原則：**每階段 CI 全綠、本機續跑 SQLite、行為等價**。建議序（實際切分於 writing-plans 定）：

1. **Store 介面抽象**（純重構，SQLite 收斂到介面後面、改 async；不換後端）→ CI 綠。
2. **Forward-only migration + 去 runtime DDL**（`openDb` 不再建表；migration 檔化）。
3. **PostgreSQL 後端實作**（env 選後端；SQLite 續為本機/CI 預設）→ 對 stage PG 實測。
4. **去 in-process 鎖 → 無鎖併發**（見 §3.2，勿引入跨 I/O 的 DB 鎖）：scheduler 用既有 CAS `claimScheduled`、executor 改樂觀並發（寫入 CAS）、token refresh 維持每 pod single-flight + rotation 容忍。
5. **scheduler → HTTP endpoint + CronJob**（移除 in-process poller，dev ticker 旗標）。
6. **容器化**（Dockerfile/prod build/start/SIGTERM/0.0.0.0）+ 結構化 log + `.env.example` 三分類 + `APP_*` compat + `PROJECT.yaml`。

## 5. 開放決策（需使用者/DevOps 拍板）

1. **併發機制（已定，非鎖）**：三處臨界區都不用分散式鎖（見 §3.2）——scheduler CAS、executor 樂觀並發、token per-pod single-flight。僅記錄：若未來出現「必須跨副本互斥且不含長 I/O」的新臨界區，才評估 Redis / 專用連線 session-lock。
2. **`PROJECT.yaml` 的 `risk_tier` 與 team slug**、以及**要不要現在登記進 framework registry**（[外部-低風險]）。
3. **RDS 供給**：DB 帳號（只 CRUD）、migration 由誰在部署流程套用（DevOps 對接）。
4. **auth-service key scope 對映**（`API_AUTH_SERVICE_READ` vs `REFR/WRITE`）——確認我方實際需要的 scope。
5. **DB_DRIVER 或 host 偵測**：本機 SQLite / 部署 PG 的切法（env 名稱定案）。

## 6. 風險與緩解

- **同步→非同步 store 介面**改動面廣（所有 store 呼叫點）——階段 1 一次抽象、既有測試護欄。
- **PG 連線池 × pod 數 vs RDS max_connections**——連線池設個位數、部署前算總量。
- **migration 與 code 版本不同步**——forward-only、部署順序（先 migration 後 rollout）由 DevOps 流程保證。
- **樂觀並發寫入落空**（executor CAS）——併發被搶先時須偵測（受影響列數=0）並重試/回報，不可靜默丟失；配合 §3.1 的 CAS+audit 同交易。
- **本機 SQLite 與 PG 行為差異**（型別/排序/upsert 語法）——store 介面吸收方言差；conformance 測試兩後端都跑。

## 7. 驗收

- 本波 spec 交付：本文件（agy-peer-review APPROVED）+ writing-plans 產遷移 plan。
- 各階段：CI 綠、SQLite 本機/CI 等價、PG 後端對 stage 實測、容器本地起得來（0.0.0.0 + healthz + SIGTERM）、CronJob 打 scheduler endpoint 跑通。

<!-- agy-peer-reviewed: 2026-08-26T03:11:56Z rounds=3 verdict=approved -->
