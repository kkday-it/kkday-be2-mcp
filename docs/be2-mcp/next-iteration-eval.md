# be2 MCP — 下一輪迭代整合評估

日期：2026-08-11　狀態：評估草稿（未進主管線 spec）
> 一份整合評估，涵蓋四個追加方向：**① MCP Apps 實作落地**（對照 `modelcontextprotocol/ext-apps` examples + trellis `governed-batch-write-patterns.md`）、**② MCP auth 改為跳轉 be2 登入頁**（OAuth 2.1 外殼實作）、**③ server 端編排（Macro Tool）**、**④ Shopline 式 PoC 對外文件**。
> 搭配讀：`mcp-ui-exploration.md`（分級批准模型）、`mcp-ui-spike-checklist.md`（spike）、`be2-mcp-rd-design.md`（現行架構）。

## 0. 現況錨點（評估基準）

- 分支 `feat/phase1a`，HEAD `55a3309`，`npm run ci` = 195 passed / 0 skipped。
- 工具面：3 個 L0 read + 2 個 L2 change-set；工具回傳 **text-only JSON envelope**（`src/server/toolPipeline.ts:33` 的 `ToolResult` 只有 `content:[{type:'text'}]`，無 `structuredContent`、無 `_meta`）。
- MCP 認證：**static bearer**（`scripts/bootstrap-user.ts` 用 `.env` 帳密登入換 token、印一次性 bearer）；`/mcp` 只做 known-bearer 檢查（`src/server/app.ts:141`）。OAuth 2.1 外殼**設計已定案（借鏡 dev-tools）但未實作**。
- 確認頁已有完整 be2-auth POPUP SSO（`src/server/ssoRoutes.ts`：`/confirm/login` 彈窗 → postMessage 驗 origin → `/confirm/session` 換碼建 session cookie）——**這段程式碼就是 ② 的復用素材**。

---

## 1. MCP Apps（ext-apps）實作評估：要修改與追加哪些

> 依 `modelcontextprotocol/ext-apps` repo 實查（README + `examples/basic-server-vanillajs` + `examples/system-monitor-server` + SDK 原始碼，2026-08-11）。spec 穩定版 **2026-01-26**；Anthropic 已官宣 Claude Desktop / claude.ai 為 host。

### 1.1 SDK 與依賴（比預想更輕）

- **只需一個套件：`npm i @modelcontextprotocol/ext-apps`**（examples 鎖 `^1.7.0`）。~~`@mcp-ui/server`~~ **不需要**——mcp-ui 是第三方 host 端框架，server 端裝官方套件即可（先前 exploration/spike 文件寫「裝兩個」是錯的，已更正）。
- 與現有架構**零摩擦**：`registerAppTool`/`registerAppResource`（來自 `@modelcontextprotocol/ext-apps/server`）只是包住我們已在用的 `McpServer.registerTool/registerResource`，transport 沿用現有 `StreamableHTTPServerTransport`。相依版本 `@modelcontextprotocol/sdk ^1.29` 我們是 `^1.30` ✓。
- UI（iframe 內）用同套件的 `App` class（`ontoolresult` 收資料、`callServerTool` 回打、`openLink` 開外部連結、`sendMessage` 注入對話）；面板 HTML 用 vite + `vite-plugin-singlefile` 打成**單檔自足 HTML** 當 resource 回傳。
- 註冊模式（兩段式，MIME 已確認 `text/html;profile=mcp-app` = SDK 常數 `RESOURCE_MIME_TYPE`）：

```typescript
registerAppTool(server, 'be2_get_product_plans', {
  ..., outputSchema, _meta: { ui: { resourceUri: 'ui://be2/plans-panel.html' } },
}, handler)  // handler 回 { content:[{type:'text',...}], structuredContent: {...} }

registerAppResource(server, uri, uri, { mimeType: RESOURCE_MIME_TYPE },
  async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] }))
```

### 1.2 【關鍵新發現】app-only tool：規格層級的「不進 model context」通道

`_meta: { ui: { visibility: ["app"] } }` 的 tool **不對 model 曝光、只給面板呼叫**（system-monitor example 的輪詢 tool 就這樣藏）。這改寫兩個安全設計：

1. **L2 per-render nonce 不必賭 T2**：原 spike 首要未知是「面板 HTML 進不進 model context」（nonce 藏不藏得住）。現在 nonce／逐筆勾選確認可改走 **app-only tool 發放與回收**——model 從頭到尾看不到這個 tool 與其結果，隔離是規格保證、不是 host 實作巧合。T2 仍要驗（面板 HTML 本身的注入面），但 nonce 策略不再依賴它。
2. **L3 確認頁 URL 可以進面板、不進 agent context**：現行設計把 confirm URL 印在 server 終端機（`app.ts` `emitConfirmUrl`）。之後可改為：面板透過 app-only tool 取得 confirm URL → `app.openLink()` 開真瀏覽器——**agent 的 context 仍然拿不到 URL**，但使用者體驗從「去翻終端機」變成「面板一鍵開啟」。draft-only 命脈不動。

### 1.3 要追加的實作

| 新增 | 內容 |
|---|---|
| `src/ui/`（面板原始碼） | 首波 3 塊：**商品/方案挑選器**（讀取側）、**diff 審閱面板**（change-set 建立後）、**結果 ledger 面板**（執行後 per-item 結果）。vite workspace + singlefile build，產物進 `dist/ui/` |
| `src/server/appResources.ts` | 集中註冊 `ui://be2/*` resources（讀 build 產物）；在 `newServer()` 內與 tool 一起掛 |
| app-only tools | `app_get_changeset_view`（面板拉 diff/狀態刷新）、`app_get_confirm_link`（L3 link-out，§1.2）、（L1/L2 時）`app_confirm_changeset`（intent echo + nonce）——全部 `visibility: ["app"]` + 走既有 wrapL2Tool 管線（稽核、rate budget 照舊） |
| build 相依 | devDeps：`vite`、`vite-plugin-singlefile`；`npm run build:ui` script |

### 1.4 要修改的既有實作

| 檔案 | 修改 |
|---|---|
| `src/server/toolPipeline.ts:33` | `ToolResult` 加 `structuredContent?: object`；`wrapTool` 把 envelope **同時**放 text（給 model）與 structuredContent（給面板）——ext-apps 的「一份 CallToolResult 兩個受眾」模式 |
| `src/server/app.ts` `newServer()` | 有面板的 tool 改用 `registerAppTool`（多帶 `_meta.ui.resourceUri` + `outputSchema`）；掛 `appResources`；app-only tools 註冊 |
| `src/tools/types.ts` | `ToolDef` 加選填 `uiResourceUri` / `outputSchema` |
| `src/changeset/tools.ts` | `create_changeset` 回傳加 structuredContent（diff 面板資料源）；**確認頁 URL 依然不進回傳**（改走 §1.2 的 app-only 通道，或維持終端機） |
| `mcp-ui-spike-checklist.md` | 套件名更正 + 新增 T5（app-only visibility 實測），已同步修改 |

### 1.5 部署形態注意（spike 要驗）

Claude Desktop 官方文件化路徑是 **stdio local server**（`claude_desktop_config.json`）；我們是 Streamable HTTP `127.0.0.1:8787`。spike 需驗 Desktop 自訂 connector 直連 loopback HTTP 是否可 render；不行則備一個 thin stdio shim（stdio ↔ 轉打本機 HTTP）。claude.ai 網頁 host 則回到 Phase 0 B3 公網 ingress 前提（首波不做）。

### 1.6 面板設計必須內建 trellis governed-write patterns

trellis `governed-batch-write-patterns.md` 的 11 條原則是「治理型批次寫入 UI」的 checklist。對 be2-mcp 的 MCP Apps 面板逐條對映（含我們後端已具備 / 面板要補的）：

| # | 原則 | 後端現況 | 面板（MCP Apps）要做的 |
|---|---|---|---|
| 1 | Layer discipline（一批只操作一層） | ✅ `action_type` 天然分層（shelf=package 層、inventory=item×supplier×date 層） | 面板標題明示層級；挑選器不混層 |
| 2 | current→target diff（非裸動作） | ✅ diff 是 change-set 核心（`computeShelfDiff`/inventoryDiff） | **diff 面板是首要 UI**：`from → to` 逐欄渲染，沿用確認頁語彙 |
| 3 | 批次載入隔離失敗、逐項 retry | ✅ envelope 已回 per-key `errors[]` | 挑選器對失敗項渲染 inline error + 該項單獨重查按鈕 |
| 4 | no-op skip 且明示 | ✅ executor 以執行當下 live state 跳過 no-op | 面板預先標出「將略過（已在目標狀態）」的項目與數量 |
| 5 | 人的意圖（備註）進稽核 | ✅ change-set 有 `note`，入 audit | 面板放 note 欄位，隨 intent echo 一起回傳 |
| 6 | 高風險 typed-confirmation | 🔶 確認頁有高風險紅字 banner，無 typed gate | **L3 不在面板做最終簽核**（link-out be2-auth 確認頁）；typed-confirm 若加，加在確認頁而非面板 |
| 7 | partial success 逐項 ledger | ✅ per-item 結果（done/skipped_noop/error/would_go_negative） | 結果面板渲染逐項 ledger，不只總結一句 |
| 8 | deep-link 回權威系統 | ⬜ 無 | 面板每個商品卡帶 be2 後台連結（`link` action 開真瀏覽器） |
| 9 | 立即 vs 排程誠實 | ✅ 現況全部立即（核准後執行） | 面板在確認按鈕旁明示「核准後立即執行」 |
| 10 | 數量/選取透明 | 🔶 20-item 上限有，UI 無 | 面板常駐「已選 N / 將改 M / 略過 K」計數 |
| 11 | staged wizard（選→看→送→果） | ✅ 流程天然分段（L0 讀 → create_changeset → 確認頁 → status） | 面板按四步分段渲染，不把「看 diff」與「送出」壓同屏 |

**結論**：後端治理原語幾乎齊備（2/3/4/5/7/9/11 都是現成的），MCP Apps 的工作主要是「把已存在的治理資料投影成互動面板」，不需要新的治理邏輯——**除了 #8 deep-link 與 #10 計數是純前端新增**。

### 1.7 與分級批准模型（exploration §3）的關係

本節只評估「實作面」；「批准落在哪條憑證域」照 `mcp-ui-exploration.md` 的 L1/L2/L3 分級不變。實作順序照 spike checklist：先 spike 驗 T1–T4（尤其 T2 面板 HTML 進不進 model context），再進正式實作。

---

## 2. MCP auth 改造：OAuth 2.1 外殼 + 跳轉 be2 登入頁

### 2.1 目標與現況差距

**目標（使用者定調）**：Claude client 連 be2-mcp 時，瀏覽器跳轉 be2 後台登入頁輸入帳密——**帳密不經過 AI agent、也不經過 be2-mcp 以外的任何中介**。

**現況**：`bootstrap-user` 的帳密其實也不經過 agent（在 `.env`，由人跑 CLI），但它是 (a) 手動、(b) static bearer 不過期、(c) 帳密仍落地 `.env` 明文。OAuth 外殼 + 瀏覽器登入把三個都解掉：帳密只打在 be2-auth 官方登入頁（我們的 server 只拿到 authorizationCode），token 有生命週期，接入流程變成 client 原生體驗。

### 2.2 復用地圖（大部分積木已存在）

| OAuth 外殼元件 | 復用來源 | 缺口 |
|---|---|---|
| discovery（`/.well-known/oauth-protected-resource` + `oauth-authorization-server`） | dev-tools 逆向文件有完整欄位清單 | **全新實作**（純 JSON 端點，小） |
| DCR `POST /oauth/register` | dev-tools：public client、PKCE、redirect_uri allowlist、**response 不含 client_secret key** | **全新實作** + client 表（SQLite） |
| `GET /oauth/authorize` → 跳 be2-auth 登入 | **`ssoRoutes.ts` 的 POPUP/redirect 頁直接改造**：同一個 be2-auth `loginFlow` 契約、同一個 origin 檢查 | 新增：PKCE challenge 暫存、authorization code 發放 |
| `POST /oauth/token`（code+PKCE 換 token；refresh） | `authServiceClient.exchangeCode()` 換 be2 token 的邏輯照用；`TokenStore.upsert` 照用 | 新增：PKCE S256 驗證、發不透明 access/refresh、L1 refresh rotate |
| tool call 驗證 | `/mcp` 的 bearer gate 改查 OAuth token 表（同樣 hash 存放） | 修改 `app.ts:141` 附近 + 401 回 `WWW-Authenticate` 指向 discovery |
| token 生命週期治理 | dev-tools `oauth:purge` cron 概念 | 新增 purge script（過期 token + ghost client） |

### 2.3 要追加/修改的檔案

- **追加** `src/oauth/`：`discoveryRoutes.ts`、`registerRoutes.ts`（DCR + allowlist：`https://claude.ai/api/mcp/auth_callback` + RFC 8252 loopback）、`authorizeRoutes.ts`（登入頁跳轉，改造 ssoRoutes 模式）、`tokenRoutes.ts`（PKCE 驗證 + 發 token）、`oauthStore.ts`（clients / auth codes / oauth tokens 三張表）。
- **修改** `src/server/app.ts`：掛 oauth router；`/mcp` bearer gate 改查 OAuth token（**保留 static bearer 相容一段時間**——pilot 使用者已在用）。
- **保留** `bootstrap-user` 作 fallback（be2-auth redirect 契約若有變、或 headless 環境）。
- **測試**：PKCE 錯誤/重放、redirect_uri 不在 allowlist、code 一次性、agent 拿 OAuth token 打 `/confirm/*` 應無效（憑證域隔離不變）。

### 2.4 風險 / 待確認

1. be2-auth 對「非 be2-web 的 redirectPath」實際 allowlist 行為（Phase 0 B2 的殘留小確認，POPUP 模式已 SIT 實證可行）。
2. Claude Code / Desktop 對 loopback callback 的 OAuth 行為差異（dev-tools 已對 claude.ai 驗證過，Code/Desktop 是我們首要 client，需實測一次）。
3. MCP session 綁定：現有 `sessionOwner`（bearer↔mcp-session）機制改綁 OAuth subject，語義不變。

---

## 3. Server 端編排（Macro Tool / Fat Server）追加規劃

> 參考：`mcp_server_side_orchestration.md`（Fat Server, Thin Client：AI 只做自然語言解析與參數萃取，狀態/順序/交易安全全在 server 端程式碼）。

### 3.1 誠實盤點：我們已經是半個 Macro Tool 架構

`be2_create_changeset` 就是 orchestration 文件說的模式：agent 一次交出「目的地座標」（action_type + items 陣列 ≤20），server 端負責 scope 檢查、businessList fail-fast、diff 計算；executor 在核准後負責 read-merge-write、序列化、busy-guard、partial ledger、audit——**執行順序與交易語義全在 TS 程式碼，agent 碰不到**。庫存 executor 的跨月分組/輪詢/負值保護就是「Server 端軌道車」的實例。

### 3.2 真正的缺口：讀取側與「複雜需求」的 workflow macro

現況 agent 要自己編排「查商品 → 查方案 → 查庫存 → 算相對變更 → 建 change-set」多步呼叫——每步過一次 LLM，token 貴、慢、有漏步風險（orchestration 文件批評的正是這個）。追加方向：

| 候選 macro tool | 包掉什麼 | 價值 |
|---|---|---|
| `be2_prepare_batch_changeset`（工作名） | 收自然語言等值的結構化意圖（如「這 15 個 oid 的 9 月庫存各 +50」）→ server 端**自動完成所有前置讀取 + diff 計算 + 建草稿**，一次 tool call 回「草稿 + 逐項 diff + 略過清單」 | 把 3–5 次 LLM round-trip 壓成 1 次；scope-binding 改由 server 端「我自己讀的」滿足，杜絕漏讀 |
| `be2_batch_report`（讀取型） | 跨商品彙整現況（N 商品 × 方案 × 庫存一次撈齊、server 端聚合） | 純讀零風險，最先做 |

### 3.3 鐵則不動（macro 不能變成繞過核准的洞）

1. **macro 只到 draft 為止**：無論包多少步，終點永遠是 `pending_approval` change-set；核准仍在 be2-auth 憑證域。Fat Server 加速的是「安全半段」，不碰 gate。
2. **scope-binding 語義升級而非放寬**：macro 內部 server 自己讀的 oid 記入 read-oid store（server 讀=可信讀），對外仍拒絕「沒讀過就寫」。
3. **schema 巨大化的代價**：orchestration 文件的「巨大嚴格 JSON schema」對 LLM 參數萃取是負擔；我們折衷——macro 的 input 仍是精簡結構化意圖（oid 清單 + 操作），**不要求 agent 產出完整目標狀態藍圖**（那是 server 讀現況後算的）。
4. 與 MCP Apps 疊加：macro 的回傳（草稿+diff）正是 §1 diff 面板的資料來源——兩者是同一條「一次呼叫、視覺化審閱」體驗的前後半。

### 3.4 建議切入點

Phase 3b（價格域）開工前先做 `be2_batch_report`（讀取聚合 macro）驗證形態；寫入側 macro 等 MCP Apps diff 面板一起設計（避免回傳格式做兩次）。

---

## 4. Shopline 式 PoC 對外文件

> 參考：shopline-mcp.readme.io 研究（2026-08-11）。關鍵發現：**Shopline 全站只有一頁 getting-started**——「intro 一句話 → 能力 → 工具表 → 分 client 連線 → 安全 → 測試 prompt」單頁結構是商用玩家也採用的形態，PoC 階段照抄合法。

### 4.1 要做的：新增 `docs/be2-mcp/be2-mcp-getting-started.md`（單頁）

章節照 Shopline 模板 + 我們反著做的差異化：

1. **一句話定位**：用自然語言對 be2 商品後台做批次查詢與草稿變更，寫入一律人工核准。
2. **能力三點**：查詢彙整／批次草稿+視覺 diff／全鏈路稽核。
3. **工具表**：名稱 + 一句話 + 讀寫標記（照 Shopline 的表格式；參數細節外連 runbook）。
4. **連線（分 client）**：Claude Code（`claude mcp add …`）／Desktop（Connectors 路徑）；含建議模型等級。
5. **安全**（我們的差異化章節，Shopline 只一筆帶過、我們要展開）：
   - 權限交集一句話：「agent 權限 = 你本人的 be2 權限（businessList）∩ MCP 已支援工具」。
   - **draft-only 是 server 端結構性強制**（非 client 端可關的 confirmation）：agent 無 be2-auth session、結構上無法自我批准。
   - 稽核/可觀測性（audit log、trace、離職 fail-closed）——內部工具必寫，給主管與資安看。
   - prompt injection 警告（envelope untrusted_note、scope-binding 已內建）。
6. **測試 prompt 模板**（Shopline 最值得抄的一招）：5-6 條帶占位符可直接貼的 prompt + **一段完整多輪範例對話**（查現況 → 建 change-set → 確認頁核准 → 查結果）——單句模板呈現不了 draft-only 閉環，這段是 Shopline 沒有而我們必須有的。
7. **已知限制**（SIT 錨定、寫入授權現況、單機部署）。

### 4.2 既有 `poc-overview.md` 的處置

保留（讀者是 RD/QA、講設計原理），但數字已停在 Phase 2b（137 tests、「Phase 3 未開始」）需更新至 195/Phase 3a。getting-started 是「使用者視角」新文件，兩者互補不合併。

---

## 5. 建議執行順序（依賴關係）

1. **MCP Apps spike**（半天–1 天，照 `mcp-ui-spike-checklist.md`）——T2（面板 HTML 進不進 model context）決定 L2 批准策略，是 §1 全部實作的前置。
2. **OAuth 外殼（§2）**——與 spike 無依賴、可並行；是「給更多 pilot 使用者接入」的前置（static bearer 不可規模化）。
3. **getting-started 文件（§4）**——寫作可立即開始；連線章節等 §2 落地後定稿。
4. **讀取聚合 macro `be2_batch_report`（§3.4）**——低風險、先驗形態。
5. **MCP Apps 正式實作 + 寫入側 macro**——等 spike 結論，diff 面板與 macro 回傳格式一起設計。

每一項進實作前照主管線走：brainstorm → spec（`docs/superpowers/specs/`，過 agy-peer-review）→ plan → subagent-driven + TDD。
