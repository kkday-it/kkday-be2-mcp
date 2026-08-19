# SIT bundle 上下架契約探索報告（Module Factory 段① 產物）

日期：2026-08-18（欄位 2026-08-19 於 stage 補齊）　標的：`shelf_toggle_bundle`（factory 首發備援標的）

> ✅ **欄位 gate 已解除（2026-08-19）**：SIT 無組合方案商品，改於 **stage be2（`api-gateway.stage.kkday.com`）商品 19513** 攔到真實 bundle row（7 筆），欄位形狀補齊（見 §6）。段②/③ 可跑。


## 1. 摘要

bundle（組合方案）上下架——同 product API、同 envelope（`meta.status 100000`），最像 `shelfToggle`（flip is_active）。選為 factory 首發備援標的（真首發 announcement 欄位 TBD）。**探索結果觸發欄位 gate**，見 §5/§6。

## 2. Host / Endpoint / Envelope

| 項 | 值 | 來源 |
|---|---|---|
| host（SIT） | `https://api-gateway-220.sit.kkday.com/product/api/v1` | factory-input-bundle.md |
| 讀 | `GET /products/{prodOid}/bundle-package-configs` | playwright/curl 攔截 |
| 寫 | `PUT /products/{prodOid}/bundle-package-configs`（flip is_active） | ENDPOINTS.md |
| 成功契約 | HTTP 200 且 `meta.status == '100000'` | **實測確認**（GET 34133 回 200 + meta.status 100000） |

## 3. 必要 header

| header | 值 / 來源 |
|---|---|
| authorization | `Bearer <be2 JWT，store 內>` |
| x-auth-id | `be2`（GatewayClient 既有帶） |

無額外 header（同 product API，非 svc-b2c）。

## 4. businessList 授權碼

沿用 shelf 類（bundle 屬上下架）：`product.product-sale-status.update` / `product.bundle-package-sale-status.update`（待 bundle-miner 對真 bundle 商品的前端逆向確認；product API 授權可達，非 svc-b2c 的 token 種類問題）。

## 5. ⚠️ 未解 gate 項（授權 gate）

**無授權 gate**。用 be2-mcp 的 S2S token 直打 `GET .../bundle-package-configs` 回 **HTTP 200**（不是 announcement 那種 403）——product API 對 S2S token 正常放行。

## 6. item 欄位形狀（★ 已填實——stage 商品 19513 實測，2026-08-19）

- **列表 GET 200 的 row 欄位**（`GET /products/19513/bundle-package-configs` → 200、`meta.status 100000`、7 筆 row）：
  ```
  { bundle_pkg_oid, name, is_active, reserve_date, reserve_status, reserve_queue, updated_by, updated_at }
  sample: { bundle_pkg_oid: 57478, name: "展望台門票 + 大阪地鐵一日券", is_active: false,
            reserve_date: null, reserve_status: null, reserve_queue: [], updated_by: "<uuid>", updated_at: "2025-11-11 07:02:04" }
  ```
- **★ 關鍵差異**：key 欄位是 **`bundle_pkg_oid`**（不是 package-configs 的 `pkg_oid`）——盲寫用 pkg_oid 會錯。item 形狀：`{ prod_oid, bundle_pkg_oid, target_is_active }`；itemKey = `prod_oid:bundle_pkg_oid`。
- **PUT body**：`PUT /products/{prodOid}/bundle-package-configs`，read-merge-write flip `is_active`，帶 `modify_user`（=JWT platformId）；`updated_by`/`updated_at` 為 server-set 唯讀、寫時剔除（同 shelfToggle plan 的 `PLAN_PKG_READONLY` 慣例）。
- **可逆性**：flip is_active 可逆（改回即還原）。
- **noop**：`is_active === target_is_active` 略過。

**GATE 1 判定 = 無 gate（無授權 gate §5、欄位已填實）→ 段② 可全五格產**（bundle 非批次精靈型，無 ui 格）。

**解 block 來源**：找一個 SIT 上真有 bundle-package-configs row 的商品（或 be2-web 搜組合方案商品）攔一次 200。

## 7. 參考格對照（供段② 用，欄位補齊後）

| 六格 | 最像的現成格 | 理由 |
|---|---|---|
| keys | `shelfToggle/keys.ts` | 同 prod_oid:pkg_oid 或 prod_oid 形狀 |
| module | `shelfToggle/module.ts` | flip is_active、同 authz 類 |
| diff | `shelfToggle/diff.ts` | current_is_active → target_is_active |
| executor | `shelfToggle/executor.ts` | read-merge-write flip is_active |
| renderer | `shelfToggle/renderer.ts` | 上/下架 diff 呈現 |
| ui | 無（bundle 非批次精靈型） | — |

## 8. 備選標的（factory 首發改用，欄位已驗）

bundle 欄位 gate 未解時，改用 **inventory 基本設定 mode**（`item_config.inventory_setting`）當 factory 首發——欄位**實測可觀察**：`GET /items/{itemOid}/basic-info` 回 `item_config.inventory_setting = {control_type: 2, inventory_type: 0}`（item 1713281 實證 200）；寫入 `PUT /item-configs/{itemOid}/inventory-setting`。此標的無欄位 gate、無授權 gate（product API 200），能真跑段②/③ 驗 factory 的「產」能力。
