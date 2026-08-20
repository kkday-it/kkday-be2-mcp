# be2 MCP — 庫存數量（inventory_setting）進 wizard 設計（即時 SET/fullday 版）

> 日期：2026-08-20　分支基準：`feat/bundle-followup`
> 來源：`docs/be2-mcp/baa-wizard-expansion-handoff.md`（塊 A）+ `docs/be2-mcp/sit-write-contracts.md`（§inventory：讀取形狀矩陣、寫入 body、不鎖死 parser 原則）+ `docs/be2-mcp/module-onboarding.md`（上車 checklist）。
> 對應主 spec：`2026-08-07-be2-mcp-design.md`（治理層）、`2026-08-14-be2-mcp-baa-wizard-design.md`（wizard 底座）、`2026-08-10-be2-mcp-phase3a-inventory-design.md`（本 spec 改寫的 Phase 3a module 前身）。
> 這是 handoff 兩塊中的 **塊 A**（即時版）。塊 B（到點派送排程）另開 session、另寫 spec，本 spec 不含排程。

## 1. 目標與範圍

把「庫存數量」接成 `be2_open_batch_wizard` 已有的批次面板的一個新 `action_type = inventory_setting`，讓員工「選商品 → 看現況數量 → 填目標數量 → 批准」批次覆寫庫存，全程沿用既有治理（身份貫穿、draft-only、confirm 確認頁 / 面板 nonce、稽核、budget）。功能目標＝**對齊獨立版 BAA 的庫存數量能力**（memory `be2-mcp-phase3-plan`：原版只支援 `item_by_amount`/fullday，`{itemOid:{fullday:N}}`；SKU / 依日期&場次未支援）。

**In scope（本 spec）**
- **就地改寫**既有 Phase 3a `inventory_setting` module（`src/modules/product/inventorySetting/`）為 **fullday-SET** 形狀。
- **只支援 `item_by_amount`（`control_type=1, inventory_type=0`）模式**；其餘 4 模式（無限量 / SKU 總量 / item 依日期 / SKU 依日期）一律 fail-closed 擋下 + 面板標示「目前不支援」。
- **`inventoryShape.ts` FINALIZE**：讀取端點 `GET .../inventories/{sup}` → `POST .../inventories/search`；解析主形狀改 `data[itemOid].fullday`（保留 defensive 容錯，不鎖死）；補 fixture。
- 折進既有 `be2_open_batch_wizard` grid 面板：新增庫存數量分頁（`appTools` enum / `batchView` / `batch-wizard.ts` / `openBatchWizard` enum）。
- `be2_create_changeset` + confirm 確認頁 + 面板 nonce 批准對 `inventory_setting` 一致可用（registry 自動涵蓋）。

**Out of scope（明確不做，列 §11 未來）**
- **相對調整（adjust，`modify_type=0`）**：即時版只做 SET（`modify_type=1`，覆寫絕對值）。
- **SKU 維度**（`sku_by_amount` `2/0`）、**依日期 / 場次**（`item_by_date` `1/1`、`sku_by_date` `2/1`）。
- **伺服器端排程器（塊 B）**：即時寫入，不做到點派送。
- 庫存模式切換（那是既有的 `inventory_platform`，不同 action_type）。

## 2. 北極星原則（已與使用者定案）

1. **wizard 只是 UX 友善層**；能力靠底層 module + change-set + executor。先確保底層成立。
2. **即時版先做**（本 spec）；排程（塊 B）疊在本版打通的 fullday 即時寫入之上，另 session。
3. **嚴禁盲寫**：現況讀取失敗（含模式不符）一律 fail-closed，不假設預設值、不寫入。
4. 對齊獨立版 BAA 能力邊界：只做 `item_by_amount`/fullday/SET。

## 3. 契約錨點（自 `sit-write-contracts.md` §inventory，SIT be2-220 實攔 / 源碼雙證）

| 項 | 值 |
|---|---|
| host（SIT） | `https://api-gateway-220.sit.kkday.com`，product-service 前綴 `/product/api/v1` |
| 模式讀取 | `GET /product/api/v1/items/{itemOid}/basic-info` → `data.item_config.inventory_setting.{control_type, inventory_type}`（user token 200，與 `inventory_platform` 同端點）|
| 數量讀取 | **`POST /product/api/v1/items/{itemOid}/inventories/search`** body `{supplier_oid, page:1}`（amount 模式不帶 rrules）→ user token **200** |
| 數量讀取回應 | `{data:{[itemOid]:{fullday: number\|null}}, meta:{status:"100000"}}`（`item_by_amount` 單一 fullday；`null`=未設，非 0）|
| 數量寫入 | **`PUT /product/api/v1/items/{itemOid}/inventories/{supplierOid}/quantity`** body `{inventory_data:{remain_qty:{[itemOid]:{fullday:N}}, modify_type:1}, modify_user}`（同步）|
| `modify_type` | **1 = REPLACE（set）**、0 = ADD_AND_SUBTRACT（adjust，本版不用）|
| `remain_qty` 形狀 | 與讀取回應**對稱**：`{[itemOid]:{fullday:N}}`（`item_by_amount`）|
| `modify_user` | JWT `platformId` claim（shelf-toggle / inventory-platform 已雙證通則）|
| supplier 解析 | `GET .../packages?show_supplier=1` → `supplier_mapping[].{supplier_oid, is_default}`，取 `is_default:true`（沿用 `batchView.ts` 既有邏輯）|
| businessList | `product.product-inventory.update`（帳號實查存在）|
| 忙碌旗標 | `GET .../inventories/status` → `{is_processing}`（模式/數量寫入前輪詢，避免讀到 stale base）|

**5 種庫存模式矩陣**（`control_type` 十位 / `inventory_type` 個位）：
| 模式 | control/inv | L1 key | 巢狀 | 本版 |
|---|---|---|---|---|
| 無限量 none | --/null | — | — | ⛔ 擋 |
| **套餐總量 item_by_amount** | **1/0** | **itemOid** | **`{itemOid:{fullday:N}}`** | **✅ 做** |
| SKU 總量 sku_by_amount | 2/0 | sku_oid | `{sku_oid:{fullday:N}}` | ⛔ 擋（§11）|
| 套餐依日期 item_by_date | 1/1 | itemOid | `{itemOid:{date:{fullday\|"HH:MM":N}}}` | ⛔ 擋（§11）|
| SKU 依日期 sku_by_date | 2/1 | sku_oid | `{sku_oid:{date:{fullday\|"HH:MM":N}}}` | ⛔ 擋（§11）|

**高風險語義（供 renderer 警語 + diff）**：數量修改**立即生效**（正式資料直接異動）；**歸零 → `InventoryEmpty` 事件清 sale-time cache + PubSub 通知搜尋 → 立即影響前台可售**。庫存 by supplier（每供應商各一份）。

**未解 gate（非阻擋開發，RD 處理中）**
- **quantity PUT 卡 `AU9403`**：auth-service verify v2 的 per-URI 規則（`uri_pattern: api/v1/items/{*}/inventories/{*}/quantity`）綁的 business action 帳號群組沒有（`product.product-inventory.update` 帳號有、但不是 verify 要的那顆）。RD 正在處理授權 grant；stage 路線需補 `.env` `STAGE_pwd`/`STAGE_AUTHSVC_SERVICE_KEY`。→ **讀取（basic-info + search）live 200 可用**，故選商品/diff/確認頁 live 全流程可跑；**只有批准後 execute 的 PUT 會 403**，build/單元測試/draft 全綠，live 綠寫入待授權接上。

## 4. 架構決策

### 4.1 (a) 就地改寫既有 module（不新增 action_type、不保留舊骨架）

Phase 3a 的 `inventory_setting` module（per-date `dates[]` + `op:set|adjust`，讀取走 `GET .../inventories/{sup}?year_month=` = S2S-only 端點、對 user token 403）**從未上線、讀取路徑本就是壞的**，無相容包袱。決策：**砍掉 dates[]/adjust/per-month 迴圈，就地重寫**為 fullday-SET。理由：(1) 舊碼不能跑；(2) 未來要接的 by-date/adjust 走真實契約（POST search + rrules + `modify_type`），與舊碼的容錯猜測形狀不同，留舊碼無助。`action_type` 字串維持 `inventory_setting`（registry key 不變）。

### 4.2 (b) 模式閘門：只做 item_by_amount，其餘擋掉 + 面板標示

兩層防護：
1. **UI 層（友善）**：`batchView` 回傳每方案的 `inventory_mode`；`batch-wizard.ts` 對非 `item_by_amount` 的方案 **gray-out 勾選框 + 明確註記「目前不支援（僅套餐總量模式）」**。使用者選商品當下即看得到邊界，不必等建 change-set 才知。
2. **diff 層（硬擋）**：`computeInventoryDiff` 讀 `basic-info` 判模式，非 `1/0` 一律 `throw DiffError`（fail-closed，嚴禁盲寫）。UI gray-out 不可信賴為安全邊界——真正的閘門在 diff。

### 4.3 (c) live 寫入 PENDING（RD 處理中，不阻擋 build）

見 §3 未解 gate。本 spec 交付＝ build 綠 + 單元測試綠 + draft/diff/確認頁 live 可跑；批准→真 200 寫入待 RD 授權 grant 或 stage key 補齊即接上。與 Phase 2a/2b/3a 同型卡點。

### 4.4 折進 `be2_open_batch_wizard`（與 Session 1 不同路線）

`inventory_setting` 是「grid-of-plans 逐列填值」，與既有 `inventory_platform`/`shelf_schedule` 同形，天然折進 `be2_open_batch_wizard` 的 grid 面板。**Session 1（公告）改走 sibling-tool `be2_open_announcement_wizard`、完全不碰 `batch-wizard.ts`**（見其 spec §4.2）——故本塊是**唯一**擴 `be2_open_batch_wizard` action_type enum 的 session，原 handoff 擔心的「wizard enum 交會點」實質溶解（§9）。

### 4.5 registry-driven，core 觸點最小化

沿用 Phase 5 模組化：`createChangesetInputShape` 的 action_type enum 與 item union 由 `listModules()` 動態建構。本塊改的是既有 module 內部 + wizard 三支 tool；core 唯一觸點是 `src/core/changeset/types.ts` 的 `InventoryItem`/`InventoryDiffItem` 型別隨 item schema 改寫而更新（onboarding 允許的 union 觸點）。`be2_create_changeset`、確認頁、稽核、budget 自動涵蓋。

## 5. Module 實作（`src/modules/product/inventorySetting/`，就地改寫）

### 5.1 item schema（`module.ts`）
```
{ item_oid: string(min1), supplier_oid: string(min1), quantity: number }
```
- 拿掉 `op`、`dates`。op 恆為 SET（`modify_type=1`）。
- `isItem`：`typeof item_oid === 'string' && typeof quantity === 'number'`。
- `scopeOids: [item_oid]`、`scopeErrorKey: item_oid`（沿用）。
- `authz`: `codes: ['product.product-inventory.update']`, `onMissing: 'block'`（沿用；帳號有此碼，故 fail-fast 會過，真正的 403 在 gateway execute 時發，符合設計）。
- `invalidItemsMessage` / `scopeNotReadMessage`：更新文案為 fullday 版。

### 5.2 `validate.ts`
- `quantity` 為整數（`Number.isInteger`）且 `>= 0`（SET 不接受負值）。
- （item, supplier）在整個 change-set 內唯一（同一 item×supplier 兩筆 SET 語義衝突）。
- 拿掉過去日期 / dates 相關檢查（無 dates）。

### 5.3 `diff.ts`（`computeInventoryDiff`）
1. `GET basic-info` → 判 `control_type/inventory_type`；非 `1/0` → `throw DiffError([item:supplier], '此商品非「套餐總量限制」模式，即時庫存數量版僅支援套餐總量；SKU/依日期模式尚未支援')`。
2. `POST .../inventories/search` body `{supplier_oid, page:1}` → `parseInventoryFullday(raw, itemOid)` 取 current（number | undefined，null→undefined）。
3. 讀取失敗（throw）→ `DiffError`（fail-closed）。
4. 產出 `InventoryDiffItem`：`{item_oid, supplier_oid, current, target: quantity, no_op: current === quantity, would_go_negative: false}`（SET≥0 恆非負；欄位保留供 renderer/型別一致）。
- current 為 `undefined`（未設）＝合法：SET 是完全定義的寫入；確認頁顯示「未設 → N」。

### 5.4 `executor.ts`（`execInventory` 就地簡化）
- **保留** per-`(item_oid:supplier_oid)` in-process mutex（防兩 change-set 併發 lost-update）+ busy guard（輪詢 `/status.is_processing` 5×2s）。
- 拿掉跨月/per-date 迴圈。單值流程：
  1. busy guard；
  2. `POST search` 讀 current（before）；
  3. `no_op`（current===target）→ `skipped_noop`；
  4. `PUT .../inventories/{sup}/quantity` body `{inventory_data:{remain_qty:{[itemOid]:{fullday:target}}, modify_type:1}, modify_user}`；
  5. 寫後 re-read（POST search）填 `after`；**re-read 失敗不把成功寫入報成 failed**（記 `AFTER_READ_FAILED` note，不誘使重試）。
- `ItemResult`：`{item_key:'item:supplier', status, before:{fullday}, after:{fullday}, ...}`。

### 5.5 `renderer.ts`（確認頁）
- 每 item：`現況 fullday {current ?? '未設'} → 目標 {target}`。
- **高風險紅字 banner**：「庫存數量修改立即生效並清除快取、立即影響前台可售；歸零將使該方案前台不可購買。」（沿用 Phase 3a 紅字，改單值文案）。

### 5.6 `keys.ts` / `diffVersion`（`module.ts`）
- `itemKey`：`inv:{item_oid}:{supplier_oid}`（isomorphic，UI 共用）。
- `diffVersion`：canonical `inv:{item}:{sup}=fullday:{current ?? 'null'}→{target}` 排序後 sha256。SET 綁「現況→目標」；現況變動即 stale 重算（沿用 Phase 3a 對 set 綁現況的紀律）。

### 5.7 硬編工具描述同步（防靜默資料破壞——agy review round 1）

item schema 拿掉 `op`/`dates` 後，**zod 預設 strip 未知欄位**：若某工具的 description 仍叫 agent 傳 `dates`/`op`（per-date 語義），agent 送出的 `dates` 會被靜默丟棄，變成「以為改某幾天、實際覆寫整個 fullday」的意圖-執行不符（沉默破壞）。必須同步三處硬編描述：
- **`src/core/changeset/tools.ts`**（`createChangesetTool` description，現 `:118`）：`'inventory_setting stages per-date inventory quantity changes ({item_oid, supplier_oid, op: set|adjust, quantity, dates})'` → 改為 fullday-SET 語義：`{item_oid, supplier_oid, quantity}`，覆寫該方案（item_by_amount）的 fullday 總量；明說僅支援套餐總量模式。
- **`src/tools/inventorySettings.ts`**（`inventorySettingsTool`，現 `:33-34,:39-40`）：拿掉 `year_month` 參數與「per-date quantities for one month」描述（POST search fullday 無 month 維度）；`supplier_oid` 描述改為「provide to read the item_by_amount fullday quantity for that supplier」。
- **`src/tools/openBatchWizard.ts`**（`openBatchWizardTool` description，現 `:25-26`）：補上 `inventory_setting`（設定套餐總量庫存數量）為支援的 action_type，否則新能力對 agent 隱形。

## 6. `inventoryShape.ts` FINALIZE（`src/tools/inventoryShape.ts`）

以 2026-08-19/20 實攔樣本 + 官方手冊 `12-庫存設定.md` 收斂：

- **新增主解析** `parseInventoryFullday(raw, l1Key): number | undefined`：讀 `raw.data[l1Key].fullday`（number 直接回傳；數字字串以 `Number()` 轉換後回傳；`null`/缺/`NaN`→ undefined）。這是 `item_by_amount` 快樂路徑；數字字串容錯屬不鎖死原則（後端型別可能漂移）。
- **不鎖死原則**（使用者 2026-08-20 提醒）：主形狀為快樂路徑、**非唯一路徑**。保留 defensive fallback：`data` 非物件 / L1 key 缺 / 內層無 `fullday` → 回 undefined（優雅降級，不拋錯），供未見過的商品類型（飯店/F&B/GYG 動態價等變體）不致 crash；遇未知結構記錄樣本、後續擴解析。
- **淘汰**與真實形狀全不符的舊容錯常數（`ROWS_KEYS`/`DATE_KEYS`/`QTY_KEYS` 的 array-wrapper 與 `quantity/qty/stock` 猜測）+ 舊 `parseQuantities`/`findRows`/`groupDatesByMonth` 中僅 per-date 版用到者。**保留** by-date 矩陣所需的解析骨架僅在 §11 擴充時再加，本版不預先實作（YAGNI）。
- **補 fixture** `tests/fixtures/inventory-quantities.json`：以 item 1650033 真實 200 樣本 `{data:{"1650033":{fullday:32}},meta:{status:"100000"}}`，加一支 fixture 測試釘住主解析。
- **連帶更新** L0 讀取工具 `src/tools/inventorySettings.ts`（`be2_get_inventory_settings`）：改用新 parser + POST search 讀取現況（原也吃壞掉的 parser/端點）。

## 7. Wizard 接線（seam；與 Session 1 幾乎零衝突，§9）

- **`src/tools/appTools.ts`**：`app_get_batch_view` 的 `action_type` enum `['inventory_platform','shelf_schedule']` → 加 `'inventory_setting'`。
- **`src/tools/batchView.ts`**：
  - `BatchViewActionType` 加 `'inventory_setting'`。
  - `BatchPlan` 加 `current_quantity?: number | null`、`inventory_mode?: string`（後者既有於 inventory_platform 分支，沿用）。
  - `inventory_setting` 分支：每方案有 `item_oid`+`supplier_oid` 時，`GET basic-info` 判模式 + `POST search` 取 fullday（同 item 的 basic-info 用 `configsCache` 共用，避免重讀）；non-item_by_amount 標 mode、`current_quantity` 留 undefined。登記 `read_oids`（item_oid + pkg_oid，供 §6.2 scope-gate）。
  - **錯誤邊界（agy review round 1）**：basic-info / POST search 的讀取必須包在 `try/catch`，比照既有 `resolveCurrentPlatform` 的降級模式 —— 單一方案讀取失敗（403/網路）**回一筆 warning envelope（如 `INVENTORY_READ_UNAVAILABLE`），該方案 `current_quantity`/`inventory_mode` 留空、其餘方案照常顯示**；**不得**讓 unhandled rejection 打掉整個 batch view（view 是唯讀展示、非 diff，降級不阻擋）。
- **`src/ui/batch-wizard.ts`**：加 `inventory_setting` 分頁 —— 每方案一格數字輸入（顯示現況 fullday → 輸入目標）；非 `item_by_amount` 方案 gray-out + 「目前不支援（僅套餐總量模式）」；勾選+填值產出 `inventory_setting` change-set items（`{item_oid, supplier_oid, quantity}`）。itemKey 與 server 同一份 `keys.ts`（單一事實來源，Phase 5 紀律）。
- **`src/tools/openBatchWizard.ts`**（`be2_open_batch_wizard`）：action_type enum 加 `'inventory_setting'`。

## 8. 測試 + eval（照 module-onboarding）

- **conformance**（`tests/core/moduleConformance.test.ts`）：更新 `inventory_setting` 的 diff 樣本為 fullday 形狀（自動繼承 union⇔registry / schema 互斥 / itemKey / diffVersion 穩定性契約）。
- **per-type**：`inventorySettingDiff.test.ts`（模式閘門擋非 1/0、current null、no_op、讀取失敗→DiffError）、`inventorySettingExecutor.test.ts`（SET PUT body 正確、no_op skip、mutex、busy guard、re-read 失敗不報 failed）、`confirmRoutes.test.ts`（渲染現況→目標 + 紅字）。
- **batchView 測試**：inventory_setting 分支解析 current + mode、non-item_by_amount 標示、read_oids 登記。
- **fixture 測試**：`inventoryShape` 主解析 + defensive 降級（未知結構回 undefined 不拋）。
- **eval**：draft-only（拒絕直接寫、須經批准）、scope-gate（未讀 item 拒建）、注入抵抗（工具輸出注入不改變寫入）。
- 既有 Phase 3a 庫存測試中依賴 dates[]/adjust/per-month 的案例：隨 module 改寫調整或刪除（不保留死碼測試）。
- **過時註解清理（agy review round 1）**：`src/core/changeset/confirmService.ts:59-60` 的「Task 12 review Finding 1」註解宣稱 inventory change-set「合法允許兩項目共用 (item_oid, supplier_oid) 但 dates 不相交」。本塊拿掉 dates、(item, supplier) 全域唯一後此宣稱不再成立 —— multiset 比對邏輯本身仍安全，但註解須更新/刪除，避免誤導未來讀者。

## 9. 與 Session 1（公告）的檔案衝突分析

| 檔 | 本塊 A | Session 1 公告 | 衝突 |
|---|---|---|---|
| `src/ui/batch-wizard.ts` | 改（加分頁） | **不碰**（走 sibling 面板） | 無 |
| `src/tools/batchView.ts` | 改 | 不碰 | 無 |
| `src/tools/appTools.ts` enum | 改（加 inventory_setting） | 不碰（公告用 `app_create_changeset` 泛型路徑、非 batch-view enum） | 無 / 極小 |
| `src/tools/openBatchWizard.ts` enum | 改 | 不碰 | 無 |
| `src/core/changeset/types.ts` union | 改（Inventory 型別） | 改（Announcement 型別） | **可能** —— 同檔不同 union 成員，git 行級不重疊機率高；合併時人工對齊即可 |
| `src/modules/index.ts` | 改（重註冊，key 不變） | 改（加 announcement 註冊） | 行級可能相鄰，易解 |

→ 原 handoff 標的「wizard enum 交會點」因 Session 1 走 sibling 路線而**幾乎消失**；剩餘僅 `types.ts` union / `index.ts` 兩處行級小衝突，合併時對齊。

## 10. 阻擋項總表

| 項 | 狀態 | 影響 |
|---|---|---|
| quantity PUT `AU9403`（per-URI verify 缺 action） | 🟡 RD 處理中 | 只擋批准後 execute 的真 200；build/測試/draft/diff/確認頁不受影響 |
| stage key（`.env` `STAGE_pwd`/`STAGE_AUTHSVC_SERVICE_KEY` 空） | ⬜ | 替代 live 路線；補齊可在 stage 驗真 200 |
| BY_DATETIME wire 樣本 | ✅ 已攔（2026-08-20） | 不阻擋本版（本版不做 by-date）；供 §11 擴充 |

## 11. 未來（明確非本 spec，接續順序）

1. **塊 B — 到點派送排程**（下一步，另 session）：以 probe「be2 有無原生庫存排程」開頭；無則 server 端 timezone-safe 排程器 + 延遲執行授權模型（Option 1 token store）。B 排的就是本版打通的 fullday 即時寫入。
2. **adjust（相對調整）**：加回 `op` + `modify_type=0`；後端原生支援。
3. **SKU 維度**（`sku_by_amount`）：item schema 加 `sku_oid`，L1 key 改 sku_oid。
4. **依日期 / 場次**（`item_by_date`/`sku_by_date`）：加回 `dates[]`/場次 + search 帶 rrules；BY_DATETIME 樣本已備（`{key:{date:{fullday|"HH:MM":N}}}`）。
</content>
</invoke>

<!-- agy-peer-reviewed: 2026-08-20T07:01:00Z rounds=2 verdict=approved -->
