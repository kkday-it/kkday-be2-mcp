# be2 MCP 設計 — 讓員工透過 agent 完成 be2 product 批次任務

日期：2026-08-07
狀態：草稿（待使用者審閱）
拆分策略：方案 A「縱切逐步升權」（每階段交付可用功能，風險層級 L0→L3 逐步開放）

參考來源：
- 《企業級內部MCP實作設計要點》（~/Downloads/企業級內部MCP實作設計要點.md）— 五大支柱：身份貫穿、風險分級、邊界防護、全鏈路稽核、集中治理
- CIO 文章（cio.com.tw/106747）— L1 讀取型 → L2 建議型 → L3 執行型逐級放權、負面表列、不可篡改稽核
- trellis-poc memory（be2 資料模型、MCP remote auth 研究、Batch Wizard 模式）
- Confluence KBACKEND 2220097560（API 資訊，需要時查閱）

## 1. 目標與範圍

**目標**：員工不再逐筆點 be2 product 頁面，改為對 agent（claude.ai / Claude Desktop）下自然語言指令完成批次任務，且全程符合企業標準（身份貫穿、draft-only 寫入、全鏈路稽核）。

**首發痛點**：批次編輯/更新，欄位範圍（皆為高風險寫入）：
1. 上下架/狀態切換（Phase 2 首發，endpoints 已驗證、語義最單純）
2. 價格/庫存/方案設定（Phase 3；內部順序依 Phase 0 真寫入量盤點 = **方案 → 庫存 → 價格**，價格因金流相關較後）
3. 日期/場次/可售設定（Phase 3，**Phase 0 實測真寫入近乎 0、最後開**）

（Phase 3 內部開發順序依真寫入量，詳見 §4 與 `docs/be2-mcp/phase0-inventory.md`。）

**非目標（負面表列）**：
- agent 不可直接送出任何寫入 — 一律 change-set + 人工批准
- 不開放刪除、退款、對外通知等不可逆操作
- 不給 agent 任何管理員權限
- 商品文案/翻譯編輯不在本專案範圍（另案）

## 2. 架構總覽

```
員工
 │ ① 在 Claude 完成 OAuth（be2-mcp 自架 OAuth 外殼）
 │    authorize 未登入 → redirect 瀏覽器到 be2-auth v3 web 登入
 │       be2-auth cookie 有效則靜默；否則帳密+2FA 一次
 │       （登入內部即 auth-service 兩步 code flow：login→authorizationCode
 │         →login-authorization-code 換 { be2 access/refresh JWT, businessList }）
 │    ← 一顆 be2-auth cookie 同時治理 be2-web / Claude OAuth / 確認頁（SSO-like）
 v                                                        │（service key）
Claude (claude.ai / Desktop / Claude Code)        kkday-auth-service（be2 IdP + 授權權威）
 │  ② MCP (Streamable HTTP + OAuth 2.1，帶 be2-mcp OAuth token)      ▲
 v                                                                   │ /api/v1/verify
be2-mcp server（OAuth resource server + 薄 AS 外殼；be2 token 存 server 端共用 store，給 Claude 的 OAuth token 只是不透明參考）
 │  ├── L0 read tools ──────> be2 gateway /product/api/v1（帶 be2 user JWT）──┘
 │  ├── L2 changeset tools ─> change-set service（同 process，SQLite→Postgres）
 │  └── OTel tracing + audit log（每個 tool call）
 v
確認頁（瀏覽器 web app，redirect 登入 + be2-mcp web session）：員工審 diff → 批准 → 當下換新鮮 token 執行 batch → before/after 稽核
```

- **MCP server**：TypeScript `@modelcontextprotocol/sdk`，Streamable HTTP transport。依 2026-07-28 spec 作為 OAuth resource server（`/.well-known/oauth-protected-resource`、401 `WWW-Authenticate`、RFC 8707 audience validation）。
- **be2 的 IdP 就是 kkday-auth-service（無企業 SSO），故 be2-mcp 必須自架薄 OAuth 2.1 外殼（AS façade）**：Claude 只講 OAuth 2.1，auth-service 是「帳密+2FA 發 JWT」的 IdP、非 OAuth AS。外殼結構借鏡已上線的 `kkday-development-tools`（discovery + RFC 7591 DCR + PKCE + redirect_uri allowlist）。**登入內核 = redirect 瀏覽器到 be2-auth v3 web 登入**（analogous 於 dev-tools authorize redirect 去 Google，只是換成 be2-auth）：由瀏覽器驅動、能設/讀 be2-auth cookie，故**一顆 be2-auth cookie 同時治理 be2-web / Claude OAuth / 確認頁三處，已登入 be2-web 者接 Claude 與開確認頁皆靜默、不重登**。登入內部走 auth-service 原生兩步 code flow（login→換碼），直接對映 OAuth、不需發明新協定。
  - **不可**在 be2-mcp 自架登入頁用 server-side `POST auth/be2/login`（純 S2S、不經瀏覽器、無法設/讀 be2-auth cookie）——那會逼 Claude OAuth 與確認頁各自重登。此 REST 直呼僅作為「be2-auth redirect 契約 Phase 0 未談成」的 fallback，且明確標示會失去 SSO 無縫性（見 §12）。
- **驗證路徑分兩條線**：核心線（Phase 1a）用 Claude Code static per-user bearer 驗證工具設計，無外部依賴；平行線（Phase 1b）補 full OAuth 外殼上 **Claude Desktop（本機 client、內網部署即可、不需公網）**，依賴 auth-service 串接（service key 申請）。claude.ai **網頁**才需公網 ingress + 資安核可，不在本專案範圍。延誤不阻擋後續 Phase（見 §11、§12）。
- **change-set service**：be2 後端無 draft 機制，自建一層。POC 用 SQLite，production 化換 Postgres。
- **確認頁**：獨立的瀏覽器 web app（列 diff、備註、批准鈕），有自己的 be2-mcp web session，**與 tool-call 面共用同一套 server 端 token store（模型一致）**。登入走 redirect-based 流程（導向 be2-auth web flow；be2-auth cookie 有效則靜默免重登，不會每次批准都帳密+2FA），web session 由 be2-mcp server 端管理與續期。批准動作發生在 MCP tool 邊界之外，符合 draft-only pattern。沿用 trellis-poc 已驗證的 Batch Wizard Step2–4 設計（diff、動態計數、prod 字串解鎖、結果儀表板）。批准當下用該 session 新鮮 access token 執行寫入（`change_sets` 表只存變更內容，不存 token）。詳見 §3。

## 3. 身份與授權

- **Identity continuity**：員工在 Claude client 對 be2-mcp OAuth 外殼完成 OAuth；外殼的 authorize 步驟背後跑 auth-service 帳密+2FA 兩步 code flow，換得該員工的 **be2 user JWT + refresh token + businessList**，存進 be2-mcp server 端 store；發給 Claude 的 OAuth token 只是**不透明參考**（見下「token 存放模型」）。tool call 時 MCP server 從 store 取該 be2 user JWT 對 be2 gateway 呼叫（寫入帶 `modify_user`）。**全程 user-scoped，不得退化成 service account**（be2-mcp 自身不持有高權 be2 帳號）。
  - be2 的「token exchange」機制已確認 = **auth-service 的 refresh**（access ~50min 到期用 refresh 換新），**不是** gateway on-behalf-of。Phase 0 確認 refresh endpoint 與 TTL 政策即可，此項不再是 §12 的最大不確定性。
- **每個 tool call 都必須先過 auth-service verify，一律委派、不本地驗簽**：be2 JWT 的簽章 key 在 auth-service 手上，`POST /api/v1/verify` 一次做完驗簽 + 驗過期 + 撈 subAuthUser + 檢查 user_status + per-uri 授權（失敗丟例外）。分兩種 tool：
  - **走 gateway 的 tool（L0 read）**：呼叫 be2 gateway 時 gateway 已代打 `/verify`，不需 be2-mcp 重複。
  - **be2-mcp 本地服務、不經 gateway 的 tool（L2 `be2_create_changeset` / `be2_get_changeset_status`，由同 process 的 change-set service 處理）**：**be2-mcp 必須在執行前自己帶 service key 明確呼叫 auth-service `/verify`（target 對應該操作）** — 否則本地 tool 完全跳過驗證，被撤銷/過期的 token 仍能建 change-set。這是硬性要求，不是選項。
  - be2-mcp **不得**自己驗 JWT 簽章或自建 RBAC。授權資料兩來源皆由 auth-service 提供、照用：換碼 response 的 `businessList`（MCP 層對 tool/action 做 fail-fast 過濾）、JWT claims 的 `groupOids`。（注意 verify 對 be2 平台以 `userUuid` 定位使用者。）
  - **businessList 更新時機**：撤銷/降權由每次 `/verify` 即時擋下（fail-closed，安全）；加權（新增權限）在**下次 L2 refresh（~50min）即反映**——auth-service refresh 端點會回**新鮮** businessList（Phase 0 A3 實證），不需重新登入。
- **token 存放模型 — server 端 store（Option 1，對齊 be2-web 與 dev-tools）**：be2-mcp 把該員工的 be2 token（access + refresh + businessList）保管在**自己的 server 端共用 store**（KKday 內網，如 Redis / DB，key = OAuth subject）；發給 Claude 的 OAuth token 只是**不透明參考**、本身不含任何 be2 憑證。**be2 憑證全程不離開 KKday 邊界**（免加密封裝、免 B4 離境核可）。
  - **tool call**：Claude 帶 OAuth 參考 token → be2-mcp 從 store 撈該員工 be2 access token → 呼叫（+ businessList 做 fail-fast）。
  - **可水平擴**：be2-mcp 無 in-memory / sticky session，狀態集中在共用 store，任一實例都能服務任一請求（符合 stateless-transport 精神；「stateless」指無 sticky session，不是「無 store」）。此 store 與 §6 scope-binding / 確認頁 web session 共用同一套。
- **兩層 refresh（等同 be2-web 自動續期，使用者無感、不重登）**：
  - **L1（Claude ↔ be2-mcp OAuth）**：Claude 依 MCP OAuth spec 自動續期 be2-mcp 的 OAuth 參考 token，be2-mcp 不需自建迴圈。
  - **L2（be2-mcp ↔ auth-service）**：be2-mcp 發現 store 內 be2 access 接近到期（tool call 時 lazy 觸發），打 auth-service `PATCH /api/v1/refresh-token/{refreshToken}` 換一組新鮮 be2 access/refresh + **fresh businessList**，**寫回 store**。
  - **rotation 天然正確**：refresh 端點會 rotate refresh token，但 be2-mcp 自己保管、rotate 後新 refresh 直接更新 store，**不牽涉 Claude 端 token、無需 L1/L2 對齊**（Option 1 比 Option 2 簡單的地方）。
  - **並發防護（rotating token 必須）**：refresh 會 rotate 舊 refresh 立即失效；若同一 user 多個 tool call 在 near-expiry 並發觸發 L2，會一個成功、其餘拿到已失效 refresh 而掉請求/被登出。故 L2 refresh 必須 **per-user single-flight / 分散式鎖**（如 Redis 鎖，key=subAuthOid/session）：同時只允許一個 refresh，其餘等它寫回 store 後直接讀新 token。
  - **先例**：be2-web（SIT 實測走 `session/token-user` + `/session/refresh` server session）與 dev-tools（Passport DB token store）都是此模型。
- **確認頁的認證邊界（與 tool-call 面同一套 store、模型一致）**：確認頁是瀏覽器 web app，**不吃 Claude 的 OAuth token**；它有自己的一組 be2-mcp web 端點（列 draft、批准、觸發執行），以 be2-mcp 為它建立的 **web session** 認證。
  - **登入 = redirect-based（silent re-auth 的來源）**：確認頁把瀏覽器**導向 be2-auth v3 web 登入**（能消費瀏覽器的 be2-auth cookie）。cookie 有效 → 靜默、免帳密+2FA（同 be2-web，SIT 實測用 POPUP flow）；無效才登一次。**不可**在 SPA 直接呼叫 `POST auth/be2/login`（純 REST、無法消費 cookie、無法靜默）。
  - **token 保管**：登入回來後 be2-mcp 把該 session 的 be2 token 存進**同一套 server 端 store**（與 tool-call 面共用），L2 refresh 亦由 be2-mcp server 端做。授權以該 session 的 be2 access token 委派 auth-service `/verify`（不本地驗簽、不自建 RBAC；be2-mcp 不解析 Laravel cookie，`/verify` 吃 JWT `authKey`）。批准當下用新鮮 be2 access token 執行寫入；`change_sets` 表不含 token。（金流相關 L3 可選 step-up 重驗 2FA，Phase 3 再議。）
- **API-UI 權限等價性**：Phase 0 盤點目標 endpoints 的 API 層授權是否完整（用 kk-graph-v2 查影響面 + 實測低權限帳號打 API 應得 403，並確認 auth-service `/verify` 對該 uri/method 有對應授權判斷）。不足處列入 gateway/後端補齊清單，未補齊的 endpoint 不上 MCP。
- **權限變更同步**：access token TTL 短（~50min）+ 每次 tool call 經 auth-service verify；離職/降權由 auth-service 端 revoke（user_status 改動 + businessList 收斂）即時生效，下一次 verify 即 fail-closed。

## 4. 風險分級與工具清單

工具少而精、task-oriented（非 CRUD 鏡像）。description 寫明適用情境、參數語義、副作用；回傳做欄位裁剪與分頁（token budget）；錯誤訊息 actionable。

| 層級 | 工具 | 說明 | Phase |
|------|------|------|-------|
| L0 | `be2_find_products` | 依 oid 清單查商品名稱、狀態、上下架（**已定案**：Phase 1 僅 oid 精確查詢，員工以 oid 清單輸入；關鍵字搜尋列後續增強） | 1 |
| L0 | `be2_get_product_plans` | 商品方案清單 + 各方案上下架狀態（packages + package-configs 合併） | 1 |
| L0 | `be2_get_inventory_settings` | 庫存/場次設定查詢 | 1 |
| L2 | `be2_create_changeset` | `{layer, action_type, items, note}` → changeset_id + diff 預覽（rich context：名稱+現況+目標） | 2 |
| L2 | `be2_get_changeset_status` | 查 change-set 審批/執行結果（batch_id、before/after） | 2 |
| L3 | （不存在）送出/執行 | 只在確認頁，人批准後由 server 執行 | — |

Phase 3 原則上不新增工具、主要擴充 `action_type`；但**每個新 action_type 所需的「現況讀取」必須同步補齊**——擴充既有 L0 工具的回傳 schema（或必要時加一支對應讀取工具），讓 agent 看得到該域現況（價格、package config、庫存明細）才能算 diff／做相對編輯（如「漲價 10%」），**嚴禁盲寫**。擴充順序依 **Phase 0 真寫入量盤點（跨操作者 PUT/DELETE 實測，見 `docs/be2-mcp/phase0-inventory.md`；取代 §1 列舉順序）**：

1. `package_setting`（方案維護）— **典型操作者的頭號真寫入**（`draft/product/package/{pkgOid}/info` 等，多數操作者第一）。
2. `inventory_setting`（庫存）— 真寫入總量最高（`product/item/{itemOid}/inventory` PUT）；對「批改庫存 power-user」（實測有人 ~12k 筆/月手動）ROI 極高。
3. `price_setting`（價格）— 次高（`official-price` 等）。
4. `schedule_setting`（日期/場次可售，對應 `sku-date-switch` 的 **PUT** 寫入）— **降為最後、視需求再開**：Phase 0 實測真寫入近乎 0（全體 30 天僅 24 筆），高頻的是**讀取**（POST），故寫入自動化優先度低；其**讀取**需求已由 L0 查詢工具覆蓋。

（首發 `shelf_toggle`＝上下架/狀態切換 `product/{prodOid}/switch` 維持 Phase 2；真寫入量雖低，作用是以最低風險寫入跑通 change-set/確認頁/稽核 pattern。每個 action_type 各自過 spec review + eval 才開。）

## 5. Change-set 機制

- 資料模型：`change_sets(id, user, layer, action_type, items_json, note, status, created_at)` + `change_set_results(batch_id, before/after snapshots, per-item status, trace_id)`。
- 狀態機：`draft → pending_approval → approved → executing → done/partial/failed`（+ `rejected`、`expired`，24h 未批准自動過期）。
- **批准時重新驗證現況**：確認頁載入與按下批准時都重新抓 be2 live state 重算 diff——pending 期間若有其他人/排程改過目標欄位（live state ≠ 建立時 snapshot），該項標記 `stale` 並以新 diff 要求使用者重新確認，不得拿舊 payload 盲目覆寫。no-op 略過判斷一律以執行當下的 live state 為準。
- 執行採 trellis-poc Batch Wizard 標準 contract：`Promise.allSettled` 隔離失敗、已在目標狀態自動略過、per-item 錯誤 + trace id、結果可下載。
- 批准人 = change-set 建立者本人（POC）；production 化可加第二人複核選項。

## 6. 邊界防護

- **Rate amplification**：MCP server middleware 做 per-user + per-session 呼叫預算（如每 session 100 次 read、10 個 change-set/日），超額回 actionable error。
- **Confused deputy**：MCP server 自身無高權 be2 帳號，一切用使用者 token — 低權使用者打高權 endpoint 得到 be2 原生 403。
- **Prompt injection（縱深防禦，不只靠標示）**：
  1. 工具回傳的商品名稱/描述標示為 untrusted data（回傳 envelope 註明 `data_origin: be2_content`）。
  2. **Server-side scope binding**：`be2_create_changeset` 的 `items` 必須是本 session 內 L0 read tools 實際查詢過的 oid 子集，拒絕未經查詢就出現的 oid — 被注入的指令無法憑空對任意商品建 change-set。
     - **實作**：已讀 oid 集合存 be2-mcp 的 **server 端共用 store**（Redis，key = MCP session id，TTL 對齊 session）——**與 §3 的 token store 同一套**（Option 1，本來就有 store）。item 1 的 **rate/呼叫預算**（per-session 計數）也存這裡。
  3. 單一 change-set 上限 **20 items**（RD 確認：後端對超過 20 筆的請求可能自行批次處理、不接受一次 burst），超過由 agent 拆成多個 change-set；執行端逐筆序列化呼叫、不對後端 burst。
  4. 最終 backstop：人在確認頁看到含名稱與 diff 的完整清單才批准。
  5. eval 涵蓋「工具回傳內容埋指令誘導建立 change-set」情境。

## 7. 可觀測性與稽核

- OTel distributed tracing：`mcp.session_id`、`mcp.tool`、`user_id` 作 correlation attributes，串 agent session → tool call → gateway call。
- 稽核日誌（append-only）：誰、哪個 client、哪個 session、呼叫什麼工具、參數、結果、trace_id。寫入類另存 before/after snapshot。
- 告警：短時間大量 change-set、連續 403（權限探測）、單 session 超預算。

## 8. 治理與生命週期

- 公司若已有 MCP registry/gateway 則註冊；若無，本專案的 spec review 流程（見 §10）+ 文件即為第一版治理雛形，並主動向平台/資安團隊報備，避免成為 shadow tool 先例。
- 工具 schema 版本化（tool description + schema 變更走 PR + eval 回歸）。
- 本 spec 分兩層維護：平台通用規範（§3、§6、§7）與 be2 product 實作規範（§4、§5），供後續其他系統接入複用。

## 9. 測試與評估

- 單元/整合測試：vitest，TDD（superpowers:test-driven-development）。
- **Agent-level eval 進 CI**：一組自然語言任務（含正例、需澄清例、應拒絕例），驗證 agent 選對工具、組對參數、正確處理錯誤。工具 description 任何變更都跑。
- 安全測試：injection 情境（工具回傳資料埋指令）、權限繞過情境（低權帳號嘗試高權 action）。
- 上線前用 `verify` skill 走真實 end-to-end（SIT）。

## 10. 開發工作流與使用的 skills

採用「雙 agent 交叉 review」工作流（aiposthub 文章模式），對應到現有 skills：

| 階段 | Skill | 用途 |
|------|-------|------|
| 設計 | `superpowers:brainstorming`（本文件）→ `agy-peer-review` | spec 由 Gemini (agy) 對抗式審到 APPROVED |
| 盤點 | `kk-graph-v2` | endpoint 影響面、API-UI 權限等價性盤點 |
| 盤點 | `qa-sniff-api-with-playwright` | swagger 與 UI 實際流量不符時攔真實 API |
| 規劃 | `superpowers:writing-plans` → `agy-peer-review` | 實作計畫，同樣交叉審 |
| 實作 | `superpowers:subagent-driven-development` + `superpowers:test-driven-development` | 依計畫分派 subagent、測試先行 |
| 驗證 | `verify`、`superpowers:verification-before-completion` | 真實流程 end-to-end |
| Review | `code-review`（Standards + Spec 雙軸）+ `agy-peer-review` | Claude 先審、Gemini 獨立上下文再審 |

## 11. 階段拆分

| Phase | 內容 | 交付物 | 估時 |
|-------|------|--------|------|
| **0 盤點** | be2 product endpoint / 權限等價性盤點（kk-graph-v2 + 低權帳號實測 + `/verify` 授權覆蓋）、向 auth-service team 申請 service key + scope、定版工具清單（agy 交叉審）。**認證串接多數已 Phase 0 實證**（見 `docs/be2-mcp/phase0-inventory.md`：userType/host/gateway/refresh/cookie 皆確認） | 盤點報告 + 定版工具清單 | 3–5 天 |
| **1a L0 唯讀（核心線）** | MCP server + 3 個 read tools + OTel + 稽核 + rate budget；Claude Code static per-user bearer（無外部依賴，先驗證工具設計與 eval）；agent eval 骨架進 CI | 先導使用者（技術同仁）可用 agent 查商品/方案/庫存狀態 | 1–2 週 |
| **1b remote OAuth（Claude Desktop，平行線，必交付）** | full OAuth 2.1 外殼上 Claude Desktop。Desktop 是**本機 client → be2-mcp 內網部署即可、不需公網**（員工在公司網/VPN）。依賴 auth-service 串接（service key）。**Phase 2 對一般員工 GA 前必須完成**（Code + Desktop 兩種都要支援）。claude.ai **網頁**（需公網 ingress + 資安核可）不在本專案範圍 | 一般員工從 Claude Desktop 連上（內網） | 1.5–3 天 |
| **2 L2 change-set（上下架）** | change-set service + 確認頁 + `be2_create_changeset`（僅 `shelf_toggle`）+ before/after 稽核 + injection eval | 員工可用 agent 批次上下架（人批准生效），SIT 驗證後上 prod | 2–3 週 |
| **3 L3 擴充+硬化** | `action_type` 擴充（**依 Phase 0 真寫入量：方案 → 庫存 → 價格**，`schedule_setting`/日期場次降最後視需求；逐個過 review + eval）、告警、eval 全量進 CI、治理文件定版 | 高頻批次任務（方案/庫存/價格）覆蓋 | 2–3 週 |

每個 Phase 結束條件：該階段 eval 全綠 + code-review/agy 交叉審通過 + SIT 實測（verify skill）通過。

## 12. 風險與待辦確認

1. **be2 user token 取得與續期（Phase 0 多數已實證，見 `docs/be2-mcp/phase0-inventory.md`）**：機制確認（§3）— redirect 到 be2-auth 登入 → 兩步 code flow 取 be2 JWT → be2-mcp server 端 store 保管、以 auth-service `refresh-token` 續期（**rotate + 回 fresh businessList，已實證**）。**cookie 耦合已排除**：`authenticateCorsWithCookie` 不擋請求、只為 allowlist 瀏覽器自動塞 service key，headless S2S 自帶 service key 即可。**userType=`be2`、auth host `auth-220`、gateway `api-gateway-220`、POPUP redirect flow 皆 SIT live 實證**。**剩餘唯一硬待辦：向 auth-service team 申請 service key + 確認 scope。** Phase 1a 過渡：沿用 trellis-poc 的 user-bind（先導使用者以自己 be2 帳號登入取 user JWT、server 端 store 保管、到期重續）— user-scoped、非 service account。
2. **API-UI 權限等價性**：若盤點發現 API 層授權缺口且後端短期無法補，該 endpoint 延後上 MCP（不以 MCP 層權限檢查代替）。
3. **ingress：本設計目標 Code + Desktop（皆本機 client）→ be2-mcp 內網部署即可、不需公網**（員工在公司網/VPN 即可連）。只有 claude.ai **網頁**（Anthropic 雲端發起）才需公網 HTTPS + 資安核可 ingress——不在本專案範圍，將來要上再議。（Phase 0 小確認：Claude Desktop 的 OAuth callback 走 loopback 還是 claude.ai，但 MCP 連線與 token 交換都從本機發起、內網可達。）
4. **確認頁 vs be2 UI 深連結**：本設計採獨立確認頁；若 be2 team 願意原生支援 change-set 批准介面，Phase 3 後可遷移。
5. **token 存放採 Option 1（server 端 store）— 已定案（2026-08-09）**：be2 憑證存 be2-mcp 內網共用 store、**不離開 KKday 邊界**，免加密封裝、免資安離境核可。代價僅為一個內網共用 store——而 §6 scope-binding / 確認頁 web session 反正也需要，等於免費。對齊 be2-web（server session，SIT 實證）與 dev-tools（Passport token store）兩個現有實作。（曾評估 Option 2「stateless encapsulation」，因需離境核可 + 加密/金鑰輪替工程、且共用 store 反正要有而不採。）

<!-- agy-peer-reviewed: 2026-08-06T16:11:09Z rounds=2 verdict=approved -->
<!-- agy-peer-reviewed: 2026-08-08T09:00:30Z rounds=2 verdict=approved (§2/§3 auth-service 認證流改寫) -->
<!-- agy-peer-reviewed: 2026-08-08T10:23:10Z rounds=5 verdict=approved (§2/§3/§6/§12 stateless encapsulation + 兩層 refresh + 確認頁 redirect SSO) -->
<!-- agy-peer-reviewed: 2026-08-08T16:41:48Z rounds=2 verdict=approved (§2/§3/§6/§11/§12 回改 Option 1 server-side token store + L2 refresh 並發鎖) -->
<!-- agy-peer-reviewed: 2026-08-08T17:15:09Z rounds=2 verdict=approved (§1/§4/§11 Phase 3 依 Phase 0 真寫入量重排：方案→庫存→價格，sku-date-switch/日期場次降末；L0 讀取須隨 action_type 補齊) -->
