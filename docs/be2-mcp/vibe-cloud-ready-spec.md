# 上雲環境約束（Cloud-Ready Spec）— 給 AI coding agent 的參考

> **這份文件的用途**：在你開始寫任何 code 之前先讀完。你寫出來的專案最終會被容器化，部署到公司內部的
> **AWS EKS（Kubernetes）** 上。以下是那個環境的硬條件。**只要一開始就照著做，上雲時幾乎不需要改動；
> 沒照做的部分，屆時都是大幅重構。**
>
> **使用方式（給人類）**：把這份檔案放進專案根目錄（例如 `docs/cloud-ready-spec.md`），並在
> `CLAUDE.md` / `.cursorrules` / agent 的系統提示裡加一句：
> 「本專案最終部署在公司內部 EKS，開發任何功能前先讀 `docs/cloud-ready-spec.md`，所有設計必須符合其約束。」

---

## 0. 目標環境是什麼（一段話）

容器（Docker image）→ 推進公司內部 registry → 由 GitOps + ArgoCD 部署到 **EKS 的一個共用 namespace**。
對外走 ALB Ingress，網域是 `<app>.sit.<公司網域>`，**僅公司內網 / VPN 可達**。資料庫是 **AWS RDS
PostgreSQL**，檔案放 **S3**，排程用 **Kubernetes CronJob**，環境變數／secret 由平台的 config-manager
注入成 k8s Secret。

**它不是** Vercel / Netlify / Firebase / Supabase 這類 PaaS。所以：**任何依賴「某個 PaaS 才有的能力」
的設計，最後都要拆掉重寫。** 這是整份文件最重要的一句話。

---

## 1. 硬約束速查（12 條）

| # | 約束 | 沒做的後果 |
|---|---|---|
| 1 | 一個容器、一個 process、監聽 `PORT` 且綁 `0.0.0.0` | 起不來 / 健康檢查失敗 |
| 2 | 所有設定來自環境變數；secret **只在 runtime** 注入 | secret 進 image、換值要重 build |
| 3 | 完全無狀態：pod 隨時被殺、可能多份 | 登入掉、資料不一致、上傳檔消失 |
| 4 | 不寫本機磁碟（除 `/tmp`）；檔案一律進物件儲存 | 重啟即失、多 pod 看不到彼此的檔 |
| 5 | 不用 SQLite / 檔案型 DB / 檔案型佇列 | 無法水平擴充、資料遺失 |
| 6 | DB = 外部 PostgreSQL，連線資訊來自 env，需 TLS | 連不上 |
| 7 | schema 變更 = repo 內 forward-only SQL migration；**runtime 不做 DDL** | 上不了、權限被拒 |
| 8 | 排程 = 對外可觸發的 HTTP endpoint（帶 bearer、idempotent），**不是** in-process timer 或 PaaS cron 宣告 | 排程不會跑 |
| 9 | 雲端資源（S3 等）用 SDK **預設憑證鏈**，程式內零 key | 需要發 access key，安全審不過 |
| 10 | log 只寫 stdout/stderr | 看不到 log |
| 11 | 一個**無外部依賴**的 health endpoint | DB 一抖，pod 就無限重啟 |
| 12 | 平台專屬能力（auth / storage / mail / AI / cron）一律包在 adapter 後面用 env 切換 | 搬遷 = 重寫 |

---

## 2. 逐項要求

### 2.1 容器與啟動

**DO**
- 讀 `process.env.PORT`（或同語言等效），預設 `3000`（Node）或 `8080`（靜態站／其他）；**綁 `0.0.0.0`，不是 `127.0.0.1`**。
  - 容器裡的 `127.0.0.1` 只指容器自己，綁它等於「外面一律連不進來」：k8s 的 probe 打的是 pod IP → pod 永遠不 Ready。
  - 本機開發時瀏覽器走 loopback 所以完全正常，**這個錯只會在容器化之後才爆**，而且症狀是「pod 起不來」，不像網路綁定問題。
  - 常見預設就是錯的（要明確指定）：Flask `app.run(host="0.0.0.0")`、Django `runserver 0.0.0.0:8000`、uvicorn/gunicorn `--host 0.0.0.0`、Vite `--host 0.0.0.0`、Next.js `HOSTNAME=0.0.0.0`、PHP `php -S 0.0.0.0:8080`。Node `http`/Express 與 Go `":8080"` 省略 host 時本來就是所有介面，**只要別手寫 `localhost` / `127.0.0.1`**。
  - 這不等於對外暴露：pod IP 在叢集內部網段，對外由 Service + Ingress 決定。
- multi-stage Dockerfile：build 階段裝完整依賴，runtime 階段只留 production 產物與 production 依賴。
- **以非 root 使用者執行**；假設檔案系統唯讀，只有 `/tmp` 可寫。
- 鎖定依賴：lockfile 進版控，安裝一律 `--frozen-lockfile` / `--locked` 等價旗標。base image 釘住 major（例：`node:22-alpine`），**不用 `latest`**。
- 寫 `.dockerignore`：至少排除 `.git`、`node_modules`、`.env*`、測試、文件、build 產物。
- 處理 **SIGTERM**：收到後停止接受新請求、把手上的請求做完再退出（平台會給約 30–45 秒的排空時間）。
- **build 過程不需要任何 secret**，也不需要連內網。build 只能用公開套件源（若必須用私有源，要事先講）。

**DON'T**
- 不要在 `CMD` 裡跑 migration、seed、`chown -R`、或任何「順便初始化」的動作。容器啟動只做一件事：起服務。
- 不要在 image 裡放 `.env`。
- 不要假設有 shell 工具（`curl`、`bash`）可用；要用就自己裝或改用語言內建能力。

### 2.2 設定與 secret（最容易踩的一段）

把每個設定值分成三類，並在 `.env.example` 裡**逐個註明屬於哪一類、用途是什麼**：

| 類別 | 例子 | 注入時機 | 改值成本 |
|---|---|---|---|
| **build-time 公開值** | 前端 bundle 需要的 API base URL、feature flag（如 `NEXT_PUBLIC_*` / `VITE_*`） | build 時 `--build-arg` | **要重新 build image** |
| **runtime secret** | DB 帳密、API key、`AUTH_SECRET`、`CRON_SECRET` | k8s Secret → 容器 env | 改 secret + 重啟即可 |
| **runtime 非機密** | log level、feature flag、bucket 名、region | 同上 | 同上 |

**DO**
- 所有設定都走環境變數。不要 `config.production.json` 這種「一個環境一份檔」。
- **對外 base URL 一律來自 env**（`APP_BASE_URL` 之類），OAuth callback、寄信連結、絕對路徑都用它組。
- **盡量減少 build-time 公開值**。能挪到 runtime 就挪（例：後端讀 env 再回傳給前端 / 用 runtime config endpoint），因為 build-time 值改一次就要重跑一次 pipeline。
- 缺少必要 env 時**啟動就大聲失敗**（fail fast，訊息列出缺哪幾個），不要 fallback 到某個預設值後默默跑錯環境。
- `.env.example` 進版控且維持最新 —— 這是交給平台團隊設定 config-manager 的**唯一依據**。

**DON'T**
- 不要把 secret 當 build-arg 傳（會留在 image layer；前端框架還可能把它編進 bundle）。
- 不要 commit `.env` / `.env.local`。
- 不要用 `if (NODE_ENV === 'production')` 去猜 host、DB、bucket。環境差異一律用 env 表達。

### 2.3 無狀態（多副本 + 隨時被殺）

**DO**
- session / 登入狀態放 **簽章 cookie（JWT）或 DB**，不要放 process 記憶體。
- 需要跨請求共享的東西（rate limit 計數、鎖、佇列、快取）放 **DB 或外部 cache**。行程內記憶體快取只能是「有就更快、沒有也正確」的最佳努力。
- 長時間工作（>30 秒）不要塞在 HTTP 請求裡完成：寫一筆 job 狀態進 DB，讓排程 endpoint 分批處理，前端輪詢進度。**假設 ALB 有約 60 秒的 idle timeout。**
- 回應送出後的「背景繼續做」不可靠（pod 可能立刻被回收）→ 一樣改成 job。

**DON'T**
- 不要用 `setInterval` / 背景 thread 當排程（多副本會重複跑，縮容時直接消失）。
- 不要用行程內 in-memory 佇列、in-memory 鎖、in-memory 上傳暫存。

### 2.4 檔案與物件儲存

**DO**
- 使用者上傳、產生的報表 / 圖片 / 匯出檔 → 一律進 **S3**。程式只需要 **bucket 名 + region 兩個 env**。
- 憑證走 **AWS SDK 預設憑證鏈**（平台會把 IAM role 綁到 pod 的 ServiceAccount）。程式**不要**讀 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`，也不要提供「填 key」的設定。
- 需要讓瀏覽器直接下載／上傳時用 **presigned URL**。
- 暫存檔只寫 `/tmp`，用完刪掉，且不能假設下一個請求還看得到它。

**DON'T**
- 不要用平台專屬的 storage SDK（例如某 BaaS 的 Storage client）當唯一實作 —— 若本機開發階段要用，請包在 §2.8 的 adapter 後面。

### 2.5 資料庫

**DO**
- 目標是 **AWS RDS PostgreSQL**。連線參數用**分開的 env**：`DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`，另外允許 `DATABASE_URL` 存在時直接短路使用（方便本機）。密碼帶原始值，由程式自己 URL-encode。
- **TLS 必開**。RDS 憑證鏈用 `sslmode=no-verify` / 等價設定即可（`require` 在某些 driver 會被當成 verify-full 而失敗）。
- **連線池要小**（單 pod 個位數）。`pod 數 × pool 上限` 必須遠低於 RDS 的 max_connections。
- app 的 DB 帳號**只有 CRUD 權限**。任何 `CREATE` / `ALTER` / `DROP` 都不能在 runtime 執行。
- 只用標準 PostgreSQL 功能。需要的 extension 要**列出來事先確認**（不能假設 `pgvector`、`postgis` 等已裝）。
- 授權邏輯寫在**應用層**。不要把「誰能看什麼」建在依賴某個 BaaS 身分函式的 DB 規則上（那些函式搬到 RDS 就不存在）。

**Schema 變更（migration）**
- 目錄：`db/migrations/NNNN_<描述>.sql`，四位數零補、**檔名即版本、字典序執行**。
- 一律 **forward-only、additive**：沒有 down migration；不要改欄位型別改到不能相容；先加新欄位、雙寫、再清舊的。
- **已經套用過的檔案永不改名、永不修改內容**。
- 每支檔案跑在**單一 transaction** 內 → **不能用 `CREATE INDEX CONCURRENTLY`、`VACUUM`、`REINDEX`**。
  - 原因是 PostgreSQL 自己禁止：`CONCURRENTLY` 需要在過程中多次自行 commit，包在 `BEGIN` 裡會直接報 `cannot run inside a transaction block`（SQLSTATE 25001）。同家族還有 `DROP INDEX CONCURRENTLY`、`REINDEX CONCURRENTLY`、`CREATE DATABASE`、`ALTER SYSTEM`。
  - 普通 `CREATE INDEX` 會在該表持 `SHARE` 鎖（讀可以、**寫被擋**）直到建完。內部系統的資料量通常是秒級，**直接用普通 `CREATE INDEX`**；`CONCURRENTLY` 是為了幾千萬列的大表才存在。
  - 另一個別自動化它的理由：`CONCURRENTLY` 失敗會留下 **INVALID 索引**（不被查詢使用卻持續拖慢寫入），要人工 `DROP` 清掉 —— 天生無法原子回滾，不適合放在無人盯著的 CI 步驟。
  - 真的需要時：拆成獨立檔並讓 runner 支援跳過 transaction（如 `-- migrate:no-transaction` 檔頭），或由高權限帳號在維護時段手動執行後，**在 `schema_migrations` 補一筆對應檔名**讓 runner 略過。最好的做法是趁表還小時就用普通 `CREATE INDEX` 建好。
- 提供一支 `db:migrate` 指令（零／少依賴的 runner）：從 env 讀連線、取 advisory lock、`CREATE TABLE IF NOT EXISTS schema_migrations`、只跑沒記錄過的檔案、成功後記錄 → **重複執行安全**。CI 會呼叫它。
- 若 DB 已有既有 schema，第一支檔案當 baseline，並提供一次性「標記為已套用」的 SQL。

### 2.6 認證與網路邊界

**DO**
- OAuth（Google 等）走**瀏覽器 redirect** 沒問題；callback URL 由 env 組出。
- 在反向代理後面 → **信任 `X-Forwarded-*`**（框架要開對應開關），否則會產生 http 的 redirect URL 或判錯 host。
- cookie 用 `Secure` + `HttpOnly` + 適當 `SameSite`。
- 需要被外部系統呼叫的介面，用**共享 token 驗證**（header 帶 bearer / service token），並做常數時間比對。

**DON'T**
- **不要設計「依賴外部服務主動打進來」的流程**（第三方 webhook、payment callback、SaaS push 通知）。這個環境**只有內網可達**，外部打不進來。需要同步外部狀態就改成**由我方定時去拉**。
- 不要假設固定的對外 IP（要 allowlist 就得另外申請）。
- 不要假設任意外部網域都連得出去 —— 把 app 會呼叫的**外部 host 清單寫在 README**，交由平台確認 egress。

### 2.7 排程 / 定期任務

平台的做法是：k8s CronJob 依時間去打你的 HTTP endpoint（cluster 內部呼叫，帶共享 secret）。所以：

**DO**
- 每個定期任務做成一支 endpoint：`/api/jobs/<name>`（或 `/api/cron/<name>`），驗 `Authorization: Bearer $CRON_SECRET`。
- **idempotent**：同一時間被打兩次、或連續被打多次，結果都要正確。
- **有界執行時間**：單次處理一批（例如 10–50 筆）就回，回傳處理了幾筆；剩下的等下一次。單次控制在 **5 分鐘內**。
- 回傳 JSON 摘要並把結果寫進 log（處理數、失敗數）。
- 把「需要哪些排程、多久一次、可接受的時段」寫在 README。**假設夜間與假日可能縮容 → 排程一律排在上班時段內。**
- 時間：pod 預設 **UTC**。DB 存 UTC，任何跟「幾點」有關的商業邏輯都要顯式帶時區，不要依賴系統 local time。

**DON'T**
- 不要用 PaaS 專屬的排程宣告檔（那類檔案在 EKS 上不會被讀）；要留給本機／舊平台用可以，但**不能是唯一機制**。
- 不要寫「只能剛好執行一次」的排程邏輯（要容忍重複與偶發延遲）。

### 2.8 平台鎖定：一律包一層 adapter

這是「上雲要不要大改」的分水嶺。凡是以下能力，**先定義一個介面，再放兩個實作，用 env 切換**：

| 能力 | 本機／舊平台可能用 | 上雲後 | 切換 env（範例） |
|---|---|---|---|
| 認證 | BaaS 內建 auth | 自管 OAuth（Auth.js 等）+ JWT | `AUTH_PROVIDER=baas\|oauth` |
| 檔案儲存 | BaaS Storage | S3（預設憑證鏈） | `STORAGE_PROVIDER=baas\|s3` |
| 資料存取 | BaaS client SDK | 直連 Postgres（SQL / 輕量 ORM） | `DATABASE_URL` / `DB_*` |
| 排程 | PaaS cron | HTTP job endpoint + k8s CronJob | 無（endpoint 本來就在） |
| 寄信 / 通知 | 任一 SaaS | 同一介面換 provider | `MAIL_PROVIDER=...` |

**DO**：業務程式只依賴自己定義的介面（`storage.put()`、`auth.currentUser()`），不要在 20 個檔案裡直接 import 廠商 SDK。
**DON'T**：不要讓廠商的資料模型／權限模型滲進商業邏輯（例如把授權寫成該 BaaS 的 policy DSL）。

### 2.9 Log、錯誤、健康檢查

**DO**
- log 寫 **stdout / stderr**，一個事件一行（建議 JSON）。帶上請求 id / 使用者 id / 耗時。
- **不要**寫 log 檔、不要做 log rotation。
- log 裡不要出現 token、密碼、完整個資。
- error tracking（Sentry 之類）的 DSN 走 env，**沒設就安靜停用**，不要因此啟動失敗。
- 健康檢查：`GET /health`（或 `/api/health`）回 `200 {"status":"ok"}`，**不查 DB、不查外部服務、不需登入**。
  - 理由：liveness 和 readiness 用同一支。若它依賴 DB，DB 一抖就變成全體 pod 反覆重啟 —— DB 故障應該表現為請求錯誤，不是服務消失。
- 想暴露依賴狀態就另開一支 `/health/deps`，且**不要**接到 k8s probe 上。

### 2.10 命名與 repo 結構

- repo 名用 **kebab-case**，且**之後不要改**：它同時會是 image repository 名、k8s manifest 目錄名、Deployment / Service 名。四處必須一致。
- repo 根目錄要有：`Dockerfile`、`.dockerignore`、`.env.example`、`db/migrations/`（若有 DB）、README 的「部署備註」段落。

---

## 3. 部署流程長什麼樣（agent 只需知道結論）

```
push 到 main
   → CI 建 image，tag = commit 短 SHA，推進內部 registry
   → （若有 DB）CI 對 DB 套用未執行的 migration
   → CI 自動更新 GitOps repo 裡的 image tag
   → ArgoCD 自動同步到 EKS（auto-sync、self-heal）
```

由此推導出的行為約束：

- **image 不可變**：同一個 commit = 同一個 image。要換行為就 commit，不要想在容器裡改東西。
- **`kubectl edit` 沒用**：GitOps 會把手改的內容同步回去。
- **回滾 = 把 image tag 指回上一個 SHA**，所以**每個 commit 都必須是可部署的**（別把 repo 推到「壞掉但等下就修」的狀態）。
- **migration 失敗會擋住部署**（刻意設計：不讓新 code 打到舊 schema）→ migration 必須自己保證安全、可重跑。
- **新增 / 修改 env 需要平台團隊介入**（設進 config-manager），不是你 push 一下就有 → 新增 env 時要**批次提出、附用途**，並確保「舊 env 缺新值時程式仍能啟動」或明確標記為必填。

---

## 4. 反模式速查表（看到就改掉）

| 反模式 | 為什麼不行 | 改成 |
|---|---|---|
| 寫檔到專案目錄 / `./uploads` | 非 root、image 唯一、多 pod 不共享 | S3 |
| SQLite / JSON 檔當資料庫 | 無法多副本、重啟即失 | PostgreSQL |
| `setInterval` 跑定期任務 | 多副本重複、縮容消失 | job endpoint + 平台 CronJob |
| in-memory session / 快取當真相 | 多副本不一致 | cookie JWT / DB |
| 硬寫 `http://localhost:3000` | 換環境就錯 | `APP_BASE_URL` env |
| 把 secret 當 build-arg | 留在 image layer | runtime env |
| runtime 執行 `CREATE TABLE` | app 帳號無權限 | `db/migrations/` + CI |
| health endpoint 去查 DB | DB 抖動 → 全體重啟 | 無依賴的 `/health` |
| 依賴第三方 webhook 打進來 | 環境只有內網可達 | 改為定時拉取 |
| 依賴 PaaS 專屬檔案（cron 宣告、edge runtime、部署設定） | EKS 不讀 | 通用機制 + adapter |
| 直接 import 廠商 SDK 散落各處 | 搬遷＝重寫 | 介面 + env 切換 |
| 請求裡做 3 分鐘的工作 | ALB timeout、pod 被回收 | job + 進度輪詢 |
| 缺 env 時 fallback 到預設 host | 默默連錯環境 | fail fast |

---

## 5. 上雲前自我檢查（agent 可逐項驗）

```
□ docker build 在「沒有任何 secret」的情況下成功
□ docker run 只靠環境變數就能起來，且監聽 0.0.0.0:$PORT
□ 容器以非 root 執行；程式沒有寫入 /tmp 以外的路徑
□ GET /health 回 200，且在 DB 關掉時仍然回 200
□ 全庫搜尋：沒有 hardcoded 的 localhost / 對外網址 / 金鑰 / 密碼
□ .env.example 涵蓋程式讀到的每一個 env，且標了 build-time / runtime-secret / runtime-plain
□ 把 DB 換成一個全新的空 Postgres，跑一次 migrate 能建出完整 schema；再跑一次不會失敗
□ 程式沒有任何 DDL 語句在 runtime 路徑上
□ 所有定期任務都能用 `curl -H "Authorization: Bearer $CRON_SECRET" <endpoint>` 手動觸發，且重複觸發安全
□ 兩個副本同時跑不會壞（登入、上傳、排程、計數）
□ 檔案上傳走物件儲存介面，程式內沒有 AWS key
□ 廠商 SDK 只出現在 adapter 檔案裡
□ 對外呼叫的 host 清單、需要的排程時段、需要的 env，都寫進 README
```

---

## 6. 交給平台團隊時要一起附上的資訊

1. **`.env.example`**：每個變數的用途 + 分類（build-time / runtime secret / runtime 非機密）+ 哪些是必填。
2. **服務基本資料**：容器 port、health endpoint 路徑、期望的網域名稱。
3. **DB 需求**：是否需要 DB、需要哪些 extension、是否有既有資料要匯入（有的話提供 dump + 驗證用的 row count）。
4. **物件儲存需求**：需要幾個 bucket、大概用量。
5. **排程需求**：每支 job 的路徑、頻率、可接受時段、單次預期耗時。
6. **對外連線清單**：會呼叫哪些外部 host / port（OAuth、AI API、通知服務…）。
7. **資源預估**：CPU / 記憶體需求、預期併發。

---

**一句話總結**：把它當成「一台隨時會被重建、只有環境變數、沒有本機磁碟、只能被內網存取的無狀態機器」來寫，
上雲就只是換一組 env 而已。
