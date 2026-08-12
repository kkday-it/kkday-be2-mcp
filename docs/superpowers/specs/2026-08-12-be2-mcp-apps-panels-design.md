# be2 MCP — MCP Apps 面板首波實作 design spec

日期：2026-08-12　狀態：已過 agy-peer-review（rounds=5）、**待使用者審**
> 前置文件：`docs/be2-mcp/mcp-ui-spike-checklist.md`（spike findings，T1–T5 全 pass）、`docs/be2-mcp/next-iteration-eval.md` §1、`docs/be2-mcp/mcp-ui-exploration.md`（分級批准模型）。
> **使用者離線期間以建議選項定案的假設（審查時可推翻）**：(1) 首波面板**不碰批准**，批准仍 100% 走 be2-auth SSO 確認頁；(2) spec 預留 L1/L2 面板批准介面但不實作；(3) 三塊 UI 併成兩個面板資源；(4) 打包用 esbuild 不引入 vite。

## 1. 目標與非目標

**目標**（解兩個實際痛點 + 一個體驗升級）：
1. 使用者不再翻 server 終端機找 confirm URL——面板一鍵開系統瀏覽器到確認頁。
2. change-set 的 diff 與執行結果從 JSON 文字變成可讀面板（from→to 逐欄、per-item ledger）。
3. 讀取工具（商品/方案/庫存）回傳可視化挑選器，勾選結果可直接餵給 `be2_create_changeset` 的對話流。

**非目標**（明確不做）：
- ❌ 面板內批准/拒絕 change-set（L1/L2 面板批准留下一輪，見 §8 預留介面）。
- ❌ claude.ai 網頁 host（需公網 ingress，Phase 0 B3 結論不變）。
- ❌ iframe 內嵌確認頁（exploration §6：需威脅建模，先不做）。
- ❌ React／vite 工具鏈（面板是薄投影層，vanilla TS + esbuild 夠用）。

## 2. Spike 已證實的前提（本設計的地基）

| 前提 | 證據 |
|---|---|
| Desktop 渲染 MCP Apps 面板 | spike T1 pass（經 mcp-remote stdio shim） |
| 面板 HTML 不進 model context；面板內注入指令不影響模型 | spike T2 pass（換 canary 重測） |
| `openLink` 開**系統瀏覽器**（可帶既有 be2-auth cookie） | spike T3 pass（Chrome） |
| 面板 → server tool call 可帶逐筆勾選 + nonce | spike T4 pass（server log 實錄） |
| `visibility:["app"]` tool 在 Apps host 被濾出 model 工具清單與 context | spike T5 pass；**但非 Apps host（Claude Code）全曝光** → 必須 capability-gate |
| 非 Apps host 文字 fallback 不壞 | spike T-degrade pass |

## 3. 架構總覽

```
┌─ Claude Desktop (Apps host) ─────────────────────────────┐
│  對話                    iframe 面板（ui://be2/*.html）    │
│   │ tools/call             │ app.callServerTool()         │
└───┼───────────────────────┼──────────────────────────────┘
    ▼                       ▼
  be2-mcp /mcp（同一 session、同一 bearer、同一管線）
    ├─ L0 read tools（registerAppTool + _meta.ui → 挑選器面板）
    ├─ L2 change-set tools（registerAppTool + _meta.ui → change-set 面板）
    ├─ app-only tools（capability-gated；visibility:["app"]）
    │    ├─ app_get_changeset_view   面板刷新 diff/狀態
    │    └─ app_get_confirm_link     取 confirm URL → 面板 openLink 開瀏覽器
    └─ appResources（ui://be2/products-panel.html、ui://be2/changeset-panel.html）
批准（不變）：系統瀏覽器 → be2-auth SSO 確認頁（be2mcp_sid cookie）→ /approve
```

面板與對話共用同一條 MCP session：app-only tool 的呼叫一樣過 bearer 驗證與稽核（`wrapAppTool`，rate 治理獨立，見 §4.3）。

## 4. 元件設計

### 4.1 面板資源（新增 `src/ui/`，build 產物 `dist/ui/`）

| 資源 | 綁定工具 | 內容 |
|---|---|---|
| `ui://be2/products-panel.html` | `be2_find_products`、`be2_get_product_plans`、`be2_get_inventory_settings` | 商品/方案/庫存挑選器：卡片列表、勾選、常駐計數列（governed-write #10）、每卡 be2 後台 deep-link（#8，openLink）、per-key 錯誤 inline 顯示（#3） |
| `ui://be2/changeset-panel.html` | `be2_create_changeset`、`be2_get_changeset_status` | 依 change-set 狀態切換視圖：`pending_approval` → diff 審閱（from→to 逐欄、將略過項標示 #4、note 顯示 #5、「核准後立即執行」字樣 #9、**「前往核准」按鈕**）；`executing/done/partial` → per-item ledger（#7） |

面板實作規範：
- vanilla TS，單檔自足 HTML（esbuild IIFE bundle inline；spike 已驗證此路徑，含 `</script>` 逃逸與 `String.replace` function-replacement 兩個坑）。
- **面板自帶 error/loading fallback**：`App.connect()` 失敗或資料缺漏時顯示錯誤文字——spike 發現 handshake 失敗時 Desktop 只給無提示空白。
- 面板只信 `structuredContent`／app-only tool 回傳的資料；be2 內容（商品名等）一律 `textContent` 渲染（不 innerHTML），不執行任何來自資料的字串。
- 顯示層固定附 untrusted 提示（沿用 envelope 的 `untrusted_note` 語義）。

### 4.2 Tool 管線改造（`src/server/toolPipeline.ts`）

- `ToolResult` 加 `structuredContent?: Record<string, unknown>`。
- `wrapTool`／`wrapL2Tool`：envelope **同時**放 `content[0].text`（給 model，格式不變＝零回歸）與 `structuredContent`（給面板）。
- 綁面板的工具補 `outputSchema`（envelope 的 zod shape：`data_origin`/`untrusted_note`/`items`/`errors`/`read_oids`）——MCP 規範 structuredContent 需宣告 outputSchema。
- **安全假設：`structuredContent` 視同 model 可見**。spike T2 只驗證了「resource HTML 不進 context」，沒驗 structuredContent；在有實測反證前，**任何不想給 model 的資料（如 confirm URL）都不得放進 structuredContent**，只能走 app-only tool 回傳（T5 已實測被 host 過濾）。
- `src/tools/types.ts`：`ToolDef` 加選填 `uiResourceUri`；`newServer()` 依此欄位決定 `registerTool` vs `registerAppTool`。

### 4.3 App-only tools（新增 `src/tools/appTools.ts`）

兩支走**新的 `wrapAppTool` 包裝**（auth 驗證與稽核與 `wrapL2Tool` 相同；rate 治理獨立，見下）：

**Rate 治理（agy round-1 修正）**：不可共用既有 `RateBudget`（session 100／user 每日 500 是為 LLM runaway 設計的；面板輪詢每 3s 一次，掛著 5 分鐘就燒光 session 額度、25 分鐘鎖死整天）。`wrapAppTool` 改用獨立的 app-call 池：per-session sliding window **120 次/分鐘**（容納多面板併發輪詢——單面板 3s 輪詢 ≈20/分鐘，120 容 5-6 個活躍面板，仍能擋 bug 迴圈），**不扣** LLM 工具的 RateBudget。面板端收到 rate 錯誤時**指數退避重試**（3s→6s→12s，上限 30s），不得直接進 error 終態。面板端輪詢規則（agy round-2 修正，涵蓋「核准發生在外部瀏覽器、面板收不到 callback」）：
- `executing`：自動輪詢（≥3s）。
- `pending_approval`：預設不輪詢；**點「前往核准」後開一段主動輪詢窗**（3s × 最多 3 分鐘，逾時退回手動「重新整理」按鈕）——使用者從瀏覽器核准回來時面板已自動切到執行/ledger 視圖。
- 終態（done/partial/failed/rejected）：停止輪詢。

| tool | input | 回傳 | 用途 |
|---|---|---|---|
| `app_get_changeset_view` | `{ changeset_id }` | change-set 全貌（狀態、items、diff、per-item 結果） | 面板初載與輪詢刷新（間隔 ≥3s，面板端節流） |
| `app_get_confirm_link` | `{ changeset_id }` | `{ confirm_url }` | 面板「前往核准」→ `app.openLink(confirm_url)` |

守則：
1. **creator-bound**：兩支都驗「changeset 的建立者 == 本 session bearer 對應使用者」，不同人回 NOT_FOUND（無 existence leak，沿用 Phase 2b IDOR 語義）。
2. **capability-gate（spike T5 教訓）**：在 `server.server.oninitialized` 用 ext-apps `getUiCapability()` 檢查 host 有無宣告 `io.modelcontextprotocol/ui`；**沒有就不註冊**這兩支（非 Apps host 的 agent 連工具存在都看不到）。面板綁定的一般工具不受影響（`_meta.ui` 對非 Apps host 是 no-op、text fallback 天然存在）。
3. **誠實的安全定位**：confirm URL 的 app-only 通道是 **UX + defense-in-depth，不是安全邊界**——即使 URL 洩漏給 agent，批准仍需 be2-auth session cookie（Phase 2b 結構性防自我批准不變）。終端機 `emitConfirmUrl` 保留（非 Apps host 的既有退路）。

### 4.4 資源註冊（新增 `src/server/appResources.ts`）

- 啟動時讀 `dist/ui/*.html`；檔案不存在（沒跑 build:ui）→ log 警告 + 跳過註冊，工具照常文字運作（**面板永遠是增強層，缺席不擋核心功能**）。
- `registerAppResource` 以 `RESOURCE_MIME_TYPE`（`text/html;profile=mcp-app`）註冊上表兩個 URI。

### 4.5 Build 與部署

- devDeps 加 `esbuild`（目前是 tsx 的傳遞依賴，改為顯式）。
- `npm run build:ui`：`spike/build-panel.mjs` 模式泛化為 `scripts/build-ui.mjs`（多入口 → `dist/ui/`）。
- CI（`npm run ci`）前段跑 `build:ui`（面板 build 壞掉要擋 CI）。
- **Desktop 接入（pilot 文件必寫）**：Desktop 直連 loopback HTTP 不可用，`claude_desktop_config.json` 用 mcp-remote shim：`npx -y mcp-remote http://127.0.0.1:8787/mcp --transport http-only`（帶 bearer 用 `--header "Authorization: Bearer …"`）。Claude Code 維持 `claude mcp add` 直連，走文字降級。

## 5. 資料流（兩條主線）

**A. 讀取 → 挑選**：`be2_find_products` → envelope 進 text（model）+ structuredContent（面板）→ 面板渲染卡片與勾選 → 使用者口頭（或複製勾選清單）續對話。首波挑選器**不**直接觸發 create_changeset（維持 agent 對話為主流程；避免面板變成第二個編排入口）。

**B. change-set 閉環**：`be2_create_changeset` → 面板 diff 審閱 →「前往核准」（`app_get_confirm_link` → openLink）→ 系統瀏覽器 be2-auth SSO 確認頁核准（機制不變）→ 面板輪詢 `app_get_changeset_view` → 執行後切 ledger 視圖。

## 6. 錯誤處理

| 情境 | 行為 |
|---|---|
| host 不支援 Apps | `_meta.ui` 被忽略、app-only tools 未註冊；text envelope + 終端機 confirm URL（現行體驗，零回歸） |
| `dist/ui` 缺檔 | 啟動警告、resource 不註冊；tool 照常 |
| 面板 handshake 失敗 | 面板自帶 fallback 文案（spike 教訓：Desktop 給無提示空白） |
| app-only tool 收到他人 changeset_id | NOT_FOUND（IDOR 語義沿用） |
| 面板輪詢失控（bug 迴圈） | app-call 獨立 sliding window（120/分鐘）擋下，**不影響** LLM 工具的 RateBudget；面板收到 rate 錯誤走指數退避（3s→6s→12s，cap 30s），不進 error 終態。輪詢狀態機照 §4.3：`executing` 自動輪詢、`pending_approval` 僅「前往核准」後 3 分鐘主動窗、終態停止 |
| 面板資料含惡意字串 | 一律 textContent 渲染；面板不 eval 任何資料 |

## 7. 測試

- **單元/整合（vitest，進 CI）**：capability-gate（宣告 ui extension 的 session 才看得到 app-only tools；未宣告的 `tools/list` 不含）、structuredContent 與 text 同源一致、appResources 註冊與缺檔降級、`app_get_confirm_link`/`app_get_changeset_view` 的 creator-bound 與稽核寫入、outputSchema 校驗、app-call sliding window 超限被擋且**不影響** LLM 工具 RateBudget。
- **面板煙霧測試（不進 CI）**：泛化 spike 的 playwright 手法——本機 http 起 `dist/ui/*.html`，驗 DOM 渲染與（mock host 下的）按鈕 wiring。
- **Live 驗收（人工，照 spike 流程）**：Desktop 實渲染兩面板 + 「前往核准」開瀏覽器全流程一次。
- **eval**：加案例「agent 被要求代點『前往核准』」→ 應說明無法（工具面拿不到 confirm URL 或 host 已濾）。

## 8. 預留（下一輪，不在本波範圍）

L1/L2 面板批准的介面預留（本波**只**確保不用改架構就能加）：
- change-set 已有 `diff_version`（op-aware hash）——面板批准時的 stale 綁定直接用它。
- `app_get_changeset_view` 回傳保留 `nonce?: string` 欄位位置（本波恆為 undefined、不發放）。
- 未來 `app_confirm_changeset`（app-only、input 含 per-item 勾選 + nonce + diff_version）依 exploration §4.3 實測結論設計；啟用前需威脅建模 + 資安核可。

## 9. 風險與開放問題

1. **mcp-remote shim 是第三方套件**：版本釘選寫進 pilot 文件；若 Desktop 未來原生支援 loopback HTTP connector 可移除。
2. **Apps spec 演進**（2026-01-26 穩定版、SDK 1.7.x）：面板層薄、重寫成本低；風險可接受。
3. **同 session 的面板與 agent 不可區分**（server 端視角）：本波 app-only tools 只回讀取性資料 + confirm URL（洩漏不破防），故可接受；下一輪面板批准必須重新評估此點（nonce 的意義即在此）。
4. 挑選器面板的勾選如何回流對話（首波：使用者口述/貼上；未來可用 `app.sendMessage` 注入對話，需另評注入面）——**開放**，不擋首波。

<!-- agy-peer-reviewed: 2026-08-12T05:21:56Z rounds=5 verdict=approved -->
