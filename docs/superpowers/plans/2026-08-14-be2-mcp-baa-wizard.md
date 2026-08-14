# Phase 4a — BAA 批次精靈（inventory_platform + shelf_schedule + wizard 面板）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 BAA 的「庫存管理平台切換」與「排程上下架」搬進 be2-mcp：兩個新 change-set action_type ＋ 一個 MCP Apps 四步驟 wizard 面板，批准走既有 nonce 通道。

**Architecture:** 全部掛在既有機制上——`src/changeset/`（types→zod 驗證→diff dispatcher→executor→confirmService）、`src/tools/appTools.ts`＋`src/server/appPipeline.ts`（app-only tools）、`src/ui/`＋`scripts/build-ui.mjs`（面板）。spec = `docs/superpowers/specs/2026-08-14-be2-mcp-baa-wizard-design.md`（agy approved，**實作前先讀它**，特別是 §4 的 item×supplier 粒度與 §5.1 的 read-oids 全層級登記）。

**Tech Stack:** TypeScript、zod、better-sqlite3、vitest、esbuild（面板打包）、MCP Apps（`app.callServerTool`）。

## Global Constraints

- 一律 TDD：先寫失敗測試再實作；每 task 結尾 `npm run ci` 全綠才 commit。
- 憑證只從 `.env` 讀；任何 log/測試/commit 不得出現 key/password/token 明文。
- 身分由 token 推導；`modify_user` = identity JWT 的 `platformId`（既有 `modifyUserFromPlaceholder` 解析，勿自造）。
- 面板 inline `<script>` 內插值一律走既有 `js()` 逃逸（`</script>` breakout 防護）；打包用 function-replacement（`$` pattern 坑已知）。
- 時間存放一律 UTC 字串 `YYYY-MM-DD HH:mm:ss`；時區轉換只在面板端。
- probe 類 script 永不進 CI。
- spec §6 安全不變式逐條沿用，不新增例外。

---

### Task 1: item 層級讀取端點 probe（定案 inventory_platform 的 diff 資料來源）

**Files:**
- Create: `scripts/probe-supplier-config-read.ts`（永不進 CI）
- Modify: `docs/be2-mcp/sit-write-contracts.md`（追加 §inventory-platform read 結論）

**Interfaces:**
- Produces: 定案「以 `(item_oid, supplier_oid)` 為鍵讀兩布林（`is_external_inventory`,`is_inventory_mgmt`）」的具體端點與回應欄位名，Task 3 的 `readSupplierInventorySetting()` 依此實作。

- [ ] **Step 1: 寫 probe script**（模式照抄 `scripts/probe-sit.ts`：`.env` 帳密 login→exchange→帶 bearer 打 gateway，輸出不落 token）。對已知 item（34133 的任一非 bundle 方案 item，先 `GET /product/api/v1/products/34133/packages?locale=zh-tw&show_supplier=1` 解出 item_oid/supplier_oid）依序試：
  1. `GET /product/api/v1/items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting`
  2. `GET /product/api/v1/items/{itemOid}/supplier-configs/{supplierOid}`
  3. `GET /product/api/v1/items/{itemOid}/supplier-mappings`（已證 200，看元素是否含兩布林）
  同時記錄 `packages?show_supplier=1` 回應裡方案物件的 supplier 欄位形狀（`app_get_batch_view` 要用）。
- [ ] **Step 2: 跑 probe**：`npx tsx --env-file=.env scripts/probe-supplier-config-read.ts`。預期至少一條 200 且含兩布林；全讀不到＝spec §4.1 的 DiffError 路徑會常駐觸發，**停下回報使用者**（阻擋項）。
- [ ] **Step 3: 把結論寫進 `docs/be2-mcp/sit-write-contracts.md`**：端點、回應 JSON 形狀（sanitized）、欄位名。
- [ ] **Step 4: Commit**：`git add scripts/probe-supplier-config-read.ts docs/be2-mcp/sit-write-contracts.md && git commit -m "probe(4a): item 層級 supplier inventory-setting 讀取端點定案"`

### Task 2: types + zod 驗證 + ACTION_CODES（兩個新 action_type）

**Files:**
- Modify: `src/changeset/types.ts`（ActionType union、兩個 item/diff 介面）
- Modify: `src/changeset/tools.ts`（zod enum、items 驗證分支、ACTION_CODES）
- Create: `src/changeset/batchValidate.ts`（新 action_type 的語義驗證）
- Test: `tests/batchValidate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts 追加
  export type ActionType = 'shelf_toggle_product' | 'shelf_toggle_plan' | 'inventory_setting' | 'inventory_platform' | 'shelf_schedule'
  export type InventoryPlatform = 'BE2' | 'BE2_SCM' | 'EXTERNAL'
  export interface InventoryPlatformItem { item_oid: string; supplier_oid: string; target: InventoryPlatform; affected_pkgs: Array<{ prod_oid: string; pkg_oid: string; pkg_name: string }> }
  export interface ScheduleEntry { reserve_date_utc: string; reserve_status: boolean }   // "YYYY-MM-DD HH:mm:ss"
  export interface ShelfScheduleItem { prod_oid: string; pkg_oid: string; queue: ScheduleEntry[] }
  // batchValidate.ts
  export function validateInventoryPlatformItems(items: InventoryPlatformItem[]): string | null  // 錯誤訊息或 null
  export function validateShelfScheduleItems(items: ShelfScheduleItem[], now: () => number): string | null
  export function platformToBooleans(t: InventoryPlatform): { is_external_inventory: boolean; is_inventory_mgmt: boolean }
  export function booleansToPlatform(b: { is_external_inventory: boolean; is_inventory_mgmt: boolean }): InventoryPlatform | undefined  // EXTERNAL+mgmt=true（11）等未定義組合回 undefined
  export function sanitizeQueue(q: Array<{ reserve_date?: unknown; reserve_status?: unknown }>): ScheduleEntry[]  // 只留兩欄、依 reserve_date 升冪排序
  ```
- Consumes: 既有 `AnyChangeSetItem`（types.ts:20）併入兩個新介面。

- [ ] **Step 1: 寫失敗測試**（`tests/batchValidate.test.ts`）：
  - `platformToBooleans('BE2_SCM')` → `{is_external_inventory:false,is_inventory_mgmt:true}`；三態雙向對映互逆；`booleansToPlatform({true,true})` → `undefined`。
  - `validateInventoryPlatformItems`：同 `(item_oid,supplier_oid)` 重複 → 錯誤訊息含兩個衝突 pkg_name；空 affected_pkgs → 錯。
  - `validateShelfScheduleItems`：過去時間 → 錯；同 pkg 重複 → 錯；空 queue 合法（=清除排程）；`reserve_date_utc` 格式錯（非 `YYYY-MM-DD HH:mm:ss`）→ 錯。
  - `sanitizeQueue`：剔除 `created_at/created_by`、依日期排序、順序不同輸入產出相同結果。
- [ ] **Step 2: 跑測試確認失敗**：`npx vitest run tests/batchValidate.test.ts` → FAIL（module 不存在）。
- [ ] **Step 3: 實作** `batchValidate.ts` ＋ types 追加 ＋ `tools.ts`：zod enum 加兩值（tools.ts:41）、items 驗證分支（照 tools.ts:83 附近既有分支樣式，呼叫 batchValidate）、`ACTION_CODES` 加 `inventory_platform: INVENTORY_ACTION_CODES`、`shelf_schedule:` 沿用 shelf_toggle 現值（讀 tools.ts:16-20 現值照抄；若 businessList 比對不過走 spec §4.3 降級：記 audit 警示、不擋）。
- [ ] **Step 4: 跑測試綠 + `npm run ci` 全綠。**
- [ ] **Step 5: Commit** `feat(4a): inventory_platform/shelf_schedule types + 驗證 + action codes`

### Task 3: inventory_platform diff + executor

**Files:**
- Create: `src/changeset/platformDiff.ts`、`src/changeset/executorPlatform.ts`
- Modify: `src/changeset/diff.ts`（dispatcher 加分支）、`src/changeset/confirmService.ts`（executor 分派，照 `executorInventory` 的接法）、`src/changeset/types.ts`（`InventoryPlatformDiffItem` 併入 `AnyDiffItem`）
- Test: `tests/platformDiff.test.ts`、`tests/executorPlatform.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface InventoryPlatformDiffItem { item_oid: string; supplier_oid: string; current: InventoryPlatform; target: InventoryPlatform; noop: boolean; affected_pkgs: Array<{ prod_oid: string; pkg_oid: string; pkg_name: string }> }
  export async function computePlatformDiff(items: InventoryPlatformItem[], ctx: ToolContext): Promise<InventoryPlatformDiffItem[]>
  export async function execInventoryPlatform(rec: ChangeSetRecord, ctx: ExecutorContext): Promise<ItemResult[]>
  export async function readSupplierInventorySetting(gateway, accessToken, itemOid, supplierOid): Promise<{ is_external_inventory: boolean; is_inventory_mgmt: boolean }>  // Task 1 定案端點；讀不到兩布林 throw DiffError
  ```
- Consumes: Task 2 的 types/對映；既有 `DiffError`（diff.ts:30）、`diffVersionHash`（diff.ts:13）、`ItemResult`、gateway client `get/put`。

- [ ] **Step 1: 失敗測試**（mock gateway；照 `tests/inventoryDiff.test.ts` 的 mock 樣式）：
  - diff：現況 BE2、目標 BE2_SCM → 一筆非 noop；現況=目標 → `noop:true`；**讀取用 item 端點、絕不呼叫 packages**（mock 斷言呼叫路徑）；兩布林缺 → 丟 `DiffError`；未定義組合（11）→ `DiffError`。
  - executor：兩 item 一成一敗（mock put 第二個 reject）→ `allSettled` 結果一 ok 一 error；PUT body 精確等於 `{is_external_inventory, is_inventory_mgmt, modify_user}`；noop 項 `skipped_noop` 不發 PUT。
- [ ] **Step 2: 跑測試 FAIL。**
- [ ] **Step 3: 實作**（diff 以 `(item_oid,supplier_oid)` 為鍵；`diff_version` 由 dispatcher 既有 `diffVersionHash` 對 diff 陣列計算——確保 `InventoryPlatformDiffItem` 欄位序穩定；executor PUT `/product/api/v1/items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting`）。dispatcher/confirmService 接線照 `inventory_setting` 的既有分支複製改名。
- [ ] **Step 4: 測試綠 + `npm run ci`。**
- [ ] **Step 5: Commit** `feat(4a): inventory_platform diff + executor（item×supplier 粒度、item 層級讀取）`

### Task 4: shelf_schedule diff + executor + 確認頁 renderer

**Files:**
- Create: `src/changeset/scheduleDiff.ts`、`src/changeset/executorSchedule.ts`
- Modify: `src/changeset/diff.ts`、`src/changeset/confirmService.ts`、`src/changeset/types.ts`（`ShelfScheduleDiffItem`）、`src/server/confirmRoutes.ts`（新 action_type 的 diff 渲染分支，照 inventory renderer 樣式：列 pkg 現有 queue → 新 queue、紅字「原排程將被整組取代」）
- Test: `tests/scheduleDiff.test.ts`、`tests/executorSchedule.test.ts`、`tests/confirmRoutes` 既有檔加渲染案例

**Interfaces:**
- Produces:
  ```ts
  export interface ShelfScheduleDiffItem { prod_oid: string; pkg_oid: string; pkg_name: string; current_queue: ScheduleEntry[]; new_queue: ScheduleEntry[]; noop: boolean }
  export async function computeScheduleDiff(items: ShelfScheduleItem[], ctx: ToolContext): Promise<ShelfScheduleDiffItem[]>
  export async function execShelfSchedule(rec: ChangeSetRecord, ctx: ExecutorContext): Promise<ItemResult[]>
  ```
- Consumes: Task 2 `sanitizeQueue`；contract：`GET /product/api/v1/products/{prodOid}/package-configs`（陣列，元素含 `pkg_oid,is_bundle,reserve_queue`）、`PUT .../package-configs/reserve-active` body `{config_data:{[pkgOid]:{reserve_date:null,reserve_status:null,reserve_queue:[...]}}, modify_user}`。

- [ ] **Step 1: 失敗測試**：
  - diff：現況 queue 亂序含 created_* 欄位、目標相同內容 → `noop:true`（淨化+排序後深等）；`is_bundle` 方案 → `DiffError`；pkg 不存在 → `DiffError`。
  - `diff_version`：同內容不同順序的現況 → 相同 hash。
  - executor：3 items 跨 2 個 prod → 恰好 2 次 PUT（依 prod 分組、config_data 多 pkg）；一 prod PUT 失敗不影響另一 prod；空 queue 送出 `reserve_queue: []`；結果 per-pkg 記錄。
- [ ] **Step 2: FAIL。**
- [ ] **Step 3: 實作**（讀 package-configs → map by pkg_oid → sanitizeQueue 比對；executor 分組批次）。
- [ ] **Step 4: 綠 + `npm run ci`。**
- [ ] **Step 5: Commit** `feat(4a): shelf_schedule diff + 原生排程 executor + 確認頁 renderer`

### Task 5: `app_get_batch_view`（read-oids 全層級登記）

**Files:**
- Modify: `src/tools/appTools.ts`（新 tool + 併入 `APP_TOOLS`）
- Create: `src/tools/batchView.ts`（資料組裝，供測試直呼）
- Test: `tests/batchView.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const appGetBatchViewTool: AppToolDef  // name: 'app_get_batch_view'
  // input { action_type: 'inventory_platform'|'shelf_schedule', prod_oids: string[] (1..10) }
  // output { products: [{ prod_oid, name, plans: [{ pkg_oid, name, item_oid, supplier_oid, supplier_name, is_active, is_bundle, current_platform?, reserve_queue? }] }] }
  ```
- Consumes: `packages?show_supplier=1`（欄位名以 Task 1 記錄為準）＋ `package-configs`（shelf_schedule 的 reserve_queue/is_bundle）；既有 readOidStore（grep `session_read_oids` / `readOidStore` 找 record API）與 rate budget（照既有 L0 tool 的接法）。

- [ ] **Step 1: 失敗測試**：mock gateway 回 fixtures → 斷言 (a) 輸出形狀；(b) **read-oids 記了 prod+pkg+item 三層**（直查 readOidStore）；(c) >10 prod_oids 拒絕；(d) budget 計數 +1。
- [ ] **Step 2: FAIL。**
- [ ] **Step 3: 實作**（`inventory_platform` 模式讀 packages+布林→`current_platform`；`shelf_schedule` 模式合併 package-configs 的 queue/is_bundle）。
- [ ] **Step 4: 綠 + `npm run ci`。**
- [ ] **Step 5: Commit** `feat(4a): app_get_batch_view（三層 read-oids 登記）`

### Task 6: `app_create_changeset` + model 入口 `be2_open_batch_wizard`

**Files:**
- Modify: `src/tools/appTools.ts`（`app_create_changeset`）、`src/server/app.ts`（註冊入口 tool——找 `createChangesetTool` 的註冊處照樣接）
- Create: `src/tools/openBatchWizard.ts`
- Test: `tests/appCreateChangeset.test.ts`、`tests/openBatchWizard.test.ts`

**Interfaces:**
- Produces:
  - `app_create_changeset`：input `{action_type, items[], note?}` → **重用 `createChangesetTool.handler` 同一條路徑**（抽出共用 service function 若尚未抽），回 `{changeset_id}`。
  - `be2_open_batch_wizard`：input `{action_type, prod_oids?}` → 回傳含 `_meta.uiResourceUri: 'ui://be2/batch-wizard.html'` 的 envelope（照 `src/tools/findProducts.ts:50` 的樣式）＋把 `action_type/prod_oids` 放進 structuredContent 供面板預填。
- Consumes: Task 2 驗證、既有 scope-gate/budget/audit（走同一 service 自然帶到）。

- [ ] **Step 1: 失敗測試**：
  - `app_create_changeset`：合法建立回 changeset_id、record 存在；scope 未讀（readOidStore 空）→ 被拒（證明閘門生效）；items 驗證錯 → 拒。
  - `be2_open_batch_wizard`：回傳 `_meta.uiResourceUri`；`prod_oids` 出現在 structuredContent；非法 action_type 拒。
- [ ] **Step 2: FAIL。** → **Step 3: 實作。** → **Step 4: 綠 + ci。**
- [ ] **Step 5: Commit** `feat(4a): app_create_changeset + be2_open_batch_wizard 入口`

### Task 7: batch-wizard 面板（四步驟）

**Files:**
- Create: `src/ui/batch-wizard.ts`（build 產 `batch-wizard.html`）
- Modify: `src/server/appResources.ts:7-8`（FILES 加 `ui://be2/batch-wizard.html`）、`scripts/build-ui.mjs`（若清單硬編）
- Test: `tests/ui/batchWizard.test.ts`（用 `tests/launcherHarness.ts` 模式：抽 inline script、stub `app.callServerTool`，驗行為序列）

**Interfaces:**
- Consumes: `app_get_batch_view`、`app_create_changeset`、`app_get_changeset_view`（含 nonce+diff_version）、`app_confirm_changeset`；`panelShared.ts` 的 `connectApp/renderText`。
- Produces: 四步驟 UI——
  1. 選擇：prod_oid 輸入（逗號/空白分隔多筆）→ 載入 → 方案表格（checkbox、名稱、供應商、現況欄）；`inventory_platform`：目標平台 radio 三選一＋**勾選時自動勾同 item 兄弟方案並標示「將一併變更」**；`shelf_schedule`：bundle 列 disabled＋預設時間（date/hh/mm/時區 select：Asia/Taipei、Asia/Tokyo、UTC）＋「套用到所有已勾選」＋per-方案時間可加多筆；**時區→UTC 轉換在此步完成**（`Date.UTC` 計算，禁用第三方庫）。
  2. 檢視：組 items → `app_create_changeset` → `app_get_changeset_view` → 渲染 diff（shelf_schedule 顯示「原排程將被整組取代」紅字；雙顯示 GMT+X 與 UTC）＋備註欄。
  3. 批准：按鈕 → `app_confirm_changeset {changeset_id, decision:'approve', nonce, diff_version}`；409 stale → 顯示「現況已變，請回上一步重載」。
  4. 結果：per-item ledger（ok / skipped_noop / error+code）。
- [ ] **Step 1: 失敗測試**（harness stub `app.callServerTool` 回 fixtures）：載入→勾 2 方案→下一步 → 斷言 callServerTool 序列（batch_view → create → view）與 payload（含 UTC 轉換正確：Asia/Taipei 2026-08-20 10:00 → `2026-08-20 02:00:00`）；批准點擊 → confirm payload 帶 view 回傳的 nonce/diff_version；inventory_platform 勾選兄弟方案自動帶入。
- [ ] **Step 2: FAIL。** → **Step 3: 實作面板。** → **Step 4: 綠 + `npm run build-ui`（找 package.json 對應 script）+ `npm run ci`。**
- [ ] **Step 5: Commit** `feat(4a): batch-wizard 四步驟面板`

### Task 8: eval + live 驗收腳本 + runbook

**Files:**
- Modify: eval 案例檔（grep `evalCases` 找既有清單）加 2 案例：`拒絕未經面板批准即宣稱完成（shelf_schedule）`、`拒絕直接寫 reserve-active（引導走 wizard）`。
- Create: `scripts/live-4a-acceptance.ts`（永不進 CI；對 34133 實跑：shelf_schedule 掛遠期→驗證→清除還原；inventory_platform 切換→驗證→切回；印 audit 摘要不含明文）
- Create: `docs/be2-mcp/phase4a-runbook.md`（wizard 使用步驟、demo 腳本、已知限制：bundle 排除／逐日數量 403／同 PUT 內 pkg 共用結果）
- Modify: `docs/be2-mcp/phase0-inventory.md`（Phase 4a 進度段）、`CLAUDE.md`（若新增 npm script）

- [ ] **Step 1: eval 案例先行（紅）→ 實作提示/工具描述調整（綠）。**
- [ ] **Step 2: 寫 live 驗收腳本並實跑一次**（結果貼進 runbook「Live 驗收」節；還原驗證必過）。
- [ ] **Step 3: `npm run ci` 全綠。**
- [ ] **Step 4: Commit** `feat(4a): eval + live 驗收 + runbook`

---

## Self-Review 記錄

- Spec 覆蓋：§2 契約→Task 1/3/4；§4.1→Task 2/3（粒度、DiffError、item 層級讀）；§4.2→Task 2/4（淨化排序、分組批次、bundle 拒）；§4.3→Task 2；§5.1→Task 5（三層 oids）；§5.2→Task 6；§5.3 復用不動；§5.4→Task 7；§5.5→Task 6；§7→各 task Step 1＋Task 8；§8 demo→Task 8 runbook。
- 型別一致性：`InventoryPlatformItem/ShelfScheduleItem/ScheduleEntry/sanitizeQueue` 於 Task 2 定義、3/4/5/6/7 引用同名。
- 無 TBD/placeholder；欄位名依 Task 1 probe 定案處已明示以何為準。
