# Probe:be2 有無「庫存數量」原生排程端點(塊 B 第一步)

> 日期:2026-08-20。結論供塊 B(庫存排程層)spec 引用。方法:本機源碼實證(be2-api routes + parameters、be2-web/be2-product 前端),對照組=上下架域 reserve 機制。

## 結論:**無原生排程。塊 B 必須自建 server 端排程器。**

## 證據

### 1. be2-api(gateway 上游)— 庫存全部端點皆即時,無排程變體
`routes/api.php` 全部 12 條 `inventor*` route(365/670-696/866 行)指向 `ProductItemController`,含寫入端點:
- `PUT item/{itemOid}/supplier/{supplierOid}/inventory-quantity`(679)— 塊 A 用的那條
- `PUT item/{itemOid}/inventory`(682)、`inventory-setting`(684/687)、`inventory/statistics`(689)

Parameters 佐證:`ItemUpdateInventoryQuantityParameter.php` 只有 `inventory_data.{modify_type,remain_qty}`,掃全 8 個 `*Inventory*` Parameter + 全 app grep `inventory × (reserve|schedule|effective_date|apply_at|future)` = **0 筆**。

### 2. 全 repo reserve/schedule/queue 只有上下架域一筆
`routes/api.php:719` `PUT {prodOid}/package-configs/reserve-active` → `PackageConfigController@reserveUpdateActive`,參數 `config_data.*.{reserve_date,reserve_status}`(`PackageUpdateReserveActiveParameter.php:16-17`)。**屬上下架域,shelf_schedule module 已在用。**

### 3. be2-web 庫存 UI 無排程入口(對照組證明方法有效)
- 庫存設定頁 `resources/js/components/contents/product/inventory/editDetail/` 整子樹 grep `reserve|schedule|排程|預約|預定|定時|生效日` = **0 命中**;API 檔 `ApiProductInventory.js` 直打即時 PUT。
- 對照組:上下架 `saleStatus/editDetail/` 有完整 reserve UI(`SaleStatusReserveConfirmModal.vue`、`reserve_date/reserve_status/reserve_updated_by` 欄位、`ReserveDateStatusType.js`)→ 同一搜法上下架域一搜就有,庫存域是真空。
- 前端註解直證排程引擎歸屬:`kkday-be2-product/resources/js/apis/product/quotation.js:114`「到點自動執行靠後端 `package_active:update` 排程」——**該引擎只服務 package active,與庫存無關**。

### 4. product-service(下游)未在本機,但不影響結論
be2-api `ProductApiService` 所有庫存 relative path 只到 `inventory-setting` 等即時端點,**沒有任何 inventory×reserve 下游路徑被 proxy**。即使下游存在隱藏排程端點,走 gateway 也到不了;且 MCP 鐵則禁繞過 gateway(memory `feedback-be2-mcp-no-gateway-bypass`)。

## 對塊 B 的直接後果(接 handoff「若無」分支)
1. be2-mcp server 端排程器:常駐、到點撿起 `scheduled` change-set 執行。
2. 時區一級需求:存 UTC、換算 be2 日期邊界(GMT+9 語境)不可錯。
3. 延遲執行授權模型:批准當下消耗 nonce/鎖定,執行延到 T;靠 Option 1 server-side token store(L2 refresh)使 T 時仍有有效 be2 token(`be2-mcp-auth-design.md`)。
4. 多實例:scheduler 到點撿件需 leader election / 分散式鎖(`deploy-architecture.md` §1.5 Redis);同時 §1.5 的「批次排程發送是 client-side、不需 server scheduler」表述將被本塊推翻,需回改。
