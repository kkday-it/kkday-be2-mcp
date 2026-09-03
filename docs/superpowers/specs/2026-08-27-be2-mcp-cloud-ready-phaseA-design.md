# be2-mcp cloud-ready 遷移 Phase A 設計 — 2026-08-27

> 範圍拍板（2026-08-27，grilling 七問定案）：把 be2-mcp 從本機 PoC（`127.0.0.1:8787` + 單一 SQLite 檔）搬上 **stage EKS 單副本**跑起來。**不碰** Postgres / Redis / HA（留待 Phase C）。
> 輸入文檔：`docs/be2-mcp/stage-eks-migration-devops.md`（9 必改點）、`docs/be2-mcp/deploy-architecture.md`（相依盤點 + 申請 checklist）。
> 產出邊界：**app code 改動 + Dockerfile + 文件在本 repo；k8s manifests（Deployment/Service/PVC/Secret/CronJob/NetworkPolicy）交 DevOps。**

## 1. 背景與問題

be2-mcp 目前是**開發原型**：`tsx src/index.ts` 直跑、狀態全存單一 on-disk SQLite 檔、`app.listen(port, '127.0.0.1')`（`src/index.ts:9`）。要放上 stage EKS 有三個**硬阻斷**會讓服務連不進來或登入流程斷：

1. **listen 綁 loopback**（`src/index.ts:9` 硬編 `'127.0.0.1'`）→ Pod 內外都連不進。
2. **OAuth/discovery URL 硬編 `http://127.0.0.1:${port}`**（`src/server/app.ts:142,255`）→ OAuth client 會被導回 127.0.0.1，登入斷。
3. **Host header 白名單**只放行 loopback，其餘 403（DNS-rebinding 防護，`src/server/hostGuard.ts:47-63`）→ ingress 帶的 Host 被擋。

其餘為非阻斷但上線必要的工程（build/容器化、PVC、Secret 注入、可觀測性、探針、graceful shutdown）。

**本波目標 = 單副本（replicas=1）+ PVC 跑起來**。HA（多副本）需另一輪改造（SQLite→外部 DB、in-process 鎖→Redis、in-memory session→共用 store），明確排除於本波，理由見 §8。

## 2. 現況事實（設計依據）

1. **bind loopback 硬編**：`src/index.ts:9` `app.listen(config.port, '127.0.0.1', …)`，**無 env 可覆蓋**。
2. **Host 白名單已是 env**：`src/server/hostGuard.ts:43-44` 已讀 `process.env.APP_ALLOWED_HOSTS`（逗號分隔、大小寫正規化）併入放行集合，`/healthz` 豁免（`hostGuard.ts:30`）。→ **阻斷 #3 純設定、零 code。**
3. **public base URL 硬編兩處**：`src/server/app.ts:142`（`const baseUrl = 'http://127.0.0.1:${config.port}'`，供 MCP Apps confirm_url / l2Context）與 `src/server/app.ts:255`（`buildDiscoveryRouter({ baseUrl: … })`，供 `.well-known` discovery + authorize/token/register/resource-metadata 輸出）。此 `baseUrl` 往下 thread 到 `l2Context.ts:23`、`appPipeline.ts:45`、`toolPipeline.ts:27`。`src/oauth/discoveryRoutes.ts` 由傳入的 baseUrl 組所有 endpoint URL。
4. **client loopback allowlist 要保留**：`src/oauth/redirectUri.ts:21` 對 `http://localhost|127.0.0.1` 的 redirect_uri 放行——這是 **Claude Code client 本機 callback**，與 server bind 無關，**不改**。
5. **config 集中 + Zod**：`src/config.ts` 用 `EnvSchema`（`config.ts:28-37`）驗證，`APP_ENV=stage` preset 帶入 auth/gateway host + 選 `API_AUTH_SERVICE_KEY`（`config.ts:16-20,67`）。錯誤只印 key 名不印值（`config.ts:62-63`）。`import 'dotenv/config'`（`config.ts:2`）在無 `.env` 時 no-op → **k8s env-var 注入天然可用**。
6. **build 缺口**：`package.json:5-16` 只有 `dev=tsx src/index.ts`、`typecheck=tsc --noEmit`、`build:ui=node scripts/build-ui.mjs`，**無 production build、無 `start`**。`tsconfig.json` `outDir:dist`、`module/moduleResolution:NodeNext`、`include:["src","scripts","eval","tests"]`。
7. **source 已 NodeNext-ready**：relative import 全帶顯式 `.js`（`src/index.ts:1-4` `./config.js` 等），`typecheck` 在 CI 通過 → **`tsc` 產出的 `dist/*.js` 是可直接 `node` 跑的 ESM**。
8. **native module**：`better-sqlite3@^13`（`package.json:29`）是 C++ binding，需 base image 能取得對應 Node ABI 的 prebuild（glibc）。
9. **SQLite 單檔 + WAL**：`src/store/db.ts:124-127` `openDb(path)` → `new Database(path)` + `pragma('journal_mode = WAL')`，另產 `-wal`/`-shm`（需同一 volume）。路徑 env `APP_DB_PATH`（`config.ts:34`，`APP_ENV` 設時預設 `./data/be2-mcp-${env}.sqlite`，`config.ts:73-76`）。存 be2 token（明文 access/refresh，`db.ts:78-87`）、OAuth 外殼、change-set、web session、append-only `audit_log`（禁改禁刪 trigger，`db.ts:23-26`）、rate 計數等 11 張表。
10. **SIGTERM 只有 OTel**：`src/otel.ts:16` `process.on('SIGTERM', () => void sdk.shutdown())`。HTTP server、scheduler poller（`app.locals.startScheduler`，`index.ts:11`）、DB **皆無 graceful 關閉**。
11. **健康端點**：`/healthz` 純 liveness、不查 DB/下游（`app.ts:250`）。**無 readiness 端點。**
12. **OTel 已支援 otlp**：`src/otel.ts:9-17` `initOtel(mode)`，`off`（預設）/`console`/`otlp`；otlp 用標準 `OTEL_EXPORTER_OTLP_ENDPOINT`（預設 `:4318`）。serviceName 硬編 `be2-mcp`。
13. **dev panel gated**：`app.ts:283-286` 僅 `APP_DEV_PANEL=1` 才掛 `/dev/*`。stage 不設即關。
14. **oauth-purge 是 script**：`package.json:14` `oauth-purge=tsx scripts/oauth-purge.ts`（每日 cron 語義）。`tsconfig include` 已含 `scripts`。
15. **egress 僅兩個下游**：stage auth-service（`auth.stage.kkday.com`）、api-gateway（`api-gateway.stage.kkday.com`）443；otlp collector（若開）；be2-auth 登入是**使用者瀏覽器 POPUP**，非 server egress（`ssoRoutes.ts:57`、`app.ts:137`）。

## 3. 設計總覽

三個硬阻斷 + 六項上線工程，全部落在「新增/覆寫 env → 注入既有接線點」與「新增 Dockerfile + build script」，**不動治理核心、不動 store schema、不動 change-set 狀態機**。

```
config.ts  ── 新增 2 個 config env（bindHost / publicBaseUrl；allowedHosts 已在 hostGuard 直讀 process.env）
   │
   ├─ index.ts       : listen(port, config.bindHost)              [阻斷#1]
   │                   + hoist db + 單一 SIGTERM/SIGINT graceful 協調者（見 §9）
   ├─ app.ts:142,255 : baseUrl = config.publicBaseUrl             [阻斷#3]
   ├─ app.ts         : /healthz 後、hostGuard 前 新增 GET /readyz（SELECT 1）
   ├─ scheduler.ts   : start() 回 () => Promise<void>（stopper 等 in-flight tick）  §9
   ├─ otel.ts        : 匯出 async shutdownOtel() + 移除自帶 SIGTERM listener       §9
   └─ hostGuard      : 已讀 APP_ALLOWED_HOSTS（僅設值）        [阻斷#2]

tsconfig.build.json ── 新增（include src+scripts，排除 eval/tests）
package.json ── build（tsc -p tsconfig.build.json + build:ui）、start（node dist/src/index.js）
Dockerfile   ── multi-stage（builder: npm ci + build → runtime: node:22-bookworm-slim + dist + prod deps）
.nvmrc / engines ── 釘 Node 22
docs ──────── 更新 runbook（容器化怎麼跑、env 契約給 DevOps）
```

**不變式保持**：`config.ts` 錯誤不印值、憑證不落 log、`audit_log` append-only、redirect_uri client loopback allowlist、Host guard 對非 loopback 一律 403（只是白名單多了部署域名）。

## 4. Config 變更（`src/config.ts`）

`EnvSchema` 新增兩欄（皆選用、帶預設，保 local dev 行為不變）：

| env | 型別/預設 | 用途 |
|---|---|---|
| `APP_BIND_HOST` | `z.string().default('127.0.0.1')` | listen 綁定位址。容器設 `0.0.0.0`。**預設留 127.0.0.1**——local dev 不因升級而暴露到 LAN。 |
| `APP_BASE_URL` | `z.string().url().optional()` | OAuth/discovery/confirm_url 對外輸出的 base（含 scheme，如 `https://be2-mcp.stage.kkday.com`）。**未設時 fallback `http://127.0.0.1:${port}`**（現行行為）。 |

`Config` interface 加 `bindHost: string`、`publicBaseUrl: string`。`loadConfig` 尾段計算：
```ts
const publicBaseUrl = e.APP_BASE_URL?.replace(/\/$/, '')
  ?? `http://127.0.0.1:${e.APP_PORT}`
```
`APP_ALLOWED_HOSTS` **不進 EnvSchema**（維持現狀由 `hostGuard.ts` 直接讀 `process.env`），避免動到 config 契約；spec §9 註明部署要設它。

**scheme 由 env 決定**：ingress 做 TLS termination（HTTPS 對外、HTTP 到 Pod）時，`APP_BASE_URL` 輸出 `https://`，符合 OAuth 2.1 對 authorization server 走 HTTPS 的要求（DevOps 決定暴露/TLS 拓撲，程式只忠實輸出注入值）。

## 5. 阻斷 #1 — bind（`src/index.ts`）

`app.listen(config.port, '127.0.0.1', …)` → `app.listen(config.port, config.bindHost, …)`。log 行的 `http://127.0.0.1:${port}` 改印 `config.publicBaseUrl`（避免誤導）。

## 6. 阻斷 #3 — public base URL（`src/server/app.ts`）

- `app.ts:142` `const baseUrl = 'http://127.0.0.1:${config.port}'` → `const baseUrl = config.publicBaseUrl`。
- `app.ts:255` `buildDiscoveryRouter({ baseUrl: 'http://127.0.0.1:${config.port}' })` → `buildDiscoveryRouter({ baseUrl: config.publicBaseUrl })`。

下游 `l2Context`/`appPipeline`/`toolPipeline`/`discoveryRoutes` 皆已吃傳入的 `baseUrl` 參數，**無需再改**。回歸測試驗：注入 `APP_BASE_URL` 時，`GET /.well-known/oauth-authorization-server` 的 `issuer/authorization_endpoint/token_endpoint/registration_endpoint` 與 `/.well-known/oauth-protected-resource` 的 resource 全部帶該 base；未注入時維持 loopback。

## 7. 阻斷 #2 — Host 白名單

**零 code**。部署設 `APP_ALLOWED_HOSTS=be2-mcp.stage.kkday.com`（DevOps 給定域名）。已由 `hostGuard.ts:43-44` 生效。spec §9 列為必設 env。

## 8. readiness 探針（`src/server/app.ts`）

新增 `GET /readyz`：對 `buildApp` 已在 scope 的 `db` 跑 `db.prepare('SELECT 1').get()`，成功回 `200 {status:'ready'}`，拋錯回 `503 {status:'not-ready'}`。**不查下游**（auth/gateway 短斷是 per-request 暫時錯，不該把 pod 拉出 rotation）。`/healthz` 維持純 liveness 不動。

**掛載位置（事實查核修正）**：`/healthz`（`app.ts:251`）是掛在 `app.use(buildHostGuard())`（`app.ts:252`）**之前**、靠 Express 路由順序豁免 Host guard 的，非靠 guard 內部判斷。故 `/readyz` 比照辦理——緊接 `app.ts:251` 之後、`buildHostGuard()` 之前註冊即天然豁免，**不需改 `hostGuard.ts`**。（`hostGuard.ts:30` 內部對 `/healthz` 的豁免因此其實是防禦性冗餘，本波不動它。）

## 9. SIGTERM graceful shutdown（`src/index.ts`）

**三個並存的關閉危害（agy round 1 抓到，全採納）必須一起處理，否則 graceful shutdown 反而製造 incident：**

1. **scheduler 進行中 tick 不能被硬切**：`scheduler.ts:116-129` 的 `start()` 回傳的 stopper 只 `stopped=true` + `clearTimeout` 下一輪，**不等待正在跑的 `tick()`**。tick 內 `runOne`→`executeChangeSet` 會 `await` gateway 呼叫；若此時 `db.close()`+`process.exit()` 打斷，await 一 resolve 就對已關閉的 db 寫入 → 「database is closed」，且該 change-set 卡在 `executing`（雖有 `auditStranded()` 開機時記警示、不會靜默壞資料，但每次 rolling update 撞上就要人工複核）。
2. **OTel flush 會被同步 exit 砍斷**：`otel.ts:16` 自帶一個 SIGTERM listener 呼叫 async `sdk.shutdown()`；若 index.ts 的 shutdown 以同步 `process.exit(0)` 收尾，flush 未完成 process 就死，關機當下最關鍵的 trace 反而遺失。且兩個 SIGTERM listener 會競爭。

**修法（改動 `src/index.ts` + `src/core/schedule/scheduler.ts` + `src/otel.ts`，不碰 tick 業務邏輯）：**

- **`scheduler.ts`**：`start()` 回傳型別由 `() => void` 改為 `() => Promise<void>`——loop 內把當前 tick 的 promise 存入 `current`，stopper 為 `async () => { stopped = true; if (timer) clearTimeout(timer); await current }`。tick 的**業務邏輯完全不動**，只多追蹤 in-flight promise。
- **`otel.ts`**：改 module-level `let sdk`；`initOtel` 啟動它；新增 `export async function shutdownOtel(): Promise<void> { await sdk?.shutdown() }`；**移除 `otel.ts:16` 自帶的 SIGTERM listener**（關機協調統一由 index.ts 主導，避免雙 listener 競爭 + 同步 exit 砍 flush）。
- **`index.ts`**：hoist db（原 `index.ts:8` inline），單一 shutdown 協調者：
```ts
const db = openDb(config.dbPath)          // hoist（原本 inline 在 buildApp 呼叫裡）
const app = buildApp({ config, db })
const server = app.listen(config.port, config.bindHost, () => { … })
const stopScheduler = (app.locals.startScheduler as () => () => Promise<void>)?.()
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true
  // 硬逾時保險必須在此 arm（非頂層）——放頂層會在開機即計時，且 Express server 讓 event loop
  // 活著、.unref() 救不了 → 開機 GRACE_MS 後保證 hard-exit。arm 在 shutdown 內才只在收到訊號後計時。
  setTimeout(() => process.exit(0), GRACE_MS).unref()
  await stopScheduler?.()      // 等進行中的 tick settle（此後不再有 scheduler 對 db 的寫入）
  server.close(async () => {   // 停收新連線、排空進行中 HTTP 請求
    await shutdownOtel()       // await 完成 trace flush（不能同步 exit）
    db.close()                 // 此刻已無 in-flight writer，安全 WAL checkpoint + 關檔
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```
**硬逾時保險**：`GRACE_MS` 略小於 k8s `terminationGracePeriodSeconds`（DevOps 設，建議 ≥30s）——避免某個 tick 或連線卡死時 pod 永不退出。**它 arm 在 `shutdown()` 內**（如上），只在收到 SIGTERM/SIGINT 後才計時；**絕不可放頂層**（會開機即計時，`.unref()` 對「Express server 已讓 loop 活著」無效 → 開機 GRACE_MS 後保證 hard-crash）。若 tick 超過 grace 被 SIGKILL，仍由既有 `auditStranded()` 開機警示接手（殘餘風險，非本波消滅目標）。

## 10. build / 容器化

### 10.1 build 與輸出路徑（agy round 1 修正：`rootDir` 決定 emit 路徑）

**關鍵事實**：`tsconfig.json` 的 `include: ["src","scripts","eval","tests"]` 是多個 sibling 目錄且**未設 `rootDir`** → tsc 把共同祖先 `.`（專案根）當 rootDir → `src/index.ts` emit 成 **`dist/src/index.js`**（不是 `dist/index.js`），`scripts/oauth-purge.ts` emit 成 `dist/scripts/oauth-purge.js`。若照原本寫 `node dist/index.js` 會開機即 `MODULE_NOT_FOUND`。同時 `eval`/`tests` 也會被編進 dist（多餘、且把 test-only import 帶進 image）。

**修法**：新增 **`tsconfig.build.json`**（build 專用，不動原 `tsconfig.json`——後者仍供 `typecheck`/`vitest` 用全 include）：
```jsonc
{ "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false },
  "include": ["src", "scripts"] }        // 排除 eval/tests；rootDir 仍推為 src+scripts 共同祖先 "." → dist/src、dist/scripts
```
`package.json`：
- 新增 `build`: `tsc -p tsconfig.build.json && npm run build:ui`（先 emit `dist/src`+`dist/scripts`，再由 esbuild 產 `dist/ui/*.html`；三者不同子路徑不衝突）。
- 新增 `start`: `node dist/src/index.js`。
- `ci` 不動（`build:ui && typecheck && test`；`typecheck` 仍是 `tsc --noEmit` 走全 include）。

> **UI 路徑不受影響（已查證）**：`appResources.ts:15` 用 `join(process.cwd(), 'dist', 'ui')`（**cwd-based**，非相對 compiled 檔位置）→ 容器 `WORKDIR /app` + `build:ui` 產物在 `/app/dist/ui` → server 即使在 `dist/src/index.js` 也照樣找到面板。DB 路徑走絕對的 `APP_DB_PATH`（PVC 掛載點），亦 cwd-無關。
> **驗證點（實作期先跑）**：`npm run build` 後 `node dist/src/index.js` 能起；`dist/scripts/oauth-purge.js`、`dist/ui/*.html` 皆存在；`dist/eval`、`dist/tests` 不存在。

### 10.2 Dockerfile（multi-stage）
```dockerfile
# builder
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci                       # 編/取 better-sqlite3 prebuild（glibc）
COPY . .
RUN npm run build                # tsc + build:ui → dist/

# runtime
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev            # 只 prod deps（不含 tsx/esbuild/vitest）
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "dist/src/index.js"]     # rootDir=. → 進入點在 dist/src/（見 §10.1）
```
- **base image `node:22-bookworm-slim`**：glibc，對齊 `better-sqlite3` prebuild（避開 alpine musl 無 prebuild → 需 build toolchain 的坑）。DevOps 可換等價 glibc base。
- runtime `npm ci --omit=dev` 會重編 `better-sqlite3`（prebuild 取得），故 runtime 仍是 glibc base。
- 非 root（`USER node`）。

### 10.3 Node 版本釘定
- `.nvmrc` = `22`；`package.json` 加 `"engines": { "node": ">=22 <23" }`。

### 10.4 oauth-purge cron 進入點
`tsc build` 已 emit `dist/scripts/oauth-purge.js`。k8s CronJob 執行 `node dist/scripts/oauth-purge.js`（DevOps 寫 CronJob，本 spec 只保證編譯產物存在 + runbook 記錄指令）。

## 11. 給 DevOps 的 env / 基礎設施契約（寫進 runbook，非本 repo manifests）

**必設 env**：`APP_ENV=stage`、`API_AUTH_SERVICE_KEY`（k8s Secret，需向 auth-service team 申請）、`APP_BIND_HOST=0.0.0.0`、`APP_BASE_URL=https://<域名>`、`APP_ALLOWED_HOSTS=<域名>`、`APP_DB_PATH=<PVC 掛載點>`。
**建議 env**：`OTEL_MODE=otlp` + `OTEL_EXPORTER_OTLP_ENDPOINT=<collector>`。
**務必不要設**：`APP_DEV_PANEL`。
**基礎設施**：
- **PVC**：**RWO block volume（ext4/xfs），非 NFS**——SQLite WAL 在網路檔案系統上鎖語義不安全。單副本 + RWO → 安全。加密 storage class（承載明文 token，見 §12）。備份 `audit_log`（合規）。
- **replicas: 1**（見 §13 為何不多副本）。
- **probe**：liveness=`/healthz`、readiness=`/readyz`。`terminationGracePeriodSeconds ≥ 30`。
- **egress NetworkPolicy**：放行 stage auth-service / api-gateway（443）+ otlp collector。
- 暴露/域名/TLS termination、image registry、CI/CD pipeline：DevOps 決定（`stage-eks-migration-devops.md` §9）。

## 12. 明文 token at-rest — 交 DevOps 加密 PVC

`be2_identities` 存明文 access/refresh（`db.ts:81-82`）。**本波不做 app 層信封加密**（Q6 定案）：符合 Option 1「憑證不離境」（token 只在 KKday 內網 store）、與 dev-tools 亦明文存 Passport token store 一致；引入金鑰管理/輪替超出 Phase A「先跑起來」目標。緩解 = **DevOps 加密 storage class + PVC 存取控管**（§11）。列為 Phase C 之後可再評估的強化項，非本波交付。

## 13. 邊界（寫給使用者與 reviewer 的明話）

- **不做 HA / 多副本**：`inventorySetting/executor.ts:14-23` 的 in-process mutex、`auth/tokenManager.ts:16-22` 的 refresh single-flight、`app.ts:168,182,190` 的 in-memory MCP session / rate budget，多副本會壞（lost update / 撞 refresh rotation family-revoke / session 404）。scheduler 雖已為多副本設計（DB CAS 認領），仍受單檔 SQLite 限制。→ **replicas=1 是硬前提**，解開它 = Phase C（SQLite→Postgres + 3 原語→Redis + session→共用 store）。
- **不動 store schema / migration 機制**：`db.ts` 的 `CREATE TABLE IF NOT EXISTS` + PRAGMA-based ALTER 是既有技術債，單節點可運作；本波不重構（動它有回歸風險，且真 migration 框架屬 Phase C 換引擎時一併做）。
- **不做 Postgres / Redis**（Q1）。
- **不寫 k8s manifests**（Q2，交 DevOps）。
- **live stage EKS e2e 標 PENDING**（Q7）：依賴 DevOps 部署 + `API_AUTH_SERVICE_KEY`（repo 目前無）+ stage 寫入權限（前面 phase 卡 403），本 session 無法獨力跑完。沿用 Phase 2a/2b/3a 的 PENDING 慣例。

## 14. 驗收（我方可控，Q7）

1. `npm run ci` 綠（`build:ui + typecheck + test`），含新回歸測試（§15）。
2. `npm run build` 產出 `dist/src/index.js`、`dist/scripts/oauth-purge.js`、`dist/ui/*.html`；`dist/eval`、`dist/tests` 不存在。`node dist/src/index.js` 能起。
3. `docker build` 成功；`docker run` 起容器（注入 `APP_ENV=stage` + 假 service key + `APP_BASE_URL=https://example` + `APP_BIND_HOST=0.0.0.0` + `APP_ALLOWED_HOSTS=example` + tmp DB path）：
   - `curl /healthz` → 200；`curl /readyz` → 200。
   - `curl -H 'Host: example' /.well-known/oauth-authorization-server` → endpoints 全帶 `https://example`。
   - `curl -H 'Host: evil' /mcp` → 403（Host guard 仍擋非白名單）。
   - `docker stop`（送 SIGTERM）→ 容器在 grace period 內乾淨退出（log 見 scheduler in-flight tick await 完成 → server 關閉 → otel flush → db 關閉，無 uncaught、無「database is closed」）。
4. Dockerfile + `.nvmrc` + `engines` + 更新後 runbook 進 repo。
5. **live stage EKS e2e = PENDING**（§13）。

## 15. 測試計畫（TDD）

新增/擴充：
- `tests/config.test.ts`（擴充）：`APP_BIND_HOST` 預設 `127.0.0.1`、可覆蓋；`APP_BASE_URL` 未設 fallback loopback、設了去尾斜線並生效；錯 URL → parse 失敗（不印值）。
- `tests/publicBaseUrl.test.ts`（新）：注入 `APP_BASE_URL`，打 `/.well-known/oauth-authorization-server` + `/.well-known/oauth-protected-resource`，斷言所有輸出 URL 用該 base；未注入時用 loopback。
- `tests/readyz.test.ts`（新）：`/readyz` DB 正常回 200、db.close 後回 503；`/readyz` 與 `/healthz` 豁免 Host guard（帶非白名單 Host 仍 200）。
- `tests/hostGuard.test.ts`（擴充，若已存在則加案例）：`/readyz` 豁免；設 `APP_ALLOWED_HOSTS` 後部署域名放行、其餘 403。
- graceful shutdown（單元測試，注入 spy，不需真 SIGTERM）：
  - `scheduler.ts`：stopper 現在回傳 Promise——驗「有 in-flight tick 時 `await stop()` 會等該 tick settle 才 resolve」（用一個掛在 await 的 fake gateway/tokenManager 卡住 tick，斷言 stop 的 promise 在 tick resolve 前不 settle）。
  - `otel.ts`：`shutdownOtel()` 在 `off` 模式即刻 resolve（無 sdk）；`console/otlp` 模式呼叫 `sdk.shutdown()`。
  - `index.ts` shutdown 序：驗呼叫順序 = `await stopScheduler` → `server.close` → `await shutdownOtel` → `db.close` → `exit`；且 db.close **不早於** stopScheduler 完成（避免 in-flight tick 對已關閉 db 寫入）。

## 16. 非目標

- Postgres / RDS、Redis / 分散式鎖、多副本 / HA（Phase C）。
- k8s manifests / Helm / kustomize（DevOps）。
- app 層 token 加密、金鑰輪替（§12）。
- CI/CD pipeline、image registry 選型、域名/TLS 拓撲（DevOps §11）。
- prod 環境（本波只 stage；`config.ts:24` 的 prod preset key 名仍待正式確認，非本波）。
- store schema / migration 機制重構（§13）。

<!-- agy-peer-reviewed: 2026-08-27T06:45:49Z rounds=3 verdict=approved -->
