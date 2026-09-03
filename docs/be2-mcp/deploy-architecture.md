# be2 MCP — 服務架構配置（給 DevOps 申請用）

> 目的：把 be2-mcp 從單機 PoC（`127.0.0.1:8787`，狀態已於 `feat/pg-migration` 換成外部 PostgreSQL）搬上 **stage 內網部署**，並為 prod 打底。
> 用法：這份是跟 DevOps / auth-service team 討論與申請的依據。**第 9 節「申請清單」是可直接照著提的 checklist**，前 8 節是佐證與規格。
> 環境錨定：目前所有實測在 SIT `be2-220`；stage 需要「與 SIT 同形狀、換一組 host + 一把 stage service key」的配置（見第 10 節）。

---

## 1. 服務定位（一句話）

be2-mcp 是一支 **內網 Node.js 服務**，講 MCP（Model Context Protocol）Streamable HTTP。員工的 Claude Code / Claude Desktop（本機 client）連它，用自然語言對 be2 商品做批次操作；所有寫入都被攔成 draft、需人工在確認頁核准後才經 be2 gateway 執行。**認證一律委派 kkday-auth-service，不自建 RBAC。**

不是對公網開放的服務（對比 kkday-development-tools 是 public ALB 服務 claude.ai）；be2-mcp 的 client 都是員工本機，內網／VPN 可達即可。

---

## 1.5 MCP server「肚子裡」需要什麼（DevOps 相依盤點）

> 這節直接回答「除了 EKS pod，這支 server 執行時還相依哪些東西」。**結論先講：一定要一個持久化資料庫；Redis 只有在「跑超過一個 instance」時才需要；其餘幾乎沒有。**

| 相依 | 需要? | 說明 |
|---|---|---|
| **持久化 DB** | ✅ **必須** | **外部 PostgreSQL**（`feat/pg-migration` 已完成遷移，SQLite 已移除）。存 OAuth 外殼、**be2 token store（憑證不離境）**、change-set、確認頁 session、稽核、rate 計數。11 張表，見下。**兩組 role**：`be2mcp_owner`（DDL/migration，只 CI/k8s Job 用）與 `be2mcp_app`（runtime CRUD-only，`audit_log` 只 INSERT/SELECT，REVOKE UPDATE/DELETE）。schema 由 repo 內 forward-only SQL migration（`db/migrations/*.sql`，`npm run db:migrate`）管理，runtime **零 DDL**。需備份（`audit_log` 合規）。 |
| **Redis / 分散式鎖** | 🟡 **只有多實例才要** | 單一 instance 完全不需要。>1 instance 時，3 個**純記憶體**協調原語會跨實例失效（見下「多實例才需 Redis」）。 |
| **對外 egress** | ✅ | 只有兩個下游：auth-service host、be2 gateway host（443）。無其他外呼。 |
| **Secrets 管道** | ✅ | service key（每環境一把）、announce api key。走 k8s Secret / Vault。 |
| **Cron（2 個）** | ✅ | (1) `POST /api/jobs/oauth-purge` 每日一次（k8s CronJob）——已排除「被 `scheduled` change-set 引用」的 identity（塊 B purge 保護，spec §6）。(2) `POST /api/jobs/scheduler-tick` 每分鐘（`SCHEDULER_MODE=http` 時，取代 in-process poller，見下一列）。兩者皆帶 `Authorization: Bearer $CRON_SECRET`（常數時間比對）、idempotent。單實例仍可用 `SCHEDULER_MODE=poller`（預設）只留 (1) 一個外部 cron。 |
| **OTLP collector** | ⬜ 選配 | `OTEL_MODE=otlp` 才需要一個 collector endpoint。 |
| **訊息佇列 / worker** | ❌ **不需要** | 排程送出（庫存到點派送，塊 B）預設由 **server 內建 in-process poller** 完成——app 進程內的 scheduler tick（遞迴 setTimeout，`src/core/schedule/scheduler.ts`）；`SCHEDULER_MODE=http` 時改由上方 Cron (2) 驅動，同一份 `tick()` 邏輯。皆**無外部 queue/worker**；多實例的到期認領走 `change_sets` 的 DB CAS，**不新增 Redis 依賴**。 |
| **物件儲存（S3 等）** | ❌ | 無檔案上傳（不像 dev-tools 的 vibefile）。 |
| **公網 ingress** | ❌ | client 皆本機（Code/Desktop），內網即可。 |
| **GPU / 重運算** | ❌ | 無。瓶頸在下游 API 延遲。資源估 0.5 vCPU / 512MB 起。 |

**DB 的 11 張表（依用途分群）**：
- OAuth 外殼：`oauth_clients`（DCR）、`oauth_auth_codes`、`oauth_refresh`
- **be2 token store（Option 1，憑證不離境）**：`be2_identities`（access+refresh+businessList）、`credentials`（不透明參考 → identity）
- Change-set：`change_sets`、`change_set_results`
- 確認頁：`web_sessions`（`be2mcp_sid`）
- 治理：`audit_log`（append-only、需備份/保留）、`rate_counters`（rate budget，DB-backed）、`session_read_oids`（§6.2 scope substrate）

**多實例才需 Redis**（單實例可全部略過）——目前這 3 個是**純 in-process `Map`**，跨 instance 會失效：
1. **token refresh single-flight**（`tokenManager.inflight`，per-identity）——多實例並發 refresh 會撞 be2 refresh-token rotation。
2. **MCP Apps 批准 nonce**（`approvalNonce.live`）——A instance 發的 nonce，B instance 認不得。
3. **inventory per-key mutex**（`execInventory`）——防跨 change-set 同 item×supplier 的 lost-update。
（change-set 防重複執行的 CAS 走 `change_sets.status` 條件式 UPDATE，共用 DB 即跨實例安全；`rate_counters` 亦 DB-backed。→ **真正逼你上 Redis 的就是上面 3 個記憶體原語**。）
4. **排程層（塊 B）不新增第 4 個**：scheduler 的到期認領（`claimScheduled`）、stranded 回收（`releaseClaim`）、keep-alive 認領（`be2_identities.keepalive_claimed_at`）全是 DB 條件式 UPDATE，多實例天然 at-most-once；keep-alive 與「使用者活動觸發的 lazy refresh」跨實例相撞的殘餘風險歸屬原語 #1（refresh single-flight），多實例部署本來就需 Redis 收斂該原語，排程層不改變此結論。

**給 DevOps 的一句話**：先給「一個 Postgres（兩組帳號）＋ egress 兩個 host ＋ 一到兩個 cron（依 `SCHEDULER_MODE`）＋ secrets」就能跑；**要水平擴到多 pod，才需要再加 Redis**。沒有佇列、沒有 S3、沒有公網；`SCHEDULER_MODE=poller`（單實例預設）時排程送出是 app 進程內建 poller（不需額外基礎設施）。

## 2. 部署拓撲

```
  員工筆電（公司網 / VPN）
  ┌──────────────────────────┐
  │ Claude Code / Desktop    │  ← MCP client（OAuth 2.1）
  │ 瀏覽器（登入 + 確認頁）   │  ← be2-auth POPUP 登入、change-set 核准
  └───────────┬──────────────┘
              │ HTTPS（內網）
              ▼
  ┌──────────────────────────────────────────────┐
  │  be2-mcp 服務（本專案要部署的東西）             │
  │  ─ Express + MCP SDK（Streamable HTTP）        │
  │  ─ /mcp  /healthz  /oauth/*  /confirm/*        │
  │  ─ 狀態 store（PostgreSQL，外部 RDS）           │
  │  ─ 分散式鎖（多實例才需要=Redis）               │
  │  ─ cron: oauth-purge（每日）+ scheduler-tick    │
  │    （SCHEDULER_MODE=http 時，每分鐘）           │
  └───┬───────────────────┬───────────────────────┘
      │ S2S(service key)   │ 使用者 token 代呼叫
      ▼                    ▼
  auth-service         be2 API gateway
  (login/verify/       (/be2/api/v1 讀寫,
   refresh-token)       product-service /product/api/v1)
```

- be2-mcp 對外 egress 只有兩個下游：**auth-service** 與 **be2 gateway**。
- be2-auth POPUP 登入是「瀏覽器 ↔ be2-auth」直連（員工筆電發起），**不是** be2-mcp 的 server egress；be2-mcp 只在 callback 收到 authorization code 後，用 service key 走 S2S 換 token。

---

## 3. Runtime 與資源需求

| 項目 | 值 | 備註 |
|---|---|---|
| Runtime | Node.js（LTS，`engines` 釘 `>=22 <23`） | `tsx`（dev）或 `tsc` build + `node dist/`（prod）；無 native module 依賴（`better-sqlite3` 已移除） |
| 框架 | Express + `@modelcontextprotocol/sdk` | Streamable HTTP，非 stdio |
| 監聽 | `APP_BIND_HOST`（預設 `127.0.0.1`，部署設 `0.0.0.0`） | 置於 ingress/反代之後；port 由 `APP_PORT` 控 |
| health check | `GET /healthz` → `200 ok`（免認證，見 `hostGuard`，**不查 DB**） | 給 LB/k8s liveness；`/readyz` 查 DB（`SELECT 1`）給 readiness |
| 對外協定 | HTTPS（內網 TLS 由 ingress/反代終結） | app 本身跑 HTTP，TLS 交給前面那層 |
| CPU/RAM | 小（PoC 級）；正式估 0.5 vCPU / 512MB 起 | 無重運算，瓶頸在下游 API 延遲 |
| 磁碟 | 無需 persistent volume | 狀態全在外部 PostgreSQL；容器本身無狀態，可多副本（受 §6 in-process 鎖限制） |

---

## 4. 對外連線（egress 白名單）

be2-mcp 需要能連到（依環境換 host）：

| 下游 | 用途 | SIT(be2-220) 參考 host |
|---|---|---|
| auth-service | S2S 換碼、`/verify`、`/refresh-token` | `auth-220.sit.kkday.com` |
| be2 API gateway | be2 商品讀寫（`/be2/api/v1`）、product-service-direct（`/product/api/v1`） | `api-gateway-220.sit.kkday.com` |

**防火牆／SG**：允許 be2-mcp → 上述兩個 host 的 443 egress。無其他外部 egress（不需連公網 / Anthropic）。

---

## 5. Ingress（誰連進來）

- **來源**：員工筆電的 Claude Code / Claude Desktop + 瀏覽器（確認頁），全在公司網／VPN。
- **不需公網**。內網 DNS + 內網 TLS ingress 即可。
- **host allowlist**：app 內建 `hostGuard`，靠 `APP_ALLOWED_HOSTS` 擋非白名單 Host header（`/healthz` 豁免）。部署時把對外域名列進去。
- **OAuth redirect_uri allowlist**（DCR 用）：`https://claude.ai/api/mcp/auth_callback` + RFC 8252 loopback（`http://localhost:<port>/callback`、`127.0.0.1`）。
- **be2-auth POPUP origin allowlist**：`BE2_DOMAIN`——auth-service 端會檢查開 POPUP 的 opener origin 是否在 `login.be2.domain` 白名單。**stage/prod 上線前需請 auth-service team 把 be2-mcp 部署 origin 納入**（SIT/local 因 `ALLOW_LOCAL_LOGIN=true` 跳過此檢查，故 SIT 零外部依賴）。

---

## 6. 狀態儲存與高可用

**現況（`feat/pg-migration` 後）= 外部 PostgreSQL + in-process 鎖。多實例部署前，鎖仍要換掉。**

| 狀態 | 現況實作 | 正式部署需求 |
|---|---|---|
| OAuth（authz code / refresh / DCR client）、be2 身分+token store、change-sets、web sessions、audit log、session_read_oids | **PostgreSQL**（外部 RDS，`db/migrations/*.sql` 管 schema） | 已滿足；多實例天然共享（同一顆 DB） |
| 並發防護：CAS（防重複執行）、L2 refresh single-flight、per-user rate budget、inventory per-key mutex | CAS/rate budget 已是 **DB 條件式 UPDATE**（多實例安全）；single-flight 與 inventory mutex 仍是 **in-process（單機記憶體）** | **Redis / 分散式鎖**——多實例下這兩個 in-process 原語失效，會有並發 refresh 撞 rotation / lost-update（詳見 §1.5「多實例才需 Redis」） |

→ **結論給 DevOps**：**單實例**部署現在只需 **PostgreSQL**（無需 persistent volume）；一旦要 >1 實例或上 prod，需額外 provision **Redis**（收斂 token refresh single-flight 與 inventory mutex 兩個殘留 in-process 原語）。

---

## 7. 設定與機密（env 變數）

app 的權威設定在 `src/config.ts`（zod 驗證，缺就啟動失敗且**只印變數名、不印值**）。

### 一環境一份 config（config-manager 模式，2026-09-03 拍平後）

**config 內已無多環境 preset**：host 由 `AUTHSVC_URL`/`GATEWAY_URL` 直接給、key 單把 `API_AUTH_SERVICE_KEY`（無環境前綴），每個環境由 config-manager 各自注入一份。`APP_ENV` 只當標籤（log 用）。**DB 隔離改為「每環境一個 database」**（`DB_NAME` 不同，或不同 RDS instance），不再是檔名後綴。各環境的建議值：

| 環境 | `AUTHSVC_URL` | `GATEWAY_URL` | `DB_NAME`（per-env 隔離） |
|---|---|---|---|
| sit | `https://auth-220.sit.kkday.com` | `https://api-gateway-220.sit.kkday.com` | `be2mcp_sit` |
| stage | `https://auth.stage.kkday.com` | `https://api-gateway.stage.kkday.com` | `be2mcp_stage` |
| prod | `https://auth.kkday.com` ⚠️待確認 | `https://api-gateway.kkday.com` | `be2mcp_prod` |

- **一個 server 實例 = 一個環境**；切環境 = 換一份 config（URL + key + `DB_NAME`/`DATABASE_URL`）+ 重啟。要同時服務多環境 → 跑多個實例（不同 port + 不同 DB）。
- **store 隔離**：不同環境指向不同 `DB_NAME`（或不同 RDS instance）→ SIT/stage/prod 的 token store 不互相汙染（重要正確性保證，語義與舊版檔名後綴等價）。

**必填**：

| 變數 | 說明 | 機密? |
|---|---|---|
| `AUTHSVC_URL` / `GATEWAY_URL` | 該環境的 auth-service / gateway host（直接給，無 preset） | 否 |
| `API_AUTH_SERVICE_KEY` | 該環境的 auth-service S2S service key（單把、無環境前綴） | **是** |
| `DATABASE_URL`（或 `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` 四項） | 該環境 PostgreSQL 連線；二選一，`DATABASE_URL` 短路四項分開注入 | `DATABASE_URL`/`DB_PASSWORD` **是**；`DB_HOST`/`DB_USER`/`DB_NAME` 否 |

**選填 / 有預設**：

| 變數 | 預設 | 說明 |
|---|---|---|
| `APP_PORT` | `8787` | 監聽 port |
| `APP_ENV` | — | 環境標籤 `sit`/`stage`/`prod`（僅 log，不再影響 DB 選路） |
| `DB_PORT` | `5432` | PostgreSQL port（`DATABASE_URL` 走法免填） |
| `SCHEDULER_MODE` | `poller` | `poller`（in-process tick，單實例/本機）／`http`（外部 CronJob 打 `/api/jobs/scheduler-tick`，EKS 部署用） |
| `CRON_SECRET` | — | `SCHEDULER_MODE=http` 或需要 `/api/jobs/oauth-purge` 時必填；兩支 job endpoint 的 bearer |
| `OTEL_MODE` | `off` | `off`/`console`/`otlp`；設 `otlp` 才輸出 trace 到 collector |
| `APP_ALLOWED_HOSTS` | — | Host header 白名單（部署域名） |
| `APP_DEV_PANEL` | — | dev 面板開關（prod 應關） |
| `API_ANNOUNCE_KEY` | — | 商品公告 domain 的 `x-api-key`（若啟用 announcement module） |

**機密管理**：service key / api key / DB 密碼一律走 secret manager（k8s Secret / Vault），**不進 image、不進 git、log 不得出現明文**（app 已保證錯誤訊息不回顯值）。

**已知耦合（非本案修復，記錄供知悉）**：`loadConfig()` 無條件要求 DB env（即使某些腳本實際不用 `cfg.db`，如 `scripts/live-4a-acceptance.ts`）——**每個部署環境（含 CI）都需注入 DB env** 才能執行任何吃 `loadConfig()` 的指令，即使該指令本身不碰 DB。

---

## 8. 稽核與觀測

- **稽核**：每次 tool call + 每筆 change-set 執行寫 append-only audit（actor + tool + before/after），**無 token 明文**。正式部署稽核表隨 Postgres 一起保存 + 備份（PG trigger 擋 UPDATE/DELETE + app role REVOKE UPDATE/DELETE 雙保險，不退化）。
- **Tracing**：OpenTelemetry，`OTEL_MODE=otlp` + OTLP HTTP exporter → 給一個 collector endpoint（需 DevOps 提供，或用既有 KKday OTel/Jaeger）。
- **Logs**：stdout（結構化），交給既有 log 收集（Kibana/new-kklog）。

**切換日 SQLite 檔歸檔程序（`feat/pg-migration` 上線當日，一次性）**：各環境切換到 PostgreSQL 前，將舊 `./data/*.sqlite` 檔案本體歸檔，不做 row-level 搬遷（fresh start，token/session/credential 皆短命可重登；change-set 歷史無執行中依賴，切換窗口公告 + 事前確認 pending/scheduled 清單為空）：
1. 停服務窗口內，對每個環境的 SQLite 檔案 `gzip` 壓縮。
2. 對壓縮檔算 `sha256sum`，連同原始檔名、環境、切換時間戳記一併記錄（存放位置與保留期限沿用現行 audit 備份規範）。
3. 保留期限依 audit 合規要求（同現行 `audit_log` 保留政策，不因遷移而縮短）。
4. 查閱方式：任何 SQLite client（`sqlite3` CLI、DB Browser for SQLite 等）解壓後可直接開檔查詢，無需額外工具。
5. PG 側 `audit_log` 從空表開始，append-only 保證由 trigger + REVOKE 承接（不依賴舊檔延續）。

---

## 9. 給 DevOps / auth-service team 的申請清單（可直接照提）

> **Phase A 落地進度**：✅ Dockerfile / npm run build / bind host / public URL / /readyz probe / graceful shutdown 已完成。見 `cloud-ready-phaseA-runbook.md`。

**A. DevOps（部署與基礎設施）**
1. 內網部署位置（k8s namespace 或 VM）＋ 內網 DNS 名稱 ＋ 內網 TLS ingress（終結 HTTPS → app HTTP `:8787`）。
2. Egress 放行 be2-mcp → auth-service host、be2 gateway host 的 443（見第 4 節）。
3. Ingress 限公司網／VPN 來源；不開公網。
4. Secret 管道存 service key / api key（第 7 節機密欄位）。
5. **狀態儲存**：**PostgreSQL 一個 database（每環境一個）**，**兩組帳號**：
   - `be2mcp_owner`——schema owner，可 DDL；只給 CI/k8s migration Job 用（`npm run db:migrate`）。
   - `be2mcp_app`——runtime CRUD-only、零 DDL；`audit_log` 只給 INSERT/SELECT（REVOKE UPDATE/DELETE，防稽核被竄改/刪除，雙保險之一，另一是 PG trigger）。
   多實例／prod 另給 **Redis** 一個（收斂 token refresh single-flight + inventory per-key mutex，見 §6）。
6. **Cron（2 個 k8s CronJob）**，皆打 HTTP endpoint、帶 `Authorization: Bearer $CRON_SECRET`：
   - `oauth-purge`：每日一次，`POST /api/jobs/oauth-purge`（清過期 token + ghost DCR client）。
   - `scheduler-tick`：每分鐘一次（僅 `SCHEDULER_MODE=http` 部署需要），`POST /api/jobs/scheduler-tick`。
7. （選）OTLP collector endpoint 給 `OTEL_MODE=otlp`。
8. health check 用 `GET /healthz`（liveness，不查 DB）；`GET /readyz`（readiness，查 DB）。

**B. auth-service team（認證依賴）**
9. **該環境的 service key**（stage 一把、prod 一把；SIT 版已有）。確認 scope 涵蓋換碼 / refresh / verify 需要的 read/write。
10. **把 be2-mcp 部署 origin 納入 `BE2_DOMAIN`（`login.be2.domain`）白名單**——prod `isDevEnv` 硬編 false，POPUP 登入會做 origin 檢查（SIT 靠 `ALLOW_LOCAL_LOGIN` 跳過，prod 不行）。

---

## 10. Stage vs Prod 差異

| 面向 | SIT（現況） | Stage（本次申請） | Prod（後續） |
|---|---|---|---|
| service key | 已有（`.env` `API_AUTH_SERVICE_KEY`） | **需 stage 一把**（目前 `.env` `API_AUTH_SERVICE_KEY` 為空 → 卡 S2S） | 需 prod 一把 |
| POPUP origin | `ALLOW_LOCAL_LOGIN=true` 跳過檢查 | 確認 stage 是否 dev env；若否需納 `BE2_DOMAIN` | **必須**納 `BE2_DOMAIN` 白名單 |
| 狀態 store | 外部 PostgreSQL（`feat/pg-migration`） | PostgreSQL（單實例已足；多實例另加 Redis） | Postgres + Redis |
| ingress | 本機 loopback | 內網 TLS ingress | 內網 TLS ingress |
| 監聽綁定 | `127.0.0.1` | 改綁可達介面（置於 ingress 後） | 同 stage |

> **本次卡點提醒**：stage 要能跑 S2S（換碼/refresh/verify），最小前提就是申請項 **B9 的 stage service key**。在拿到之前，stage 的寫入契約驗證只能走「瀏覽器 playwright 驅動 be2-web 前端 + sniff API」的路線（不需 service key），這也是目前用來補 announcement / inventory 契約的做法。

---

## 附：相關文件
- 認證設計：`be2-mcp-auth-design.md`、`phase0-inventory.md`
- OAuth 外殼與登入腿：`oauth-runbook.md`、`spike-oauth-login-leg.md`
- 確認頁 SSO：`phase2b-runbook.md`；面板 nonce 通道：`mcp-apps-runbook.md`
- 寫入契約與 per-env 授權卡點：`sit-write-contracts.md`
- **Cloud-Ready Phase A（本檔案 §9 實施指南）**：`cloud-ready-phaseA-runbook.md`
