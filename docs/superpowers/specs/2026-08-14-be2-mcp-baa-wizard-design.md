# be2-mcp Phase 4a — BAA 批次精靈搬進 MCP Apps（24h POC）design

日期：2026-08-14（demo deadline：24h 內完成、2026-08-18 向老闆展示）
狀態：待 agy review

## 1. 背景與目標

BAA（BE2 Action Assistant）是既有內部工具，AM 用它做批次操作：四步驟精靈（選擇→檢視→發送→結果）。本 Phase 把其中兩個高價值流程搬進 **MCP Apps 互動面板**，跑在 be2-mcp 的 change-set 治理機制上（draft-only、面板 nonce 批准、全鏈稽核、budget），對老闆展示「自然語言＋面板批次操作＋治理」的完整故事。

兩個流程（皆已 live 實證可寫，2026-08-14，SIT be2-220，帳號 lance.chien）：

1. **庫存管理平台切換**（`inventory_platform`）：把方案的庫存管理平台批次設為 BE2 管理／BE2/SCM 管理／串接外部庫存。
2. **排程上下架**（`shelf_schedule`）：把方案的上下架排程批次送給 be2 **原生排程**（be2 到點自動執行，我方不建 scheduler）。

## 2. 已實證契約（live probe，全數 200，可逆驗證）

### 2.1 庫存管理平台（供應商層設定）

- 寫入：`PUT {gateway}/product/api/v1/items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting`
  body `{ is_external_inventory: bool, is_inventory_mgmt: bool, modify_user: <JWT platformId> }`
- 平台 enum ↔ 布林對映（be2-web `enums/product/InventoryDataSource.js`，十位=isExternal、個位=isMgmt）：
  - `BE2` = `{is_external_inventory:false, is_inventory_mgmt:false}`（00）
  - `BE2_SCM` = `{is_external_inventory:false, is_inventory_mgmt:true}`（01）
  - `EXTERNAL` = `{is_external_inventory:true, is_inventory_mgmt:false}`（10）
- 現況讀取：`GET /product/api/v1/products/{prodOid}/packages?locale=zh-tw&show_supplier=1`（面板載入方案清單＋supplier＋現況平台；實作時以真實回應欄位為準，若該回應缺兩布林，補讀 item 的 supplier-configs）。

### 2.2 排程上下架（be2 原生排程）

- 寫入：`PUT {gateway}/product/api/v1/products/{prodOid}/package-configs/reserve-active`
  body `{ config_data: { [pkgOid]: { reserve_date: null, reserve_status: null, reserve_queue: [ { reserve_date: "Y-m-d H:i:s"(UTC), reserve_status: bool } ] } }, modify_user: <platformId> }`
- 語義（probe＋BAA 警語雙證）：`reserve_queue` **整組取代**該方案原排程（不合併）；空陣列＝清除排程；頂層 `reserve_date/reserve_status` 由 server 從 queue 推導；`created_by/created_at` server 端寫入。**原生支援單 PUT 多方案批次**（config_data 多 key）。
- 現況讀取：`GET /product/api/v1/products/{prodOid}/package-configs` → **陣列**，元素含 `pkg_oid,name,is_active,is_bundle,reserve_date,reserve_status,reserve_queue[]`。
- **bundle 方案（`is_bundle:true`）不支援此端點**（走 `bundle-package-config/{oid}/reserve-active`，v1 排除、建立時擋下）。

## 3. 範圍

**做**：
- 2 個新 change-set `action_type`：`inventory_platform`、`shelf_schedule`（復用既有 change-set 機制：§6.2 scope 讀取閘門、businessList fail-fast、每日 budget、diff_version stale 檢查、CAS 防重複執行、per-item 結果、append-only 稽核）。
- 1 個 **wizard 面板**（MCP Apps）：四步驟（選擇→檢視→批准→結果），同一面板支援兩種 action_type（進入時指定）。
- 2 顆 **app-only tools**：`app_get_batch_view`（載入商品→方案清單＋現況；server 端記 read-oids）、`app_create_changeset`（從面板選擇建 change-set）。
- 1 顆 model-visible 入口 tool：`be2_open_batch_wizard`（回傳面板 resource；沿用既有面板開啟機制）。

**不做（明示排除）**：bundle 方案排程、逐日數量批改（verify 403 未解）、Excel/試算表貼上、自建 scheduler（原生排程取代）、方案改名/排序、立即上下架（`switch` 403）。

## 4. 資料模型與語義

### 4.1 `inventory_platform` change-set item

```
{ prod_oid, pkg_oid, item_oid, supplier_oid, target: 'BE2'|'BE2_SCM'|'EXTERNAL' }
```
- diff：讀現況布林 → 映射 enum → `current ≠ target` 才列變更；相同者 `skipped_noop`。
- `diff_version`：hash 綁（item_oid, supplier_oid, 現況兩布林）集合——批准時 live 重算，變了回 409 stale（沿用 Phase 2a 機制）。
- executor：逐 item×supplier PUT（無原生批次）；`Promise.allSettled` per-item 結果；`modify_user` 沿用既有 platformId 解析。

### 4.2 `shelf_schedule` change-set item

```
{ prod_oid, pkg_oid, queue: [ { reserve_date_utc: "Y-m-d H:i:s", reserve_status: bool } ] }
```
- 驗證：`queue` 可為空（=清除排程）；`reserve_date_utc` 必須是未來時間（建立當下）；同 pkg 在一個 change-set 只能出現一次；`is_bundle` 方案建立時拒絕。
- diff：現況 `reserve_queue` → 新 queue，**明示「原排程將被整組取代」**；現況與目標深相等者 `skipped_noop`。
- `diff_version`：hash 綁（pkg_oid, 現況 reserve_queue 淨化後內容）。
- executor：**依 prod_oid 分組，單 PUT 帶多 pkg**（原生批次）；一個 prod 失敗不影響其他 prod（allSettled）；結果 per-pkg 記錄（同 PUT 內的 pkg 共用結果狀態，稽核註明）。

### 4.3 businessList fail-fast action codes

- `inventory_platform` → `product.product-inventory.update`（帳號 businessList 已實查存在）。
- `shelf_schedule` → 沿用 Phase 2a `shelf_toggle` 實查的 package-config 類 code；實作時以真實 businessList 比對確認。
- 兩者的 live 授權皆已實證（200）；若實作時發現 verify 規則綁的 code 與清單對不上（Phase 3a 曾遇 UI/verify 不同顆），fail-fast 對該 action_type 降級為「記 audit 警示、不擋建立」，authoritative 判斷仍交給 gateway `/verify`（fail-closed 不變）。
- 時區：**server/store 一律 UTC**；面板負責「使用者選時區＋本地時間 → UTC」轉換與雙顯示（GMT+X 與 UTC 並列，仿 BAA 檢視頁）。

## 5. App tools 與面板

### 5.1 `app_get_batch_view`（app-only）

input `{ action_type, prod_oids: string[] (≤10) }` → 每商品：`{prod_oid, name, plans: [{pkg_oid, name, item_oid, supplier_oid, supplier_name, is_active, is_bundle, current_platform?, reserve_queue?}]}`。
- server 端同時把讀到的 oids 寫入 session read-oids（§6.2 scope-gate 的合法滿足：**讀取確實發生在 server 端本 session**，非面板自報）。
- 沿用 rate budget 計數。

### 5.2 `app_create_changeset`（app-only）

input `{ action_type, items[], note? }` → 走與 `be2_create_changeset` **同一條 service 路徑**（同驗證、同 budget、同稽核；只是入口不同），回 `{changeset_id}`。
- 面板建立 ≠ 批准：建立後仍必須經 nonce 批准，兩顆權能不互通。

### 5.3 批准與結果（復用）

- 檢視/批准：既有 `app_get_changeset_view`（附一次性 nonce）＋ `app_confirm_changeset`（approve/reject + nonce + diff_version）。BAA 的「輸入 PSI/OID 啟用按鈕」由 nonce 通道取代（更強：model 結構上拿不到）。
- 結果：批准回傳 per-item 結果直接渲染 ledger（沿用 changeset-panel 的結果呈現模式）。

### 5.4 Wizard 面板（`ui://be2/batch-wizard.html`）

- 步驟 1 選擇：輸入 prod_oid（支援多筆）→ `app_get_batch_view` → 方案表格（勾選、篩選、隱藏未勾選、bundle 標示不可選〔shelf_schedule 時〕）；`inventory_platform` 顯示目標平台三選一；`shelf_schedule` 顯示預設時間（日期+時+分+時區）與「套用到所有已勾選」、per-方案可加多時間點。
- 步驟 2 檢視：呼叫 `app_create_changeset` → `app_get_changeset_view` → 渲染 diff（含取代警語、UTC 對照、備註欄）。
- 步驟 3 批准：面板內按「批准 N 項變更」→ `app_confirm_changeset`。
- 步驟 4 結果：per-item ledger（成功/`skipped_noop`/失敗＋錯誤碼）。
- 打包沿用 `scripts/build-ui.mjs` 與 panelShared（`</script>` 逃逸、function-replacement 等既有坑已解）。

### 5.5 model 入口 `be2_open_batch_wizard`

input `{ action_type, prod_oids?: string[] }`（prod_oids 僅作面板預填，**不代表已通過 scope 閘門**——閘門在 `app_get_batch_view` 的 server 端讀取才成立）。回傳面板 resource（沿用既有 apps 開啟機制）。非 Apps host（如 Claude Code）呼叫時回覆文字說明改用確認頁流程（capability gate 沿用 spike T5/T6 結論）。

## 6. 安全不變式（全數沿用、不新增例外）

1. agent 結構上拿不到批准憑證：`app_confirm_changeset` app-only、nonce 只在 `app_get_changeset_view` 回傳（host 濾除 app-only tools，spike T6）。
2. `app_create_changeset` 只能「建 draft」，不能執行；budget/稽核與 model 路徑同一套。
3. scope 閘門以 server 端實際讀取為準（`app_get_batch_view` 內完成），面板輸入不可自證。
4. 身分一律由 MCP session 的 identity 推導；`modify_user`＝該 identity JWT 的 platformId。
5. 稽核：view/create/approve/execute 每步 append-only audit_log，不落任何憑證明文。

## 7. 測試與驗收

- TDD：兩個 action_type 的 schema 驗證、diff、diff_version、executor（含 reserve 整組取代、空 queue 清除、bundle 拒絕、noop skip、分組批次、部分失敗）；app tools 的 scope-gate 與 budget；面板 inline script 用 `tests/launcherHarness.ts` 模式做行為測試（載入→勾選→建立→批准的 callServerTool 序列）。
- Live 驗收（demo 前一晚）：對 34133 實跑兩種 change-set 各一次（`shelf_schedule` 掛遠期排程後清除還原；`inventory_platform` 切換後切回），确認真 200＋稽核完整。
- eval：新增「拒絕未經面板批准即宣稱完成」「拒絕直接寫入」兩案例沿用既有模板。

## 8. Demo 腳本（2026-08-18）

1. Claude Desktop OAuth 登入（瀏覽器 be2-auth，帳密不經 Claude）。
2. 自然語言：「幫我把 34133 的 Paul Frank 系列方案排 8/20 早上 10 點上架」→ agent 開 wizard 面板（預填）。
3. 面板勾方案、確認時間 → 檢視 diff（取代警語）→ 面板批准 → 結果「排程已受理」（be2 原生到點執行）。
4. 第二段：「這幾個方案的庫存改成 BE2/SCM 管理」→ 同面板另一模式跑完，執行真 200。
5. 收尾講治理：draft-only、nonce 批准 agent 拿不到、全鏈稽核 query 展示、逐日數量/其他域 roadmap。

## 9. 風險與備援

- `packages?show_supplier=1` 若缺兩顆庫存布林 → 補讀 supplier-configs（工時 +1h，Task 內處理）。
- 面板工時爆 → 降級順序：先砍「per-方案多時間點」（只留單一時間套用全部）、再砍多商品載入（單商品）。
- demo 當天 SIT 資料被他人改動 → demo 前一晚重置 34133 目標方案狀態並記錄基準。
