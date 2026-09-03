# be2 MCP — 遷移到 stage EKS 技術文檔（與 DevOps 討論用）

> 對象：DevOps。目的：把目前在開發者本機跑的 **be2 MCP server** 部署到 **stage 環境的 EKS**。
> 本文只描述「要放上 EKS 需要什麼、有哪些必改點、有哪些決策要一起拍板」，不含業務細節。
> 撰寫日期：2026-08-21。程式事實引自 repo `mcp_poc`，皆附 `檔案:行號`。

---

## TL;DR（先看這段）

be2 MCP 是一支 **Node.js / Express Streamable-HTTP** 服務，讓 KKday 員工透過 AI agent（Claude Code / Desktop）用自然語言批次操作 be2 商品後台，全程走 kkday-auth-service 認證、寫入一律人工批准。

它目前是**開發原型**（本機 `127.0.0.1:8787` 用 `tsx` 直跑、狀態全存單一 SQLite 檔），要上 EKS 有 **9 個必改點**（見 §7）。其中三個是硬阻斷：**綁 loopback、Host header 白名單、OAuth URL 硬編 127.0.0.1**。

架構上目前**只能單副本（replicas=1）**：token refresh、庫存寫入鎖、MCP session、SQLite 都是 in-process/單機假設。要 HA 需要後續改造（見 §8），本次遷移目標建議先「單副本 + PVC 跑起來」。

需要 DevOps 決策的清單在 §9。

---

## 1. 這是什麼服務

- **型態**：長駐 HTTP 服務（非 batch job、非 cron）。
- **語言/框架**：Node.js + Express 5 + MCP SDK 的 `StreamableHTTPServerTransport`（`src/server/app.ts:1,5,328`）。
- **進入點**：`src/index.ts` → `loadConfig()` → `initOtel()` → `openDb()` → `buildApp()` → `listen()`（`src/index.ts:6-12`）。
- **誰來連**：員工本機的 Claude Code / Claude Desktop（皆本機發起的 client）。**不服務 claude.ai 公網網頁**，所以理想上是**內網服務**，不需對公網開放。
- **它會主動外連**：stage 的 auth-service 與 api-gateway（見 §5）。

### 對外 HTTP 路由

| 路由 | 用途 |
|---|---|
| `GET /healthz` | 健康檢查（純 liveness，`app.ts:250`） |
| `POST/GET/DELETE /mcp` | MCP 主通道（Streamable HTTP，`app.ts:288`） |
| `GET /.well-known/oauth-authorization-server`、`/.well-known/oauth-protected-resource` | OAuth 2.1 discovery（`discoveryRoutes.ts:10,22`） |
| `POST /oauth/register` | 動態註冊 client（DCR，`registerRoutes.ts:17`） |
| `GET /oauth/authorize`、`POST /oauth/authorize/complete` | 授權（`authorizeRoutes.ts:72,279`） |
| `POST /oauth/token` | 換 token（`tokenRoutes.ts:70`） |
| `GET /confirm/login`、`POST /confirm/session`、`POST /confirm/logout` | 確認頁 SSO 登入（`ssoRoutes.ts:52,91,111`） |
| `GET /confirm/:id`、`POST /confirm/:id/{approve,cancel,reject}` | 確認頁：人工批准/拒絕/取消 change-set（`confirmRoutes.ts:109,140,184,202`） |
| `/dev/*` | dev 測試面板，**prod/stage 禁用**（`APP_DEV_PANEL=1` 才掛，`app.ts:283-286`） |

---

## 2. 執行環境需求

- **Node**：repo **沒有** `engines` 或 `.nvmrc`，需 DevOps 幫忙釘版本。建議 **Node 20 LTS 以上**（依賴 `better-sqlite3@13` native module 與 undici `fetch`；`tsconfig` target ES2022）。
- **native module**：`better-sqlite3` 是 C++ native binding。容器 base image 需能安裝對應 Node ABI 的 prebuilt（或帶 build toolchain）。**這是選 base image 時要注意的點**。
- **啟動方式（現況缺口）**：目前**沒有 production build、也沒有 `start` script**——只有 `dev = tsx src/index.ts`（`package.json:5-16`）。`tsconfig` 雖有 `outDir: dist`，但沒有任何 script 跑 `tsc` 產出 server code（`typecheck` 是 `--noEmit`）。`dist/` 目前只放 UI 面板 HTML（esbuild 產出）。
  - → **上 EKS 前要二選一**：(a) 補一條真正的 `tsc` build + `node dist/index.js`；或 (b) 容器內用 `tsx` / `node --import tsx` 直跑 `src/index.ts`。建議 (a) 較符合 production 慣例；(b) 較快但把 TS 編譯放在 runtime。
- **UI 面板 build**：`npm run build:ui`（esbuild 把 4 個面板 bundle 成單檔 HTML 到 `dist/ui/`）。這步要納入容器 build（否則面板功能降級為純文字，服務仍可跑）。

---

## 3. 狀態儲存（重點：需要 persistent volume）

- **單一 SQLite 檔**（`better-sqlite3`，**in-process、同步、單機**，`src/store/db.ts`）。
- **路徑**：env `APP_DB_PATH`，預設 `./data/be2-mcp.sqlite`（相對 cwd）；若設 `APP_ENV` 未顯式給路徑會變 `./data/be2-mcp-stage.sqlite`（`config.ts:34,73-76`）。
- **WAL 模式**：會另外產生 `-wal` / `-shm` 檔，需與主檔同一 volume（`db.ts:124-127`）。
- **存了什麼**（`db.ts` schema）：be2 使用者 token（`be2_identities` 含 access/refresh，**明文**）、OAuth client/authcode/refresh、change-set 狀態機、web session、append-only 稽核日誌（`audit_log`，有禁改禁刪 trigger）、rate 計數。
- **含義**：
  1. **需要 PVC**（persistent volume）。Pod 重啟不能掉資料——掉了等於所有使用者要重新登入、進行中的 change-set 遺失、稽核斷檔。
  2. **存了明文 token** → volume 與 Secret 一樣需視為敏感資產（加密 volume / 存取控管）。
  3. **單檔 in-process → 不能多 Pod 共寫**（見 §8）。

---

## 4. 設定與 secrets

設定集中在 `src/config.ts`（Zod 驗證）。**一環境一份 config、無 preset**（2026-09-03 拍平）：上 stage 需明設 `AUTHSVC_URL`/`GATEWAY_URL` 指 stage host；`APP_ENV=stage` 只當標籤（影響預設 DB path 後綴）。

| Env | 用途 | Secret? | 上 stage 要設 |
|---|---|:---:|:---:|
| `AUTHSVC_URL=https://auth.stage.kkday.com` | auth-service host（直接明設） | 否 | ✅ |
| `GATEWAY_URL=https://api-gateway.stage.kkday.com` | gateway host（直接明設） | 否 | ✅ |
| `APP_ENV=stage` | 環境標籤（只影響預設 DB path 後綴，不選 host/key） | 否 | 建議 ✅ |
| `API_AUTH_SERVICE_KEY` | stage 的 S2S service key | **是** | ✅（**目前 repo 尚無此 key，需向 auth-service team 申請**） |
| `APP_ALLOWED_HOSTS` | Host header 白名單（逗號分隔） | 否 | ✅（不設 ingress Host 一律 403，見 §7） |
| `APP_PORT` | listen port（預設 8787） | 否 | 選用 |
| `APP_DB_PATH` | SQLite 檔路徑（指到 PVC 掛載點） | 否 | ✅ 建議顯式指定到 volume |
| `OTEL_MODE=otlp` | 開 OTel trace 匯出 | 否 | 建議 ✅ |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector（標準 OTel env） | 否 | 視 §6 |
| `API_ANNOUNCE_KEY` | 公告功能 svc-b2c api key | **是** | 視是否啟用公告功能 |
| `APP_TZ` | 排程時區（預設 `Asia/Taipei`） | 否 | 選用 |
| `APP_DEV_PANEL` | `=1` 開 dev 面板 | 否 | ❌ **務必不要設** |

- Secret 注入用 **k8s Secret**（規範：憑證永不 commit、永不印出；config 錯誤只印 key 名不印值，`config.ts:62-63`）。
- `.env` 裡有些其他工具殘留的 key（`AUTOMATION_TOKEN` 等）**程式不讀**，遷移不需帶。

---

## 5. 對外連線（egress allowlist）

server 會主動打的外部服務（host 由 `AUTHSVC_URL`/`GATEWAY_URL` 明設）：

| 目標 | 用途 | Port |
|---|---|---|
| `auth.stage.kkday.com` | auth-service：login / 換碼 / refresh-token（S2S 帶 service key，`authServiceClient.ts:42,54,58`） | 443 |
| `api-gateway.stage.kkday.com` | be2 商品讀寫 API（`gateway/client.ts`，timeout 15s） | 443 |
| `api-gateway.stage.kkday.com/svc-b2c/...` | 公告 API（若啟用，`svcB2cClient.ts:58`） | 443 |
| OTLP collector | trace 匯出（若 `OTEL_MODE=otlp`） | 4318（預設） |

- **be2-auth 登入是瀏覽器 POPUP，不是 server egress**：server 只回一段 HTML 讓使用者的瀏覽器彈窗到 `auth.stage.kkday.com/auth/be2/login`（`ssoRoutes.ts:57`、`app.ts:137`）。這牽涉「使用者瀏覽器能連到 MCP 的 public URL」——見 §7 第 3 點。
- → EKS 需放行 egress 到 stage auth-service / api-gateway（443）+ OTLP collector。

---

## 6. 可觀測性

- **trace**：`initOtel(OTEL_MODE)`（`otel.ts:9-17`）。`off`（預設）= 完全不啟、traceId 全 0；`console` = 印 stdout；`otlp` = OTLP HTTP exporter。
- **exporter endpoint 沒有專屬 env**，用標準 OTel 環境變數 `OTEL_EXPORTER_OTLP_ENDPOINT`（預設 `http://localhost:4318`）——需注入指到 stage 的 collector。
- serviceName 硬編 `be2-mcp`；`SIGTERM` 時會 `sdk.shutdown()`（graceful，`otel.ts:16`）。
- **只有 traces，沒有 metrics/logs exporter**。稽核走 SQLite `audit_log` 表。
- → 建議 stage 設 `OTEL_MODE=otlp` + collector endpoint，讓 trace 進既有可觀測性平台。

---

## 7. 上 EKS 的必改點（9 項，含 3 個硬阻斷）

| # | 項目 | 現況 | 為什麼是阻斷 / 要改成 | 位置 |
|---|---|---|---|---|
| 1 🔴 | **listen 綁 loopback** | `app.listen(port, '127.0.0.1')` 硬編 | Pod 內外都連不進來。要改成 `0.0.0.0`（目前無 env 可覆蓋，需改 code） | `index.ts:9` |
| 2 🔴 | **Host header 白名單** | 只放行 `127.0.0.1/localhost/::1`，其餘 403（DNS-rebinding 防護） | ingress/LB 帶的 Host 會被擋。要設 `APP_ALLOWED_HOSTS`=部署域名 | `hostGuard.ts:27-71` |
| 3 🔴 | **OAuth/discovery URL 硬編 `127.0.0.1`** | issuer / authorize / token / register / resource-metadata 全寫死 `http://127.0.0.1:${port}` | OAuth client 會被導回 127.0.0.1，登入流程斷。需引入「public base URL」env 並套用到所有 discovery 輸出（目前不存在，需改 code） | `app.ts:141,254-267,303`；`discoveryRoutes.ts:12-15,23` |
| 4 | **SQLite 需 PVC** | 單檔 + WAL，相對路徑 | 需掛 persistent volume，`APP_DB_PATH` 指到掛載點 | `db.ts:124`；`config.ts:34` |
| 5 | **replicas 固定 1** | 多處 in-process 單機假設 | 多副本會壞（見 §8）。本次先 `replicas: 1` | 見 §8 |
| 6 | **build/run 缺口** | 只有 `tsx` dev、無 production build、無 `start` | 需補 build 或容器內 tsx 直跑；處理 `better-sqlite3` native build | `package.json:5-16` |
| 7 | **Secret 注入** | 從 `.env` 讀 | k8s Secret 注入 `API_AUTH_SERVICE_KEY`（+ 視需 `API_ANNOUNCE_KEY`） + `APP_ENV=stage` | `config.ts:67` |
| 8 | **OTel** | 預設 off | 設 `OTEL_MODE=otlp` + `OTEL_EXPORTER_OTLP_ENDPOINT` | `otel.ts` |
| 9 | **dev panel 關閉** | `APP_DEV_PANEL=1` 才開 | 確保 stage/prod 不為 1 | `app.ts:283` |

- **HTTP vs HTTPS**：OAuth 2.1 規範要求 authorization server 走 HTTPS。若 ingress 做 TLS termination（HTTPS 對外、HTTP 到 Pod），第 3 點的 public base URL 要輸出 `https://` scheme。

---

## 8. 擴展性限制（為什麼先單副本）

程式目前有數處 **in-process / 單機假設**，多副本會出錯。這是原型階段的取捨，程式碼多處已註明「多 instance 需分散式鎖」：

| 假設 | 多副本後果 | 位置 |
|---|---|---|
| 庫存寫入用 in-process mutex（`Map<key,Promise>` 序列化） | 兩個 Pod 會同時改同一 item×supplier → lost update | `modules/product/inventorySetting/executor.ts:14-23` |
| token refresh single-flight（`inflight` Map 合併並發） | 各 Pod 各自 refresh → 撞 refresh-token rotation，reuse detection 會 family-revoke 把使用者踢下線 | `auth/tokenManager.ts:16-22,74-97` |
| MCP session / rate budget 存 in-memory Map | 無 sticky session 的多副本會找不到 session（回 404） | `app.ts:168,182,190` |
| SQLite 單檔 | 無法多 Pod 共寫 | `db.ts` |

- **例外**：排程器（`scheduler.ts`）已為多副本設計——認領/回收走 SQLite 單條 CAS UPDATE、keep-alive 走 DB claim 防重複。但仍受單檔 SQLite 限制。
- **結論**：**本次遷移目標 = 單副本（replicas=1）+ PVC 跑起來**。走向 HA（多副本）需要另一輪改造：SQLite → 外部 DB（Postgres/RDS）、in-process 鎖 → Redis 分散式鎖、in-memory session → 共用 store 或 sticky session。這可列為 stage 穩定後的下一階段，不擋本次上線。

---

## 9. 需要 DevOps 一起拍板的決策

1. **對外暴露範圍**：內網 only（VPN/公司網可達即可，符合本服務設計）還是要走 public ingress？影響 §7 第 3 點的 public base URL 與 TLS。
2. **域名 + TLS**：要一個 stage 域名（例如 `be2-mcp.stage.kkday.com`）+ 憑證。TLS 在 ingress termination 還是到 Pod？
3. **build 策略**：容器內補 `tsc` build 跑 `node dist/index.js`，還是 `tsx` 直跑？base image 選型（要能裝 `better-sqlite3` native）。
4. **持久化**：PVC 的 storage class / 大小 / 是否加密。備份策略（SQLite 檔）。
5. **Secret 管理**：用 k8s Secret 直接放，還是接既有的 secret manager？`API_AUTH_SERVICE_KEY` 由誰申請（需向 auth-service team）。
6. **egress policy**：NetworkPolicy 放行到 stage auth-service / api-gateway / OTLP collector。
7. **可觀測性接點**：stage 的 OTLP collector endpoint。
8. **CI/CD**：用哪條 pipeline（Woodpecker？既有 EKS app 慣例）+ image registry（ECR？）。
9. **健康探針**：`/healthz` 純 liveness（不查 DB/下游，`app.ts:250`）可當 liveness probe；readiness 意義有限（現況無探 DB/下游的端點）。要不要補 readiness 端點？

---

## 10. 建議的分階段路線

1. **Phase A — 讓它在 stage EKS 單副本跑起來**（本次目標）
   - 改 §7 的 3 個硬阻斷（bind `0.0.0.0`、`APP_ALLOWED_HOSTS`、public base URL 參數化）。
   - 補 build/容器化、掛 PVC、注入 Secret、`replicas: 1`、OTel otlp、healthz liveness。
   - 驗收：員工用 Claude Code 對 stage MCP 完成一次 OAuth 登入 + 一次 read + 一次 change-set 批准的 e2e。
2. **Phase B — 觀測穩定性**：跑一段時間，看 token refresh、排程、稽核在 stage 的真實行為。
3. **Phase C — HA 改造（未來，非本次）**：SQLite→外部 DB、in-process 鎖→Redis、session→共用 store，解開 replicas=1 限制。

---

## 附錄：本地目前怎麼跑（給 DevOps 參考行為）

```
# 依賴
npm ci
npm run build:ui          # 產出 dist/ui/*.html 面板

# 啟動（開發）
APP_ENV=stage API_AUTH_SERVICE_KEY=xxx npm run dev
# → 監聽 127.0.0.1:8787，/mcp + /healthz

# 健康檢查
curl http://127.0.0.1:8787/healthz    # → 200 "ok"
```

client 接入（本機）：`claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp`，瀏覽器跳 be2-auth POPUP 登入。上 EKS 後把 URL 換成部署域名。

---

## 8. cloud-ready 對齊：vs `vibe-cloud-ready-spec.md` 12 條硬約束（2026-08-26）

> **本節是「cloud-ready 12-約束落差」的單一權威來源（single source of truth）。** 其他文件（遷移 spec、
> framework 貢獻提案、Obsidian 筆記）一律**連結引用本表、不得各自重抄一份**，避免走鐘。
> 權威規範已收進 repo：`docs/be2-mcp/vibe-cloud-ready-spec.md`（來源 kkday-it/kkday-vibe-framework）。
> 平台設定分 **APP CONFIG（非機密）** + **APP SECRET（機密，config-manager 注入 k8s Secret）** 兩塊 dotenv。
> **決策**：分階段——先產本差距分析 + 遷移 spec/plan（走主管線），實際重構下輪分批。
> **更新（2026-09-03）**：#4/#5/#6/#7/#8 已由 `feat/pg-migration` 分支關閉（見下表與
> `docs/superpowers/specs/2026-09-03-pg-migration-design.md`）。

| # | 約束 | be2-mcp 現況 | 判定 | 遷移動作 |
|---|---|---|---|---|
| 1 | 綁 `0.0.0.0`（非 127.0.0.1） | `APP_BIND_HOST`（預設 `127.0.0.1`，部署可調 `0.0.0.0`；Phase A 已補） | 🟢 | 已可用，非本案動作 |
| 3 | 完全無狀態、可多副本 | tokenManager single-flight / inventory executor 仍是 **in-process 鎖**；CAS/rate budget 已是 DB 條件式 UPDATE（多實例安全） | 🔴 | 留給 HA 階段：single-flight + inventory mutex 去 in-process → Redis/分散式鎖。scheduler 認領（CAS）與 web session 現況（in-memory）亦留待該階段一併檢視 |
| 4 | 不寫本機磁碟（除 /tmp） | ✅ **已關閉**（`feat/pg-migration`）：`./data/*.sqlite` 已刪除，狀態全在外部 PostgreSQL | ✅ | 已完成 |
| 5 | 禁 SQLite/檔案型 DB | ✅ **已關閉**：`better-sqlite3` 依賴已移除（`package.json`/`src`/`tests`/`scripts` 零引用） | ✅ | 已完成 |
| 6 | DB = 外部 PostgreSQL + TLS | ✅ **已關閉**：`pg.Pool`（`PgDb`），`DB_HOST/PORT/USER/PASSWORD/NAME` 或 `DATABASE_URL`，TLS `rejectUnauthorized:false`（RDS `sslmode=no-verify`） | ✅ | 已完成 |
| 7 | runtime 不做 DDL（forward-only migration） | ✅ **已關閉**：`openDb()` 的 runtime `CREATE TABLE` 已刪除；schema 由 `db/migrations/*.sql` + `npm run db:migrate`（forward-only、advisory lock）管理；app role（`be2mcp_app`）無 DDL 權限 | ✅ | 已完成 |
| 8 | 排程 = HTTP endpoint（帶 bearer、idempotent） | ✅ **已關閉**：`POST /api/jobs/oauth-purge`、`POST /api/jobs/scheduler-tick`（`Authorization: Bearer $CRON_SECRET`，idempotent）；`SCHEDULER_MODE=poller\|http` 切換，`http` 模式停用內建 poller | ✅ | 已完成 |
| 2/9/10/11/12 | env secret / S3 SDK 憑證鏈 / stdout / health 無依賴 / adapter | env OK、`/healthz` OK（不查 DB）、console 進 stdout（缺 LOG_LEVEL 結構化）；無 S3；adapter 部分 | 🟢🟡 | 補結構化 stdout（LOG_LEVEL）、`ctx.*` adapter 化、`.env.example` 三分類、`PROJECT.yaml` |

**與原設計一致**：`be2-mcp-auth-design.md` 的 Option 1 明寫 token store = 內網共用 **Redis/DB**；SQLite 曾是 Phase 1a 簡化，`feat/pg-migration` 已換成生產預期的外部 DB。

**遷移核心槓桿（已兌現）**：store SQLite→PostgreSQL 一動，連帶解 #4/#5/#6/#7；scheduler #8 另立兩支 job endpoint 一併關閉。**剩餘缺口收斂到 #3**（in-process 鎖 + in-memory session），留給多副本 HA 階段——單副本部署下 #3 不阻擋上線。

**命名對齊**：平台用 `APP_ENV`/`APP_PORT`/`APP_NAME`；be2-mcp 用 `APP_ENV`/`APP_PORT`。`config.ts` 加 compat（同時吃 `APP_ENV`）或部署時對映。auth-service key 平台命名 `API_AUTH_SERVICE_*`，我方 `*_AUTHSVC_SERVICE_KEY`，需對映 + 確認 scope。
