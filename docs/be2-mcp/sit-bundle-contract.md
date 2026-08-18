# SIT bundle 上下架契約探索報告（Module Factory 段① 產物）

日期：2026-08-18　來源：SIT be2-220　標的：`shelf_toggle_bundle`（factory 首發備援標的）

> ⏸️ **DEFERRED（2026-08-18）**：SIT 無組合方案商品可觀察 bundle row 欄位 → 段②/③ 暫緩，**待上 stage 環境或 SIT 補建組合方案商品後驗收**。skill 本體已完成，此標的只差真商品攔一次 200。


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

## 6. item 欄位形狀（★ 欄位 gate 判定依據）→ **未填實：觸發欄位 gate**

- **列表 GET 200 的 row 欄位**：⚠️ **TBD**。SIT 上 7 個商品（9468/34133/546965/130087/135040/140011/1713281）的 `bundle-package-configs` 全回 `data: []`——SIT 未建過「組合方案」商品，無 row 可觀察。34133 wizard 顯示的「bundle」標籤是 package-configs 的 `is_bundle:true` 方案，與 `bundle-package-configs`（組合方案商品）是不同 endpoint。
- **PUT body 必填**：TBD（推測 `{is_active, modify_user}` 類比 shelfToggle plan，但 factory 規則禁盲寫、未觀察不填）。
- **merge-vs-replace / modify_user / 可逆性**：TBD（同上）。

**GATE 1 判定 = 欄位 gate → 段② block**。這證明 factory 的核心防護正確：連被稱為「安全備援」的 bundle，欄位拿不到就停、不憑空補。

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
