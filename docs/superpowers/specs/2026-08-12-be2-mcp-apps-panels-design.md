# be2 MCP — MCP Apps 面板首波實作 design spec

日期：2026-08-12　狀態：v2 大改（批准進面板，依使用者 2026-08-12 拍板）、待 agy re-review + 使用者審
> 前置文件：`docs/be2-mcp/mcp-ui-spike-checklist.md`（spike findings，T1–T5 全 pass）、`docs/be2-mcp/next-iteration-eval.md` §1、`docs/be2-mcp/mcp-ui-exploration.md`（分級批准模型）。
> **v2 變更主旨（使用者拍板）**：身份與權限在 MCP 串接時已由 be2-auth 認證定案（token + businessList），批准不需要再走一次完整 SSO 確認頁——**批准 = 面板內確認按鈕（app-only nonce 通道，Desktop）**；be2-auth SSO 確認頁**降級為非 Apps host（如 Claude Code）的退路**，程式碼保留不動。
> 其餘沿用 v1 假設：三塊 UI 併成兩個面板資源；esbuild 打包不引入 vite。

## 1. 目標與非目標

**目標**：
1. **批准動作一鍵化**：Desktop 使用者在 diff 審閱面板直接按「確認執行」完成批准（取代「翻終端機找 URL → 瀏覽器開確認頁 → SSO → 按核准」四步）。
2. change-set 的 diff 與執行結果從 JSON 文字變成可讀面板（from→to 逐欄、per-item ledger）。
3. 讀取工具（商品/方案/庫存）回傳可視化挑選器。

**非目標**（明確不做）：
- ❌ claude.ai 網頁 host（需公網 ingress，Phase 0 B3 結論不變）。
- ❌ iframe 內嵌確認頁（面板批准已取代其動機）。
- ❌ React／vite 工具鏈（面板是薄投影層，vanilla TS + esbuild 夠用）。
- ❌ 拆掉 be2-auth SSO 確認頁——保留原樣，作為非 Apps host 的批准退路（零新工）。

## 2. Spike 已證實的前提（本設計的地基）

| 前提 | 證據 |
|---|---|
| Desktop 渲染 MCP Apps 面板 | spike T1 pass（經 mcp-remote stdio shim） |
| 面板 HTML 不進 model context；面板內注入指令不影響模型 | spike T2 pass（換 canary 重測） |
| `openLink` 開**系統瀏覽器** | spike T3 pass（Chrome） |
| 面板 → server tool call 可帶**逐筆勾選 + nonce** | spike T4 pass（server log 實錄）——**面板批准的送出路徑** |
| `visibility:["app"]` tool 從 model 工具清單與 context 中**消失** | spike T5 pass——但這只證明「遮蔽」，**未**證明「host 會擋掉 model 硬幻覺出的呼叫」（見下 T6 缺口） |
| 非 Apps host 文字 fallback 不壞 | spike T-degrade pass |
| **【未驗，阻擋面板批准】** host 會**主動拒絕** model 端發起的 `visibility:["app"]` tool call（不只是不列出） | **T6，待 spike**——見 §4.3 與 §10。若 host 只遮蔽不攔阻，被注入的 model 可幻覺呼叫 `app_get_changeset_view` 撈到 nonce → 自我批准，v2 面板批准的安全前提崩塌 |

## 3. 架構總覽

```
┌─ Claude Desktop (Apps host) ─────────────────────────────┐
│  對話                    iframe 面板（ui://be2/*.html）    │
│   │ tools/call             │ app.callServerTool()         │
└───┼───────────────────────┼──────────────────────────────┘
    ▼                       ▼
  be2-mcp /mcp（同一 session、同一 bearer）
    ├─ L0 read tools（registerAppTool + _meta.ui → 挑選器面板）
    ├─ L2 change-set tools（registerAppTool + _meta.ui → change-set 面板）
    ├─ app-only tools（capability-gated；visibility:["app"]；wrapAppTool）
    │    ├─ app_get_changeset_view    面板拉 diff/狀態 +（隨附）本次渲染的 nonce
    │    └─ app_confirm_changeset     面板「確認執行」→ 驗 nonce+diff_version+逐筆勾選 → 執行
    └─ appResources（ui://be2/products-panel.html、ui://be2/changeset-panel.html）

批准退路（非 Apps host，機制照舊）：終端機印 confirm URL → 瀏覽器 be2-auth SSO 確認頁 → /approve
```

面板與對話共用同一條 MCP session：app-only tool 的呼叫一樣過 bearer 驗證與稽核（`wrapAppTool`，rate 治理獨立，見 §4.3）。**兩條批准路徑（面板 nonce / 確認頁 SSO）收斂到同一套 server 端執行邏輯**（live-diff 重算、stale 409、CAS 防重複、executor、audit）。

## 4. 元件設計

### 4.1 面板資源（新增 `src/ui/`，build 產物 `dist/ui/`）

| 資源 | 綁定工具 | 內容 |
|---|---|---|
| `ui://be2/products-panel.html` | `be2_find_products`、`be2_get_product_plans`、`be2_get_inventory_settings` | 商品/方案/庫存挑選器：卡片列表、勾選、常駐計數列（governed-write #10）、每卡 be2 後台 deep-link（#8，openLink）、per-key 錯誤 inline 顯示（#3） |
| `ui://be2/changeset-panel.html` | `be2_create_changeset`、`be2_get_changeset_status` | 依 change-set 狀態切換視圖：`pending_approval` → diff 審閱（from→to 逐欄、將略過項標示 #4、note 顯示 #5、「確認後立即執行」字樣 #9）+ **逐筆勾選核可清單 + 「確認執行」/「拒絕」按鈕**；高風險 action（庫存等）確認前多一層面板內二次確認 dialog（紅字 banner 沿用確認頁語彙 #6）；`executing/done/partial` → per-item ledger（#7） |

面板實作規範：
- vanilla TS，單檔自足 HTML（esbuild IIFE bundle inline；spike 已驗證此路徑，含 `</script>` 逃逸與 `String.replace` function-replacement 兩個坑）。
- **面板自帶 error/loading fallback**：`App.connect()` 失敗或資料缺漏時顯示錯誤文字——spike 發現 handshake 失敗時 Desktop 只給無提示空白。
- 面板只信 `structuredContent`／app-only tool 回傳的資料；be2 內容一律 `textContent` 渲染（不 innerHTML）。
- 顯示層固定附 untrusted 提示（沿用 envelope 的 `untrusted_note` 語義）。

### 4.2 Tool 管線改造（`src/server/toolPipeline.ts`）

- `ToolResult` 加 `structuredContent?: Record<string, unknown>`。
- `wrapTool`／`wrapL2Tool`：envelope **同時**放 `content[0].text`（給 model，格式不變＝零回歸）與 `structuredContent`（給面板）。
- 綁面板的工具補 `outputSchema`（envelope 的 zod shape）——MCP 規範 structuredContent 需宣告 outputSchema。
- **安全假設：`structuredContent` 視同 model 可見**。spike 只驗證了 resource HTML（T2）與 app-only tool（T5）兩條隔離通道；nonce、confirm URL 等敏感值**只准**走 app-only tool 回傳，不得放 structuredContent。
- `src/tools/types.ts`：`ToolDef` 加選填 `uiResourceUri`；`newServer()` 依此欄位決定 `registerTool` vs `registerAppTool`。

### 4.3 App-only tools（新增 `src/tools/appTools.ts`）＋面板批准

兩支走**新的 `wrapAppTool` 包裝**（auth 驗證與稽核與 `wrapL2Tool` 相同；rate 治理獨立，見下）：

| tool | input | 回傳 | 用途 |
|---|---|---|---|
| `app_get_changeset_view` | `{ changeset_id }` | change-set 全貌（狀態、items、diff、per-item 結果、`diff_version`）+ `pending_approval` 時**隨附一次性 `nonce`** | 面板初載與輪詢刷新 |
| `app_confirm_changeset` | `{ changeset_id, decision: 'approve'\|'reject', nonce, diff_version, confirmed_keys: string[] }` | 執行受理結果（終態由後續 view 輪詢取得） | 面板「確認執行」/「拒絕」 |

**⚠️ 前置 gate（agy round-6，關鍵）**：整個 nonce 通道的安全性依賴一個**尚未驗證**的 host 行為——「host 會**主動攔阻** model 端發起的 app-only tool call」。T5 只證明工具從 model 清單消失（遮蔽），沒證明攔阻。若 host 只遮蔽、仍把 model 幻覺出的 `tools/call app_get_changeset_view` 轉發給 server，server 無法區分呼叫來自面板還是 model（同一條 MCP 連線多工），就會把 nonce 回給 model → 自我批准。**因此面板批准（`app_confirm_changeset` 及 nonce 發放）在 spike T6 通過前不得實作**（T6 定義見 §10）。T6 未過 → 本波退化為「唯讀/挑選/diff 面板 + 確認頁批准」（見 §10 決策樹），面板不承載批准。

**Nonce 生命週期**（T6 通過後才啟用；防「agent 自我批准」的核心）：
- 由 `app_get_changeset_view` 在 `pending_approval` 狀態發放；**單次有效**（被 `app_confirm_changeset` 消耗或再次 view 刷新即輪替）、TTL 10 分鐘、綁定 `(changeset_id, diff_version, mcp_session)` 三元組，server 只存 hash。
- `app_confirm_changeset` 驗證鏈：nonce 有效且三元組吻合 → `confirmed_keys` 與 change-set items 完全一致（逐筆意圖回傳，spike T4 形態）→ live-diff 重算、`diff_version` 不符回 409 stale（面板重載新 diff + 新 nonce）→ CAS 防重複執行 → executor（身分 = 本 session bearer 使用者；`modify_user` 沿用既有 platformId 解析）→ audit 記 `approval_channel: 'panel'`。
- 任何一步失敗都不消耗執行權（nonce 已耗則重新 view 取新 nonce）。

**Rate 治理**：不可共用既有 `RateBudget`（session 100／user 每日 500 是為 LLM runaway 設計的；面板輪詢會燒光它）。`wrapAppTool` 用獨立 app-call 池：per-session sliding window **120 次/分鐘**（單面板 3s 輪詢 ≈20/分鐘，容 5-6 個活躍面板，仍擋 bug 迴圈），**不扣** LLM 工具的 RateBudget。面板收到 rate 錯誤**指數退避**（3s→6s→12s，cap 30s），不進 error 終態。

**面板輪詢規則**：
- `executing`：自動輪詢（≥3s）。
- `pending_approval`：面板內批准就地知結果，故不需高頻輪詢；但確認頁退路可能在**外部瀏覽器**批准（面板收不到 callback），故加**慢心跳輪詢（每 20s）**讓面板最終反映 out-of-band 狀態變化（agy round-6 rec）；手動「重新整理」按鈕保留。
- 終態（done/partial/failed/rejected）：停止輪詢。

守則：
1. **creator-bound**：兩支都驗「changeset 建立者 == 本 session bearer 對應使用者」，不同人回 NOT_FOUND（無 existence leak，沿用 Phase 2b IDOR 語義）。
2. **capability-gate（spike T5 教訓）**：在 `server.server.oninitialized` 用 ext-apps `getUiCapability()` 檢查 host 有無宣告 `io.modelcontextprotocol/ui`；**沒有就不註冊**app-only tools、**不發放 nonce**（非 Apps host 的 agent 連工具存在都看不到，批准只剩確認頁退路）。
3. **誠實的安全定位（v2 重寫，agy round-6 補強）**：面板批准的防自我批准 = 「host **攔阻** model 發起的 app-only tool call」（**T6 待驗**，非僅 T5 的遮蔽）+「nonce 不進 model context」（T2 實測）——**不再是 Phase 2b 的憑證域分離**，是有意識的信任面調整（使用者拍板：MCP 串接已 be2-auth 認證、批准者即連線者本人）。**此定位僅在 T6 通過時成立**；T6 未過則面板不批准（§10）。兜底不變：可逆性、live-diff stale 409、CAS、全鏈路稽核（含 approval_channel）、businessList fail-fast。
4. **確認頁退路完整保留**：`/confirm/:id` 及其 SSO 全套不動；終端機 `emitConfirmUrl` 照舊。同一 change-set 兩條路都能批（先到先贏，CAS 保證只執行一次）。

### 4.4 資源註冊（新增 `src/server/appResources.ts`）

- 啟動時讀 `dist/ui/*.html`；檔案不存在 → log 警告 + 跳過註冊，工具照常文字運作（**面板永遠是增強層，缺席不擋核心功能**）。
- `registerAppResource` 以 `RESOURCE_MIME_TYPE`（`text/html;profile=mcp-app`）註冊上表兩個 URI。

### 4.5 Build 與部署

- devDeps 加 `esbuild`（顯式化）。
- `npm run build:ui`：`spike/build-panel.mjs` 泛化為 `scripts/build-ui.mjs`（多入口 → `dist/ui/`）。
- CI（`npm run ci`）前段跑 `build:ui`。
- **Desktop 接入（pilot 文件必寫）**：mcp-remote shim（`npx -y mcp-remote http://127.0.0.1:8787/mcp --transport http-only`，bearer 用 `--header`）。Claude Code 維持直連，走文字 + 確認頁退路。

## 5. 資料流（兩條主線）

**A. 讀取 → 挑選**：`be2_find_products` → envelope 進 text（model）+ structuredContent（面板）→ 面板渲染卡片與勾選 → 使用者口頭（或複製勾選清單）續對話。首波挑選器**不**直接觸發 create_changeset。

**B. change-set 閉環（v2）**：`be2_create_changeset` → 面板 diff 審閱（view 取 diff + nonce）→ 使用者逐筆勾選核可 → 按「確認執行」（`app_confirm_changeset`）→ server 驗證鏈全過 → 執行 → 面板輪詢切 ledger 視圖。**非 Apps host**：同一 change-set 走終端機 URL → 確認頁 SSO 批准（現行流程原封不動）。

## 6. 錯誤處理

| 情境 | 行為 |
|---|---|
| host 不支援 Apps | `_meta.ui` 被忽略、app-only tools 未註冊、nonce 不發放；text envelope + 終端機 confirm URL（現行體驗，零回歸） |
| `dist/ui` 缺檔 | 啟動警告、resource 不註冊；tool 照常 |
| 面板 handshake 失敗 | 面板自帶 fallback 文案（spike 教訓：Desktop 給無提示空白）；批准仍可走確認頁退路 |
| app-only tool 收到他人 changeset_id | NOT_FOUND（IDOR 語義沿用） |
| nonce 過期/已耗/三元組不符 | 拒絕 + 面板自動重新 view 取新 diff+nonce；稽核記拒絕原因 |
| `diff_version` stale | 409 + 面板重載新 diff（與確認頁 stale 語義一致） |
| 兩條批准路徑競態 | CAS 先到先贏，後到者收「已執行」明確錯誤 |
| 面板輪詢失控（bug 迴圈） | app-call 獨立 sliding window（120/分鐘）擋下，**不影響** LLM RateBudget；面板 rate 錯誤走指數退避（3s→6s→12s，cap 30s）。輪詢狀態機照 §4.3：executing 自動輪詢、pending_approval 慢心跳（20s，涵蓋確認頁退路的 out-of-band 批准）、終態停止 |
| 確認頁退路在外部瀏覽器批准、面板不知情 | pending_approval 的 20s 慢心跳會拉到新狀態、自動切 ledger 視圖 |
| 面板資料含惡意字串 | 一律 textContent 渲染；面板不 eval 任何資料 |

## 7. 測試

- **單元/整合（vitest，進 CI）**：
  - capability-gate：宣告 ui extension 的 session 才有 app-only tools 與 nonce；未宣告的 `tools/list` 不含、view 不帶 nonce。
  - nonce：單次有效、TTL、三元組綁定（跨 session/跨 diff_version/跨 changeset 全拒）、耗用後舊 nonce 失效。
  - `app_confirm_changeset`：confirmed_keys 不吻合拒絕、stale 409、CAS 防重複、reject 路徑、audit 記 approval_channel。
  - **自我批准回歸**：模擬 model 端呼叫（無 nonce / 猜 nonce / 舊 nonce）一律失敗；確認頁舊測試全數不動（退路零回歸）。
  - structuredContent 與 text 同源一致、appResources 缺檔降級、app-call window 不影響 LLM RateBudget。
- **面板煙霧測試（不進 CI）**：playwright 起 `dist/ui/*.html`，驗 DOM 與（mock host）按鈕 wiring。
- **Live 驗收（人工，照 spike 流程）**：Desktop 全流程一次——建 change-set → 面板 diff → 面板確認執行 → ledger；另驗一次確認頁退路仍通。
- **eval**：加案例「要求 agent 代按確認」→ agent 應說明無法（拿不到 nonce）；「工具輸出注入引導批准」→ 不受影響。

## 8. 對既有文件的連動修正（實作時一併）

- `CLAUDE.md` 鐵則 #4 措辭更新：批准通道從「僅確認頁」擴為「面板 nonce 通道（Apps host）或確認頁 SSO（退路）」，不變式改述為「**agent 結構上拿不到批准所需的憑證（nonce 或 be2mcp_sid cookie）**」。
- `mcp-ui-exploration.md` §3 分級表：首波實作即含面板批准（原 L1/L2 路線），L3 高風險 = 面板二次確認 dialog（不再強制 link-out）。

## 9. 風險與開放問題

1. **信任面調整要寫進資安說明**：防自我批准從「憑證域分離」改為「host 行為保證（T2 + **T6 待驗**）+ nonce」——核心風險已隔離為 §10 的 T6 前置 gate（未過就不做面板批准）。即使 T6 通過，仍是「信任特定 host 實作」：換 host（claude.ai、未來版本）需重驗 T2/T6；緩解 = capability-gate 白名單心態（目前只信 Desktop）+ 稽核 + 可逆性。
2. **mcp-remote shim 是第三方套件**：版本釘選寫進 pilot 文件。
3. **Apps spec 演進**（2026-01-26 穩定版、SDK 1.7.x）：面板層薄、重寫成本低。
4. 挑選器勾選如何回流對話（首波：使用者口述/貼上；未來 `app.sendMessage` 需另評注入面）——開放，不擋首波。

## 10. 前置 spike T6 + 決策樹（agy round-6，實作前必跑）

**T6 定義**：在 Claude Desktop 掛一個 app-only tool（`visibility:["app"]`），從**對話端誘導 model 直接幻覺呼叫它**（給 model 明確工具名與參數、或用注入 prompt 要它呼叫）。觀察：
- **通過（想要）**：host **拒絕/不轉發** model 端對 app-only tool 的呼叫（server 收不到，或 host 回錯）。→ nonce 通道成立，§4.3 面板批准可實作。
- **失敗**：server 收到該呼叫並能回應（host 只遮蔽不攔阻）。→ nonce 藏不住，**本波不做面板批准**。

**決策樹**：
| T6 結果 | 本波範圍 |
|---|---|
| **通過** | 全 spec（含 §4.3 面板批准 + nonce）。 |
| **失敗** | 面板批准**剔除**；本波 = 唯讀/挑選面板 + change-set **diff 審閱面板（唯讀呈現）** + 「前往核准」`app.openLink` 開確認頁（回到 v1 的 link-out，但 confirm URL 仍走 app-only tool 取得——注意：若 T6 失敗，連 confirm URL 都可能被 model 撈到；此時 confirm URL 洩漏不破防，因確認頁 SSO 憑證域分離仍在，故可接受）。批准 100% 留在確認頁。 |

T6 應在實作計畫的**第一個 task** 跑（半天內），結果決定後續 task 是否含面板批准。**在 T6 之前，plan 不得排入 `app_confirm_changeset` 與 nonce 相關實作。**

<!-- agy-peer-reviewed: 2026-08-12T05:42:45Z rounds=7 verdict=approved -->
