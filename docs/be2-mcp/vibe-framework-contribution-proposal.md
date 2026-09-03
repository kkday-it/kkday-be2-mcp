# be2-mcp × kkday-vibe-framework — 登記與貢獻提案

> **狀態**：提案，尚未執行任何動作。**未修改** `kkday-it/kkday-vibe-framework`（只用 `gh api` 唯讀讀取）。
> 本檔只回答「be2-mcp 該怎麼跟框架搭上關係」，具體 PR 動手前，請先看第 4 節「建議行動清單」逐項拍板。
> 讀取依據：`gh api repos/kkday-it/kkday-vibe-framework/contents/<path>`，master 分支，2026-08-26 讀取。所有引用皆附檔案路徑。

---

## 0. 結論摘要（TL;DR）

1. **登記本身很便宜、可以先做**：框架 M1 的 registry 是「主動申請制」的純可見度清單（`registry/registry.yaml` 加一行 repo 名 + repo 內有 `PROJECT.yaml`），不是合規門檻。be2-mcp 現在就可以登記，誠實填 `risk_tier: red`（見 §1）。
2. **`ctx.*` SDK 對 be2-mcp 幫助有限，因為多數還沒實作**：TS shim（`platform_sdk/ts/src/context.ts`）目前只有 `secrets` / `logger` / `notify` / `storage` / `browser`，**連 `ctx.db` 這個欄位都不存在**（Python shim 有，但也只是 `_NotYet` 佔位）。be2-mcp 真正卡的（SQLite→PostgreSQL、in-process 鎖→分散式鎖、scheduler→HTTP job endpoint）是框架自己 roadmap R4/R3 都還沒做的東西，不是「換個 adapter 就解」。
3. **be2-mcp 手上有框架 roadmap 缺的東西**：`R8`（多方參數狀態機／紅區 approval）目前框架只有設計方向、**零實作**；be2-mcp 的 change-set + SSO 確認頁 + module registry 是一套已經 live 驗收過的完整實作，形狀比 roadmap 描述更細（nonce 通道、app-only 工具濾除、stale 409、CAS 防重複執行）。這是最值得回饋、也最不會跟框架既有設計衝突的貢獻點。
4. **be2-mcp 的「型態」框架沒有對應概念**：框架的 `project-template-v0.md` 整套設計是「一次性 workflow run（`POST /api/jobs/<name>` 觸發、跑完回摘要）」；be2-mcp 是**長駐的 MCP 協定伺服器**（Streamable HTTP、持有多個 tool/resource、被 AI client 即時呼叫、還有 host 渲染的互動面板）。這兩種「型態」目前框架的 `PROJECT.yaml` / manifest schema 完全沒有欄位可以表達（見 §2 表格）。這是建議提給框架 owner 討論的**結構性缺口**，不是隨手能補的小事。
5. **不建議做的事**：不要為了「符合框架」而現在就把 be2-mcp 的 OAuth 外殼、MCP Apps 面板、module registry 這些**接進** `ctx.*`——這些概念框架完全沒有等價物，接了也只是繞遠路。這些東西留在 be2-mcp 自己的架構文件裡就好，頂多把**設計思路**寫成文件回饋。

---

## 1. 如何在框架中登記 be2-mcp

### 1.1 框架期待的登記機制（讀原始碼確認）

登記是**兩層**：

1. **每個專案 repo 自己放一份 `PROJECT.yaml`**（治理錨點）。欄位規範見 `project-template-v0.md §4`（`id/owner/team/status/risk_tier/touches/runtime/schedules`），guard 的 `scripts/guard/validate_project.py::check_project_yaml()` 會驗：
   - `id` 必須符合 `<team>.<project>`（小寫英數＋連字號，正則 `[a-z0-9-]+\.[a-z0-9-]+`）。
   - `risk_tier` 必須是 `green|yellow|red`；`status` 必須是 `active|archived`。
   - `touches.pii: true` 時 **強制** `risk_tier` 至少 `yellow`，不得為 `green`。
   - `schedules` 若存在必須是 `task→cron` 的 map（無排程用 `{}`）。
2. **中央 `registry/registry.yaml` 主動申請一行**（`registry/registry.yaml` 檔頭註解：「存量盤點採『主動申請』制：團隊把自己的 vibe 專案 repo 登記在這裡」）。格式是 `<org>/<repo>` 或 `local:<絕對路徑>`（尚未推上 GitHub 的專案）。`registry/collect_registry.py` 逐一 `gh api repos/<entry>/contents/PROJECT.yaml` 抓回來彙整成 `registry/vibe-registry.md`（人類看的全公司版圖表格：專案/team/owner/風險/內部API/外站/串接/DB/PII/排程）。**`vibe-registry.md` 是腳本產出檔，不手改**——登記只需要動 `registry.yaml` 那一行，`vibe-registry.md` 由該腳本重跑產生（目前看不到有自動排程觸發它，可能是人工/CI 手動跑一次）。

**登記不是合規門檻。** README 明講框架目前只是「M1 template + SDK shim」，guard 只查 `PROJECT.yaml` 存不存在、schema 對不對、有沒有禁用套件（`slack_sdk`／`google-api-python-client` 等）、基本 cloud-ready 反模式（`localhost`／`sqlite`／`./uploads`／runtime DDL 字串掃描）——**不會**因為你的 DB 是 SQLite 就擋你登記；那屬於 §2 的落差,不是登記的前提。

### 1.2 be2-mcp 的 PROJECT.yaml 草稿

以下欄位含義與判斷依據（供使用者確認/修正，不代表已定案）：

- **`id`**：`<team>.<project>` 格式，`team` 這格我不知道 be2-mcp 掛在公司哪個 team 代號下（CLAUDE.md/spec 都沒寫），先用 `be2mcp` 佔位，需要使用者確認實際 team slug。
- **`risk_tier: red`**：理由——(a) `internal_apis` 碰 `kkday-auth-service`（S2S service key）與 be2 product-service/gateway（可寫入上下架/庫存/庫存平台/排程，會立即影響前台可售與快取）；(b) 即使寫入走 draft-only + 人工批准，change-set 批准後**是真的送出的生產寫入**，屬性上仍是高風險域；(c) SQLite 目前存**明文** access/refresh token（`docs/be2-mcp/stage-eks-migration-devops.md §3`）。`green` 明顯不符，`yellow` 低估了寫入面的風險，故建議 `red`——但這是判斷題，请使用者/owner 拍板。
- **`touches.pii: false`**：be2 商品資料（名稱、價格、庫存）不是顧客個資；`audit_log` 記的是內部員工身份（用於稽核追溯，非「顧客個資」意義下的 PII）。若公司資安對「員工身份紀錄」也算 PII 口徑不同，這格要改 `true`（會連動 `risk_tier` 至少 `yellow`，反正已經是 `red` 不受影響）。
- **`databases`**：現況是本機 SQLite（不合規，§2 展開），登記時誠實寫「目前非雲端合規儲存」，遷移完成後改 `rds/be2-mcp`。
- **`schedules`**：`shelf_schedule` 目前是 in-process poller（`scheduler.ts`），**不是**框架要的「`PROJECT.yaml schedules` 宣告 + `POST /api/jobs/<name>`」形狀，見 §2。先留空 map 並在註解說明現況，不要假裝已經符合。

```yaml
# PROJECT.yaml — be2-mcp（草稿，team slug 待確認）
id: be2mcp.mcp-server          # TODO: 確認公司實際 team 代號，目前是佔位
owner: lance.chien
team: be2mcp                    # TODO 同上
status: active
risk_tier: red                  # 見上方理由；draft-only 但批准後為真實生產寫入

touches:
  internal_apis:
    - kkday-auth-service         # S2S service key：login/verify/refresh
    - be2-product-service        # 經 api-gateway，讀 + draft-only 寫（shelf/inventory/schedule）
  external_sites: []
  integrations: []               # 無 Slack/Gmail 等 vendor 串接；MCP client 端不算 framework 定義的 integration
  databases:
    - "sqlite:local (非合規，遷移中 → 目標 rds/be2-mcp，見 docs/be2-mcp/stage-eks-migration-devops.md)"
  pii: false                     # 判斷見上；如資安認定員工身份紀錄亦屬 PII 需改 true

initiators: []                   # 空 = 僅 owner team；實際使用者是全體透過 be2-auth 登入的 be2 pilot 員工
schedules: {}                    # 現況為 in-process scheduler，未符合「HTTP job endpoint」形狀，見 §2；遷移後補
```

`runtime` 區塊（`project-template-v0.md §4` 範例有此欄，但 `vibe-project-template/PROJECT.yaml` 實際範本與 guard 都沒強制要求，屬選填）：

```yaml
runtime:
  port: 8787                     # APP_PORT
  health_endpoint: /healthz
  job_endpoint_prefix: /api/jobs # 現況不存在（scheduler 是 in-process），遷移後才有意義
```

---

## 2. be2-mcp 現況 vs 框架 `ctx.*` SDK 的落差

> 範圍界定：本節只談「be2-mcp vs 框架 `ctx.*` **SDK adapter**」的落差。**cloud-ready 12-約束的落差以
> `docs/be2-mcp/stage-eks-migration-devops.md §8` 為單一權威來源**，本節不重抄、有需要用連結引用。

### 2.1 兩份 shim 內容核對（讀原始碼，非猜測）

`platform_sdk/ts/src/context.ts`（be2-mcp 是 TS 專案，這份才是相關的那份）目前 `Context` class 只有：

```
secrets: SecretManager   // 只認 manifest 宣告過的 key（allowedKeys），本體 fallback 讀 process.env
logger:  Logger          // console.log/error，非結構化 JSON
notify:  Notify          // SLACK_WEBHOOK_URL 有設就 POST，沒設就印 MOCKED
storage: StorageManager  // local(/tmp) | s3（S3_BUCKET，預設憑證鏈）
browser: BrowserContext  // Playwright chromium
```

**沒有 `db`、`sheet`、`mail`、`checkpoint`、`log`（結構化/masking）欄位**——這些只存在於 Python shim（`platform_sdk/py/src/platform_sdk/context.py`），且多數是 `_NotYet` 佔位（呼叫就拋 `NotYetImplemented`，`context.py` 的 `_NotYet` class）：

```python
self.db = _NotYet("db", "Database（專案 schema）")
self.sheet = _NotYet("sheet", "Google Sheet 匯出視圖（SA+Shared Drive）")
self.mail = _NotYet("mail", "發信（SA+白名單寄件人）")
```

`roadmap.md` R4「Connectors / `ctx.*` 實作」把這幾個列為**待補**，狀態寫「SDK shim 介面先行，多數正式實作未完成」。也就是說：**就算 be2-mcp 現在採用 TS SDK，`ctx.db` 這個能力在框架裡根本不存在（連 Python 那份都是佔位、TS 那份連欄位都沒有）**，不是「換掉自己的 store 就能用框架的」，而是「框架這塊也還沒蓋好」。

### 2.2 逐項落差表

| 框架能力 | 框架現況（讀碼確認） | be2-mcp 現況 | 落差判斷 |
|---|---|---|---|
| `ctx.secrets` | TS：manifest 宣告的 key allowlist + `process.env` fallback；Python：`vault://` 引用格式，MVP 期解析為同名 env | `src/config.ts` 用 Zod 直接驗證/解析 `.env`（見 CLAUDE.md「憑證：一律從 `.env` 讀」） | 語意已相容（両者本質都是 env-backed），差別只在框架多了「宣告哪些 key 才准存取」的權限層。**低優先** adopt：可考慮把 config.ts 現有的必填 env 清單對映成 manifest 式宣告，但這是文件價值大於程式價值。 |
| `ctx.logger` / `ctx.log` | TS 只有 `console.log`；Python 有結構化 JSON（`ts/run_id/workflow/step/level/msg/data`）+ `step()` context manager，且明講「audit log/status page/notification 不得出現 raw secret 或 raw PII」 | be2-mcp 有 OTel trace（`otel.ts`）+ 自己的 `audit_log`（SQLite，append-only、禁改禁刪 trigger），但**沒有 `LOG_LEVEL` 結構化 stdout**（`stage-eks-migration-devops.md §8` 已标 🟡「缺 LOG_LEVEL 結構化」） | **可直接借鏡** Python shim 的 JSON schema（`ts/run_id/step/level/msg`）補上結構化 stdout log，這塊落差小、價值明確，且與框架設計不衝突。 |
| `ctx.notify` | Slack webhook，兩份 shim都有 | be2-mcp 目前**沒有** ops 告警通道（change-set 失敗、refresh 失敗都只進 audit_log，沒有主動通知） | 可考慮採用同款 `SLACK_WEBHOOK_URL` 模式做 ops 告警，屬**加分項**、非阻擋。 |
| `ctx.storage` → S3 | TS/Python 皆已有完整實作（default credential chain,`S3_BUCKET`/`AWS_REGION`/`S3_PREFIX`） | be2-mcp 目前不產生檔案類產出（無報表/匯出/截圖需求） | **暫不相關**，除非未來加「批次結果匯出成 CSV/報表」功能。 |
| `ctx.db` → PostgreSQL | **兩份 shim 都未實作**（TS 無此欄位；Python `_NotYet`）。roadmap R4 待補：「連線池小、TLS、CRUD runtime」 | be2-mcp 的核心阻塞：`better-sqlite3` 單機 in-process store（`src/store/db.ts`），`stage-eks-migration-devops.md §8` 已列為 🔴，遷移目標是自建 PostgreSQL store 層（含 `db/migrations` forward-only、advisory lock 取代 in-process mutex） | **框架完全幫不上忙**——be2-mcp 得自己做這層遷移；但**這正是 §3 的貢獻機會**：be2-mcp 若真做出一套 TS + PostgreSQL 的 store 層（含 migration runner、連線池、TLS），可以是 `ctx.db` TS 實作的第一個真實藍本。 |
| `ctx.checkpoint`（紅區確認點） | 只有 Python shim 有：`interactive` 模式印 preview + 要求 `--yes`/`VIBE_YES=1`；`worker` 模式檢查 `VIBE_APPROVED=1`（由外部狀態機注入）。**沒有身份綁定**（誰能按下 approve 沒有機制保證，`VIBE_APPROVED=1` 只是一個環境變數） | be2-mcp 的 change-set 批准：SSO 確認頁（be2-auth POPUP 登入拿 `be2mcp_sid` session cookie）、批准動作與批准者身份綁定、agent 結構上拿不到批准憑證（app-only 工具從 model 工具清單濾除）、live-diff 重算 + stale 409 + compare-and-swap 防重複執行 | be2-mcp **明顯領先**框架現況。這是 §3 的頭號貢獻候選。 |
| workflow 執行模型（`runWorkflow` / `run_workflow`） | 假設每個 workflow 是 `workflows/<id>/flow.ts` 的**一次性函式呼叫**，由 `POST /api/jobs/<name>` 或 CLI 觸發、跑完回 JSON 摘要即結束（`platform_sdk/ts/src/runner.ts`、`vibe-project-template/src/api.py` 的 `trigger_job`） | be2-mcp 是**長駐 MCP 協定伺服器**（`StreamableHTTPServerTransport`），持有一組 tool/resource，被 AI client 用協定即時呼叫、可能一次連線內多輪工具呼叫、還有 host 渲染的互動面板（MCP Apps） | **結構性缺口**，不是哪個 adapter 沒做,而是框架的「專案＝一次性 workflow run 集合」心智模型本身沒有「長駐協定伺服器」這個型態的位置。見 §3.2。 |

### 2.3 小結

be2-mcp 想從框架拿到即戰力有限——真正卡住 be2-mcp 上雲的 SQLite→PostgreSQL、in-process 鎖、scheduler→HTTP job endpoint，框架自己也還在 roadmap（R3/R4）階段，沒有現成實作可以「接上就好」。這部分工程 be2-mcp 得自己做（`stage-eks-migration-devops.md` 已經有清楚的遷移範圍）。**框架對 be2-mcp 現階段的價值主要是「治理詞彙與登記可見度」（PROJECT.yaml/registry），不是「省下工程」。**

---

## 3. be2-mcp 可以回饋框架的東西

### 3.1 直接對得上 roadmap 缺口的：紅區 approval 狀態機（→ R8）

`docs/roadmap.md` R8「多方參數狀態機」目前狀態寫「設計保留，未實作」，方向描述：

> 狀態存在 PostgreSQL。觸發與補參數入口部署在 EKS 內部 service…不依賴外部 SaaS webhook 主動打進內網。補參數本身即 approval。audit log 記錄 actor/role/time/field，但 PII 值 mask 或 hash。

be2-mcp 的 change-set + 確認頁機制（`docs/be2-mcp/phase2b-runbook.md`、`docs/be2-mcp/mcp-apps-runbook.md`，摘要見本機 CLAUDE.md「鐵則」第 4 條）已經是這個方向的**完整落地版本**，且是**已對真人 live 驗收過**的實作，細節比 roadmap 描述更進一步：

- 批准者身份用獨立 SSO session（不是環境變數注入的 `VIBE_APPROVED=1`）。
- 結構上防止 agent 自我批准（批准工具對 model 工具清單濾除，nonce/session cookie agent 拿不到）。
- 批准當下重新計算 diff（防止批准延遲期間現況已變、批准了過期的變更），加 stale 409。
- compare-and-swap 防止同一批准被重複執行。
- audit log 對每個 item 記結果，非 done/skipped 一律記 error（避免 `partial` 狀態被誤記成 `ok`）。

**建議貢獻形式**：不是搬程式碼（be2-mcp 是 Node/TS+SQLite，框架 R8 目標是 PostgreSQL，語言/儲存層不同），而是把這套設計寫成一份**框架可讀的 pattern 文件**（例如 `docs/patterns/red-tier-approval.md`），內容是「身份綁定批准」「structurally-unreachable credential」「live-diff recompute + stale check」「CAS 防重放」這幾個原則，供框架 owner 在真正動工 R8 時參考，不是要求框架照搬 be2-mcp 的 SQLite 實作細節。

### 3.2 框架心智模型缺口：「MCP 伺服器」是不同於「workflow」的專案型態

`project-template-v0.md` 整份文件的單位是 **workflow**（`workflows/<name>/{manifest.yaml,flow.py,tests/}`，一次觸發、跑完回摘要，`PROJECT.yaml schedules` 對映到 K8s CronJob）。這個模型天然適合「批次腳本」「排程報表」「一次性資料處理」。

be2-mcp 不是這個型態：它是**長駐服務**，符合 12 條硬約束裡的「一個容器一個 process、監聽 PORT」（約束 #1），但**協定層完全不同**——它要滿足的是 MCP 規格（Streamable HTTP、`tools/list`/`tools/call`、OAuth 2.1 discovery、host 渲染的互動 UI 資源），而不是「一組 `workflows/` 目錄 + `/api/jobs/<name>`」。目前框架的 `PROJECT.yaml`／`workflow-manifest.schema.json`／guard 全部隱含假設專案是 workflow 集合，沒有欄位可以宣告「這是一個協定伺服器,不是 job 集合」。

**建議貢獻方向**（不是現在就做，是提給框架 owner 決定要不要收）：
1. 最小改動：`PROJECT.yaml` 加一個選填欄位如 `shape: workflow-collection | long-running-service`，讓 registry/guard 未來可以依型態套不同規則（例如 `long-running-service` 不強制要求 `workflows/` 目錄，但仍要 `/health`、非 root、env-based secret）。
2. 較大改動：框架若預期公司會出現更多 MCP/協定伺服器類專案（不只 be2-mcp，kkday-development-tools 已經是一個先例只是不在此框架管），可以考慮開第二個 template（例如 `vibe-mcp-server-template`）並存,而不是硬把它塞進 workflow 心智模型。

這件事**風險是框架 owner 目前可能無意涵蓋 MCP 這條線**（README 通篇沒提 MCP/協定伺服器），貿然開 PR 加欄位可能與框架路線圖不合。**這屬於「先問、再提案」的項目**，見 §4。

### 3.3 OAuth 2.1 Authorization Server 外殼——spec 沒覆蓋這個角色

`vibe-cloud-ready-spec.md §2.6` 講的是「本專案作為 OAuth **client**，redirect 使用者去 Google 登入」；be2-mcp（借鏡 `kkday-development-tools`）扮演的是反過來的角色——**自己是 OAuth 2.1 Authorization Server**，要對 Claude 這類 AI client 做 discovery（RFC 9728/8414）、動態註冊（DCR, RFC 7591）、PKCE、`redirect_uri` allowlist。這在 spec 裡完全找不到對應章節。

kkday-development-tools 與 be2-mcp **各自獨立造了一套**這個外殼（本機 `docs/be2-mcp/reference-dev-tools-architecture.md` 已記錄借鏡關係）。如果公司未來還會有第三個 MCP server，這套外殼很值得抽成公司共用的 reference（不一定要框架收，也可能該是獨立小 repo/npm package），**避免每個團隊重造 DCR + redirect_uri allowlist 這種容易踩資安坑的東西**。

### 3.4 不建議回饋、留在 be2-mcp 自己架構的東西

- **MCP Apps 互動面板**（`ui://` resource、host 渲染）：完全是 MCP 協定特有能力，框架的「workflow 跑完回摘要」模型沒有對應概念，硬塞沒有意義。
- **Module registry（core/module 邊界）**：be2-mcp 的 `src/core/` vs `src/modules/` 拆分（`docs/be2-mcp/module-onboarding.md`）是 be2 商品 domain 特有的擴展機制,雖然精神上呼應框架 `project-template-v0.md` 原則 4「副作用走 adapter，底層可換、業務程式不重寫」,但這只是**驗證了框架自己的原則是對的**,不代表要把 be2 的 domain module 系統搬進框架——那是 be2-mcp 的業務邊界,不是通用基礎設施。

---

## 4. 建議行動清單（排序，待使用者逐項批准）

> 標注 [本地] = 只動 `mcp_poc` repo,零風險,不需要外部核可。標注 [外部-低風險] = 要對 `kkday-vibe-framework` 開 PR,但改動小、不影響既有專案。標注 [外部-需先問] = 涉及框架路線圖方向,應先跟框架 owner 討論再動手,不要直接開 PR。

1. **[本地] 補 `PROJECT.yaml`**：把 §1.2 草稿放進 `mcp_poc` 根目錄,team slug 待使用者確認。零外部依賴,現在就能做。
2. **[本地] 把已存在的 `docs/be2-mcp/vibe-cloud-ready-spec.md` 差距分析（`stage-eks-migration-devops.md §8`）與本提案 §2 對齊**,避免兩份文件各自維護出現不一致——建議之後只在一處維護「12 條約束差距表」,另一處用連結引用。
3. **[外部-低風險] 在 `registry/registry.yaml` 加一行登記 be2-mcp**（`kkday-it/mcp_poc` 或實際 repo 路徑）。前提是 #1 的 `PROJECT.yaml` 已經進 repo 且欄位誠實（尤其 `risk_tier: red`、SQLite 現況不要隱藏）。這是一行 diff,對框架其他專案零影響,風險最低、可見度價值最高,**建議優先做**。
4. **[外部-低風險] 補結構化 stdout log**（§2.2「`ctx.logger`/`ctx.log`」那格）：借鏡 Python shim 的 `{ts,run_id,workflow,step,level,msg,data}` JSON schema,在 be2-mcp 自己的 logger 加這層,**不需要**改框架程式碼,純粹是 be2-mcp 單方面借鏡設計——嚴格說不算「外部」PR,但列在這裡因為价值明确、依赖框架文件已读懂。
5. ~~**[外部-需先問] 紅區 approval pattern 文件回饋給框架（對應 R8）**~~ — **不採用（2026-08-26 使用者決定）**：框架治理模型是 RBAC + 「自己的操作自己負責」,不做通用強制審批閘。be2-mcp 的 change-set/確認頁是本產品自身需求（改線上商品要人把關）,留在 be2-mcp 架構文件即可,不回饋為框架通用功能。
6. **[外部-需先問] `PROJECT.yaml` 加 `shape` 欄位表達「長駐服務 vs workflow 集合」**：這改動 schema、guard 邏輯,影響所有未來要登記的專案,**必須先跟框架 owner 對齊路線圖**（他們可能根本不打算收 MCP 型態的專案）,不要單方面開 PR。
7. **[外部-需先問，優先度最低] OAuth 2.1 AS 外殼抽成公司共用 reference**：涉及是否要放進這個框架、還是該是獨立 repo,且工作量不小（要把 be2-mcp 和 kkday-development-tools 兩套實作比較異同才能抽公約數）,建議等 #5/#6 有結論、且確定有第三個 MCP 專案的實際需求後再啟動,现在做投資報酬率不明。

8. **[外部-低風險/需先問]（使用者指定的框架貢獻主因）把平台 `APP CONFIG` / `APP SECRET` 兩頁籤慣例補進框架 `vibe-cloud-ready-spec.md §2.2`**：
   - **緣由**：平台 config-manager 的實際 UI 把 `.env` 拆成 **APP CONFIG（非機密）** 與 **APP SECRET（機密）** 兩個 dotenv 頁籤（見多個既有服務截圖：Laravel `api-b2c`、AI `cerebrum`——皆用 `APP_ENV`/`APP_PORT`/`APP_KEY`/`APP_URL`/`APP_DEBUG`/`APP_LOG_PATH`/`LOG_CHANNEL=stdout`/`LOG_LEVEL` 等房規命名，secret 用 `API_*`/`*_KEY`/`base64:` 等）。
   - **缺口**：框架 §2.2 目前只有**抽象三分類表**（build-time公開 / runtime secret / runtime非機密），**沒有對映到平台實際的兩頁籤與 `APP_*` 命名**。AI agent 照現行 §2.2 產出的 `.env.example` 不會自動對齊平台那兩個 tab 的填法。
   - **建議貢獻**：在 §2.2 加一段「平台落地形狀」——(a) 明講三分類如何歸進 **APP CONFIG（build-time公開 + runtime非機密）** 與 **APP SECRET（runtime secret）** 兩頁籤；(b) 列 `APP_*` 標準命名對照；(c) `.env.example` 範本用這套命名 + 三分類註記，讓平台團隊一鍵貼進 config-manager。可順帶更新 `vibe-project-template/.env.example`。
   - **為何 [需先問]**：動的是框架**權威 spec** + template，屬跨專案影響；且平台命名細節（哪些算 APP CONFIG vs SECRET 的邊界、`APP_KEY` 是否強制）最好跟框架/平台 owner 對一次口徑再開 PR。屬**低爭議、高共識**的貢獻,預期 owner 會歡迎（是把 spec 對齊平台現實）。

**本次不建議做**：現在就把 be2-mcp 的 store 層接 `ctx.db`——這個能力框架連 TS 版都沒有,接了也只是 be2-mcp 自己重新發明一遍,不如把自建的 PostgreSQL store 層做好之後,反過來當作 §3.1/#5 那類「回饋」的素材。

---

## 附錄：引用來源（讀取自 `kkday-it/kkday-vibe-framework`, master, 2026-08-26）

- `README.md` — 框架定位、M1 成熟度、repo 結構、給 AI 的指引順序
- `vibe-cloud-ready-spec.md` — 12 條硬約束、反模式速查表、上雲檢查清單
- `project-template-v0.md` — repo 標準結構、`PROJECT.yaml` 欄位、workflow contract、控制權歸屬表（§13）、里程碑 M0–M3
- `registry/registry.yaml`、`registry/vibe-registry.md`、`registry/collect_registry.py` — 登記機制與彙整腳本
- `platform_sdk/ts/src/context.ts`、`index.ts`、`runner.ts`、`package.json` — TS SDK shim（be2-mcp 相關的那份）
- `platform_sdk/py/src/platform_sdk/context.py`、`worker.py`、`runner.py` — Python SDK shim（功能較全,含 `checkpoint`/`db` 佔位）
- `vibe-project-template/PROJECT.yaml`、`CLAUDE.md`、`.env.example`、`src/api.py`、`schemas/workflow-manifest.schema.json`、`scripts/guard/validate_project.py`、`.github/workflows/guard.yml`、`workflows/hello_world/manifest.yaml` — template 具體形狀與 guard 檢查邏輯
- `docs/roadmap.md` — R1–R10 未實作清單（本提案引用 R3/R4/R8）

本機對照來源：`/Users/lance.chien/Documents/Projects/mcp_poc/CLAUDE.md`、`docs/be2-mcp/stage-eks-migration-devops.md`（§8 差距表）、`docs/be2-mcp/vibe-cloud-ready-spec.md`（已存在的本地副本）。
