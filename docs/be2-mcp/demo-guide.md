# be2 MCP — Demo 腳本 (Demo Guide)

> 對象：下週二 Demo 主講人。這份文件包含了演前準備清單、推薦展演動線及話術、與 Q&A 防禦預設。

## 1. 演前 Checklist (Live Demo 必備)

- [ ] **啟動 Server**：確認 `npm run dev` 在背景運行。
- [ ] **編譯 UI**：確認已執行過 `npm run build:ui` (供精靈面板渲染用)。
- [ ] **環境變數確認**：檢查 `.env` 指向 SIT `be2-220`。
- [ ] **Identity 新鮮度**：確定上次登入距離現在小於 12 小時 (refresh 仍有效)；保險起見，**建議現場砍掉重登**展示完整 OAuth 流程。
- [ ] **Claude Desktop 設定**：`claude_desktop_config.json` 確認已使用 `mcp-remote` 指向 `http://127.0.0.1:8787/mcp`。
- [ ] **標的商品準備**：預選可安全操作的測試商品 OID `34133` (以及備用的 `9468`)；**確認示範方案現況**（1944031 上架中 → 排程方向選「下架」，見 131105 教訓）。
- [ ] **備案預埋**：server 以 `BE2_MCP_DEV_PANEL=1 npm run dev` 啟動，備案面板隨時可切。

> 完整彩排結果見 [`demo-rehearsal-2026-08-16.md`](./demo-rehearsal-2026-08-16.md)。

## 2. 建議展演動線與講稿

### Step 1: 接入 (OAuth 2.1)
- **畫面**：終端機執行 `claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp` (或在 Desktop 開啟對話)。
- **操作**：觸發 OAuth 認證，瀏覽器彈出 `be2-auth` 登入。
- **講稿要點**：
  - 「我們完全整合了公司的標準身份認證 (kkday-auth-service)。」
  - 「**安全三要點**：(1) AI 看不到密碼。(2) AI 拿不到真實 token。(3) 憑證不離境，我們只把『取貨代碼』發給 AI，真 token 全扣在我們自己的伺服器上。」

### Step 2: 對話查詢 (L0 Read)
- **畫面**：在 Claude 內輸入「我想針對 34133 和 9468 的方案進行上下架處理」。
- **操作**：AI 逐商品讀取方案後，整合成單一表格（商品/方案/pkg_oid/現況），並追問你要異動哪些方案——這是刻意設計的對話流（工具引導 + scope-binding 結構強制先讀後寫）。
- **講稿要點**：
  - 「這背後代理了 gateway 的驗證，AI 是以『我』的身份去查，沒有越權風險。」

### Step 3: 批次精靈 (shelf_schedule)
- **畫面**：輸入「幫我把 34133 這些方案排程明天中午 12 點**下架**」。
- ⚠️ **彩排教訓（131105）**：be2 規定第一筆排程狀態必須與方案現況相反——1944031 目前上架中，示範必須排「下架」（排「上架」會在建 draft 時被我們的預檢擋下並顯示人話錯誤，這本身也可以當防呆展示）。
- **操作**：
  - Desktop 彈出互動精靈面板。
  - 在面板上檢視差異 (Diff)，並點擊批准。
  - 成功後自動觸發「讀回驗證 (✓)」。
- **講稿要點**：
  - 「這是最新的 Phase 4a 批次精靈。AI 幫你備好草稿，但**按確認的是活生生的人**。」
  - 「這個面板跑在受限制的環境，AI 拿不到面板核准所需的 nonce 憑證，所以 AI 絕對無法自己偷按。」
  - 「這個排程是寫入 be2 的原生排程，時間到了由 be2 自動上架。」

### Step 4: 安全防護展示
- **畫面**：請 AI「不要開面板，直接幫我寫入資料」。
- **操作**：AI 會道歉並表示自己無法直接寫入。
- **畫面**：展示 DB 的 `audit_log` 記錄。
- **講稿要點**：
  - 「遵守 Draft-only 鐵則。AI 沒有工具能直接寫入，它甚至連批准工具的存取權都沒有。」
  - 「所有操作 (包含工具呼叫、批准、執行) 都寫入 append-only 的 audit log，而且裡面**沒有任何明文 token**。」

### Step 5: 架構總結
- **畫面**：秀出 `design-overview.md` 的 ASCII 架構圖。
- **講稿要點**：
  - 「我們完成了 Phase 5 模組化，把核心治理和領域邏輯拆開。未來要加『訂單』或『促銷』，只要寫一個模組掛上去，不用碰核心的安全邏輯。」

## 3. 風險與備案表

| 突發狀況 | 備案處理 | 備註 |
|---|---|---|
| **SIT 掛了或 Gateway timeout** | 改開 `http://127.0.0.1:8787/dev/panel/batch-wizard` harness。**前提：server 一開始就要用 `BE2_MCP_DEV_PANEL=1 npm run dev` 啟動（彩排實測沒帶 flag 是 404）**，local-only。 | 證明面板渲染與機制正常，僅後端無回應。 |
| **Tool call 說過期 401** | **正好展示 L2 Refresh！** 但如果連 refresh 12h 都過期，只需請 AI 重試觸發重走 OAuth。 | 「看，我們的 12 小時安全憑證正好過期了，機制正常運作。」 |
| **Desktop 面板出不來 (純文字)** | **順勢展演「退路 (Fallback)」**。點擊終端機/純文字給的連結，到瀏覽器完成 SSO 核准。 | 「當 UI 渲染失敗或你在無頭環境，系統會自動降級到無懈可擊的瀏覽器 SSO 確認。」 |

## 4. Q&A 預想防禦

1. **問：為什麼不自己在 MCP 裡建一個 RBAC 權限表？**
   答：避免雙重真理。我們完全委派 auth-service 的 `businessList` 做第一層擋，再由 be2 gateway 在執行當下做物件級 (per-OID) 驗證。我們只做 pass-through。
2. **問：真實憑證真的不會洩漏給 Anthropic 嗎？**
   答：不會。我們採用 Option 1 (Server Store)，發給 AI 的是一串無效的不透明字串，真實的 be2 access/refresh token 死鎖在我們的內網 SQLite 裡。
3. **問：現在是單機，之後要怎麼上正式環境支援多人？**
   答：這正是我們 `design-overview.md` 裡列的未竟之處。核心邏輯不變，但需要把目前的 in-process 鎖 (CAS、rate budget、refresh single-flight) 搬到 Redis 或 Postgres 上。
4. **問：加一個新領域 (如折扣券) 成本高嗎？**
   答：極低。Phase 5 完成後，我們提供了標準的 `ActionModule` 介面，只要探勘好端點行為 (contract probe) 並實作那 5 個函式，不需要動到核心架構。
5. **問：這跟之前上線的 `dev-tools` 有什麼不一樣？**
   答：`dev-tools` 處理的是對開發機的系統級指令，而 be2-mcp 直接修改生產庫存和商品。因此，我們多加了 auth-service 內核、draft-only 防護、雙層批准通道以及嚴格的模組化拆分。
