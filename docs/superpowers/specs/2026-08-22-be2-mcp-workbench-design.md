# be2 MCP 功能彙整工作台 — 設計 spec

> 日期：2026-08-22　狀態：待 agy-peer-review
> 相關：prototype `docs/be2-mcp/prototypes/workbench-prototype.html`（設計視覺來源）、memory `be2-mcp-workbench-consolidation`、模組化 spec `2026-08-16-be2-mcp-modularization-design.md`、既有 wizard specs（baa-wizard / announcement-wizard / inventory-*）。

## 1. 背景與目標

目前 be2 MCP 有 4 個各自獨立的 MCP Apps 面板（products-panel、changeset-panel、batch-wizard、announcement-wizard），每個功能要 model 各呼叫一個 `open_*` tool 才進得去，使用者得**來回對話切換功能**。

目標：把三大高頻功能——**商品上下架、商品庫存、商品公告**——彙整成**單一「be2 工作台」面板**，左側功能列點選即切換，全程不用回對話。change-set 治理（draft-only、scope-gate、分級批准、稽核、排程）與既有 7 個 action_type module 的業務邏輯**全部重用、不動 core**。

**非目標**：不重寫 change-set 引擎、不改認證/OAuth、不做名稱搜尋（v2）、不碰 products-panel/changeset-panel。

## 2. 範圍（v1）

**收（全部 7 個 action_type）**：
- 商品上下架：`shelf_toggle_product`、`shelf_toggle_plan`、`shelf_toggle_bundle`、`shelf_schedule`
- 商品庫存：`inventory_setting`、`inventory_platform`
- 商品公告：`announcement`

**不收（列 v2）**：以商品名稱/關鍵字搜尋載入（現況 `be2_find_products` 只吃 oid）。

## 3. 已拍板設計決策

1. **版型 B**：左側常駐功能列（3 功能）+ 右側工作區；切功能只換編輯器。（prototype 比較後否決頂部精靈 A、購物籃 C。）
2. **工作台取代舊 wizard 入口**：移除 `be2_open_batch_wizard` / `be2_open_announcement_wizard`，三功能只走工作台（真彙整）。保留 products-panel（唯讀查詢）與 changeset-panel（通用 diff 審批）。
3. **商品載入 v1 只用 oid**（含貼多筆），名稱搜尋列 v2。
4. **左 3 功能 + 次模式**：功能點進去若有多操作，工作區頂部出次模式切換（見 §5）。
5. **多商品 tab**：載入多商品後，逐商品分頁編輯（公告除外）。
6. **上下架強制單一方向**：一批只能全上架或全下架，於 module `validate` 層擋混向（不只 UI）。
7. **步驟條批准**：選擇→檢視→批准→結果；檢視整頁攤開。
8. **超量自動拆批**：>20 筆切成多個獨立 change-set（各自稽核、可失敗重試）；**公告例外**（見 §7）。
9. **公告 ingest-only**：翻譯在使用者自己的 Claude 上游用 `kkday-announcement-translate` skill 做完，面板只 ingest 15 語系 JSON、可勾選語系；MCP 不做翻譯。

## 4. 架構

**新增一個面板 + 一個入口 tool，其餘全部重用。** 面板↔工具在 MCP Apps 是靜態 1:1（`uiResourceUri`，見 `src/server/app.ts:63`），故單一工作台＝一個新 HTML resource + 一個入口 tool，功能/次模式切換在面板 JS 內完成。

**重用（不改）**：
- `src/core/changeset/*`：registry、module 介面、store、executor、confirmService、scheduler。
- app-only tools：`app_create_changeset`（staging）、`app_get_changeset_view`（狀態/diff/nonce）、`app_confirm_changeset`（nonce 批准）、`app_get_confirm_link`、`app_get_batch_view`（scope-gate step-1 讀）、`app_get_announcement_view`。
- module conformance harness（新 module ui 註冊即自動繼承）。

**新增**：
- `src/ui/workbench.ts` + `src/ui/workbench.html`：統一面板（左功能列 + 工作區；內部組合各 module 的 `WizardDescriptor`）。
- `src/tools/openWorkbench.ts`：新 model-visible 入口 tool，綁 `ui://be2/workbench.html`。input `{ feature?: 'shelf'|'inventory'|'announce', prod_oids?: number[] }`（僅預填、無 scope 權威，比照 `openBatchWizard.ts`）。
- `src/modules/product/shelfToggle/ui.ts`（+ `shelfToggleBundle/ui.ts`）：上下架目前無 `WizardDescriptor`，補上才能進工作台殼。

**修改**：
- `src/server/app.ts`：`TOOLS` 換入 `openWorkbenchTool`、移除兩個舊 `open_*`。
- `src/server/appResources.ts`：`PANELS` 加 workbench。
- `scripts/build-ui.mjs`：`entries` 加 `'workbench'`。
- `src/tools/batchView.ts`：`BatchViewActionType` 擴充納入 `shelf_toggle_*` 的 step-1 讀取（使上下架也能經 `app_get_batch_view` 登記 read scope）。

**保留不動**：products-panel、changeset-panel 及其入口 tool（`be2_find_products` / `be2_get_product_plans` / `be2_get_inventory_settings` / `be2_create_changeset` / `be2_get_changeset_status`）。

## 5. 功能結構（左功能列 + 次模式）

| 左功能列 | 次模式 | action_type |
|---|---|---|
| **商品上下架** | 立即上/下架 · 套裝上/下架 · 排程上/下架 | `shelf_toggle_product`+`shelf_toggle_plan` / `shelf_toggle_bundle` / `shelf_schedule` |
| **商品庫存** | 逐日數量 · 平台切換 | `inventory_setting` / `inventory_platform` |
| **商品公告** | （單一，無次模式） | `announcement` |

- 每個次模式 = 重用該 module 的 `WizardDescriptor`（`inventory_setting`/`inventory_platform`/`shelf_schedule`/`announcement` 已有；`shelf_toggle_*` 要新寫 `ui.ts`）。
- 共用外框（所有功能一致）：**商品批次載入器（oid / 貼多筆）→ 多商品 tab → 步驟條（選擇→檢視→批准→結果）→ 拆批檢視**。
- 「立即上/下架」次模式：商品整體 checkbox + 各方案 checkbox，**強制單一方向**（見 §8）。

## 6. 面板↔工具接線

- **入口**：`be2_open_workbench`（model-visible），綁 `ui://be2/workbench.html`。移除舊兩個 `open_*`。
- **面板內（app-only，host 從 model 工具清單濾除）**：
  - `app_get_batch_view`（擴充後含 `shelf_toggle_*`）＝各次模式 step-1 讀現況 + **server 端登記 read_oids scope**。
  - `app_get_announcement_view`＝公告讀現況（商品名 + 既有公告數；S2S 403 / 缺 key 時 degrade）。
  - `app_create_changeset`＝step-2 staging（重用 `createChangesetCore`，回 `{changeset_id}`）。
  - `app_get_changeset_view`＝狀態/diff + 發一次性 nonce（僅 app-only 附帶）。
  - `app_confirm_changeset`＝批准/拒絕/取消（先消耗 nonce，委派 `approveAndExecute`）；`app_get_confirm_link`＝確認頁 URL 退路。
- **不變式（維持）**：read scope 由 `app_get_*_view` server 端登記；批准所需 nonce 只在 app-only 回傳發放 → **agent 結構上拿不到、無法自我批准**（面板 nonce 通道或 be2-auth SSO 確認頁退路）。

## 7. 各功能資料流

**共同**：載入商品（`app_get_batch_view`/`app_get_announcement_view` 登記 scope）→ 面板編輯 → `app_create_changeset`（draft-only staging）→ `app_get_changeset_view`（diff + nonce）→ 檢視步驟（**拆批 ≤20/批，各自獨立 change-set**、依商品分組可折疊）→ `app_confirm_changeset`（人工批准 nonce）→ `approveAndExecute` → `module.execute` → be2 gateway。排程：`inventory_setting` 走 core scheduler（`schedulable:true`）、`shelf_schedule` 走原生 reserve-queue。

**公告特例**：
- 內容＝使用者上游 Claude 用 skill 產的 15 語系 JSON（`{type:'be2-announcement-content', langs:[{lang_code,content}]}`），於面板 ingest（貼上整段回覆解析，或 Claude 開面板時預填）。
- 面板長出 15 語系清單，每列 checkbox 可勾選/取消（預設全選）→ 只送勾選語系。
- 送出 = 真實 create API `POST {GATEWAY}/svc-b2c/api/v1/admin/product/announcement`（Bearer + `x-api-key`），body `{name, isEnabled, prodOids:[...], startTime, endTime, langSettings:[{langCode, content}]}`。
- **`prodOids` 陣列一次 POST → 公告是單一 change-set、不逐商品拆批**（與上下架/庫存不同）。
- ingest 做 `lang_code→langCode` 欄位改名；skill 只產 15 語系，API langSettings 語系本身開放。

## 8. 新驗證 / 錯誤處理

- **上下架強制單一方向**（新規則）：`shelfToggle` module `validate` 拒絕「同一批同時含上架與下架」。回錯用 module 既有 `invalidItemsMessage` 機制。
- **拆批（先按 action_type 分組、再按 20 切）**：change-set 是 per-action_type（`createChangesetCore` 一次一種 action_type），故工作台建 change-set 時**先依 action_type 分組**（例如「立即上/下架」同時改商品層 + 方案層 → `shelf_toggle_product` 與 `shelf_toggle_plan` 各自成 change-set），每組再把 >20 筆切成多個獨立 change-set；每個各自 diff/nonce/批准/稽核/可失敗重試。公告不拆（prodOids 陣列一次送）。檢視步驟需清楚呈現「本次 = N 個 change-set」。
- **重用既有保護**：draft-only（agent 不直接寫）、scope-gate fail-fast（businessList action code 缺 → 擋）、stale `diff_version` 409、CAS 防重複執行、per-item audit、partial 不 collapse 成 failed。
- **錯誤面**：未登記 read scope → 擋；invalid items → module 訊息；無 nonce 批准 → 結構上不可能。

## 9. 測試策略

- **TDD**：
  - 工作台面板邏輯（功能/次模式切換、載入器 oid 解析、多商品 tab、拆批分組、公告 ingest/勾選）。
  - `shelfToggle/ui.ts`（+ bundle）`WizardDescriptor` 與**單一方向 validate** 單元測試。
  - `openWorkbench` tool、`batchView.ts` 的 `shelf_toggle_*` 分支。
  - module conformance harness 自動覆蓋新 ui 部件（union⇔registry、schema 互斥、itemKey、diffVersion 穩定/敏感）。
- **eval**：draft-only 拒絕、scope-gate、注入抵抗、單一方向拒絕、拆批正確性。
- **CI 綠**：`npm run ci`（build-ui + typecheck + test）；`npm run eval` 無 key 為文件化 SKIP。

## 10. 待驗 probe / 未竟項（非阻擋，帶進 plan）

- 公告 `startTime`/`endTime` 的時區語意（payload 無 tz 欄位）。
- 公告 `prodOids` 陣列單次上限。
- `shelf_toggle_bundle` live 寫入契約（bundle 端點/欄位）。
- live 寫入授權：per-env / per-oid 403 既知卡點（需目標環境可寫商品；同 3a/2a）。
- 名稱搜尋（v2）：候選 `/v2/product/search-draft`。

## 11. 檔案變更清單

**新增**：`src/ui/workbench.ts`、`src/ui/workbench.html`、`src/tools/openWorkbench.ts`、`src/modules/product/shelfToggle/ui.ts`、`src/modules/product/shelfToggleBundle/ui.ts`。
**修改**：`src/server/app.ts`（TOOLS 增刪）、`src/server/appResources.ts`（PANELS）、`scripts/build-ui.mjs`（entries）、`src/tools/batchView.ts`（`BatchViewActionType`）。
**保留不動**：core changeset 全部、products-panel、changeset-panel、其他既有 module 的 diff/validate/execute。

## 12. 不做（YAGNI）

- 名稱/關鍵字搜尋載入（v2）。
- 「一次送多則不同公告」的購物籃佇列（v2；v1 一則→多商品）。
- 面板觸發模型跑翻譯（翻譯全在使用者上游，面板 ingest-only，故不需此能力）。
- 動態多面板切換（受 MCP Apps 一 tool 一面板限制；單面板內 JS 切換即可）。
