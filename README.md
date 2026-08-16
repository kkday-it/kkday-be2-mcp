# be2 MCP (Model Context Protocol)

be2 MCP 是夾在 Claude agent 與 be2 商品後台之間的「治理層」伺服器，讓員工透過自然語言安全地完成批次任務。
它不只是一個 API 代理，而是一個具備完整權限控管、變更狀態機與稽核機制的安全閘道，確保所有對生產環境的寫入都符合企業標準：不盲寫、不自我批准、且全鏈路留存稽核紀錄。

> 🟢 **現況：Phase 1a–5 完成 | 473 tests passed / 0 skipped | SIT be2-220 Live 全鏈路驗收通過**

## 核心特性

- **draft-only 人工批准**：agent 只能建立 change-set 草稿，寫入一律須經獨立通道（面板或確認頁）人工核准。
- **身份貫穿 (Identity Pass-through)**：使用 auth-service 登入發放之 be2 token，不自建 RBAC，授權判斷委派給後端 gateway。
- **模組化 domain**：每個業務領域（如上下架、庫存）封裝為獨立的 module，新增 action type 不碰 core。
- **批次精靈面板 (Batch Wizard)**：支援 Claude Desktop MCP Apps 渲染互動式批准面板與操作精靈。
- **全鏈路稽核 (Append-only Audit)**：紀錄從 tool call 到執行每一步的 trace，且決不儲存明文 token。

## 系統架構

```
Claude Client (Code/Desktop)
       │
       │ (MCP over Streamable HTTP + OAuth 2.1 不透明參考 token)
       ▼
┌─────────────────────────── be2-mcp server (治理層) ───────────────────────────┐
│                                                                             │
│  [OAuth 2.1 外殼] 負責 Discovery / DCR / PKCE                                │
│        │                                                                    │
│  [Core 治理層]   change-set 狀態機、CAS 防重複、scope-binding、稽核留存      │
│        │                                                                    │
│  [Domain Modules] (src/modules/product/*)                                   │
│    ├─ shelfToggle (上下架)                                                  │
│    ├─ inventorySetting (數量)                                               │
│    ├─ inventoryPlatform (平台切換)                                          │
│    └─ shelfSchedule (排程)                                                  │
│                                                                             │
└─┬───────────────────────────────┬─────────────────────────────────────────┬─┘
  │ (帶 be2 JWT 查改)             │ (帶 service key 換碼/refresh)            │ (互動批准)
  ▼                               ▼                                         ▼
be2 gateway /product/api/v1      auth-service /api/v1/          UI 面板 (mcp-ui) / 確認頁 SSO
```

## 安全模型摘要

| 安全機制 | 防禦對象與效果 |
|---|---|
| **OAuth 2.1 外殼** | 防 agent 竊取帳密。帳密只在 POPUP 打給 be2-auth，agent 僅取得短效 code 交換 token。 |
| **Token 不離境** | 防憑證外洩。真 token 存於 server 端，給 agent 的是無授權效力的不透明隨機字串。 |
| **draft-only + SSO/Nonce 批准** | 防 agent 幻覺/惡意寫入。agent 拿不到 `be2mcp_sid` (SSO) 或 nonce (面板)，結構上無法自我批准。 |
| **scope-binding** | 防提示詞注入。change-set 只允許操作同一個對話 session 內 `L0` 工具「讀取過」的對象。 |
| **businessList fail-fast** | 防越權嘗試。auth-service 發放的 `businessList` 在 MCP 層提早擋下無權限的動作。 |

## 快速開始

1. **安裝依賴**
   ```bash
   npm install
   ```

2. **環境變數準備**
   請複製 `.env.example` 為 `.env`。**絕對不可填寫、commit 任何真實生產環境 token 或密碼**。需要一組 SIT `SIT_AUTHSVC_SERVICE_KEY`。

3. **啟動 Server & 建置 UI**
   ```bash
   npm run build:ui
   npm run dev
   ```

4. **Claude 接入 (以 Claude Code 為例)**
   ```bash
   claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp
   ```
   *執行後將於瀏覽器彈出 be2-auth SSO 登入頁。*

5. **測試**
   ```bash
   npm run ci
   ```

## 專案結構樹

```text
src/
 ├─ core/       # 治理層基礎設施 (change-set、CAS、audit、store)
 ├─ oauth/      # OAuth 2.1 外殼 (Discovery, DCR, authorize, token routes)
 ├─ auth/       # 認證內核 (TokenManager、auth-service 介接)
 ├─ server/     # Streamable HTTP server, confirm routes, 路由組裝
 ├─ tools/      # MCP tools 註冊與介面
 ├─ ui/         # 面板與精靈的 isomorphic 前端 (esbuild 打包入口)
 └─ modules/    # Domain modules 實作 (純業務邏輯)
     └─ product/
         ├─ shelfToggle/       # 商品/方案上下架模組
         ├─ inventorySetting/  # 庫存數量修改模組
         ├─ inventoryPlatform/ # 庫存平台切換模組
         └─ shelfSchedule/     # 上下架排程模組
```

## 文件地圖

- [`CLAUDE.md`](./CLAUDE.md) — 開發鐵則與指令大全。
- [`docs/be2-mcp/design-overview.md`](./docs/be2-mcp/design-overview.md) — 一篇看懂 MCP 架構與關鍵決策 (Demo / 架構導覽必讀)。
- [`docs/be2-mcp/demo-guide.md`](./docs/be2-mcp/demo-guide.md) — 展演與功能 Demo 標準腳本。
- [`docs/be2-mcp/security-model-explainer.md`](./docs/be2-mcp/security-model-explainer.md) — 白話文版安全模型解釋。
- [`docs/be2-mcp/oauth-runbook.md`](./docs/be2-mcp/oauth-runbook.md) — OAuth 接入、refresh 機制與 SSO 說明。
- [`docs/be2-mcp/mcp-apps-runbook.md`](./docs/be2-mcp/mcp-apps-runbook.md) — Claude Desktop 面板批准機制使用指南。
- [`docs/be2-mcp/phase4a-runbook.md`](./docs/be2-mcp/phase4a-runbook.md) — 批次精靈 (庫存平台/排程) 操作指南。
- [`docs/be2-mcp/module-catalog.md`](./docs/be2-mcp/module-catalog.md) — 已實作模組清單。
- [`docs/be2-mcp/module-onboarding.md`](./docs/be2-mcp/module-onboarding.md) — 新 domain / action type 接入檢查表。
