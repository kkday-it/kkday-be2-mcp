# be2-mcp × auth-service 開通清單（給 kkday-auth-service RD）

> 全部都是 **kkday-auth-service** 自己的設定面：service key、Entry Config（per-URI verify 規則）、Business action → 群組對映、`/verify` 行為、`BE2_DOMAIN` origin 白名單。gateway 只是代打 verify、product-service 只是被呼叫的下游——**RD 要動的都在 auth-service**。
> **重要**：be2-mcp **不自己打 `/verify`**（委派 gateway 代打）。**已上線 action_type（上下架/庫存平台）的 Entry Config 早已正確、不需再動**；下面只列「目前 verify 過不了 / 待開」的項。

---

## 0. auth-service RD 只需要動這 3 件（其餘皆 reference / 已 OK）

1. **Service key（stage + prod，需 `read` scope）** — `login-authorization-code`/`refresh-token` 走 `serviceAuth:read`。
   - ⚠️ 現況：手上 stage key（`EvIry7…Vt5`）換碼回 **401 `AU9997 "Service key is invalid"`**（同帳號同 host login 是 200）→ 請確認是否 stage 環境 + read scope 的正確值。
2. **兩條 verify / Entry Config gap**（只有這兩條現在過不了）：
   - **庫存數量寫入 `AU9403`**：`PUT /product/api/v1/items/{itemOid}/inventories/{supplierOid}/quantity`。帳號已有 `product.product-inventory.update`，但 Entry Config 對 URI pattern **`api/v1/items/{*}/inventories/{*}/quantity`** 綁的是**別顆 Business action** → 請查該 action 並加進帳號群組（或告知 code）。（Kibana trace：verify v2 `CheckTargetRuleCache` user-with-business-oid）
   - **商品公告 svc-b2c 403**：`/svc-b2c/api/v1/admin/product/announcement`（GET/POST/PATCH）。此 target 的 `/verify` 對 be2-mcp 的 **auth-service 使用者 JWT 回 403**（對 web session token 則過）→ 請確認 svc-b2c target 是否接受這種 User Token、需哪顆 Business action / 或不同 `x-auth-id`。
3. **`BE2_DOMAIN` origin 白名單（prod）** — prod `isDevEnv`=false 會檢查 POPUP 登入 origin，需把 be2-mcp 部署 origin 納入。

> （另有一條屬 Entry Config 的 IP 欄位：User Token 走 Entry Config 會驗來源 IP，需允許 be2-mcp 部署機 IP。IP 值由 DevOps 提供，設定動作在 auth-service Entry Config。）

---

## 附錄（reference）— be2-mcp 會打的完整 auth 相關端點

> 以下為完整清單供 RD 對照 Entry Config；**已上線者標示，無需動作**。涵蓋規劃中（庫存數量、商品公告、價格 3b）。環境：SIT `be2-220` 已通；stage/prod 待開。

---

## A. auth-service 直打 S2S 端點（需 service key）

| Method | 端點 | 用途 | middleware / 需求 |
|---|---|---|---|
| POST | `/api/v1/auth/be2/login` | 帳密登入取 authorizationCode | `web`（**不需 service key**） |
| GET | `/api/v1/login-authorization-code/{code}` | 換 `{accessToken, refreshToken, businessList}` | **`serviceAuth:read`** ← 需 service key（read scope） |
| PATCH | `/api/v1/refresh-token/{refreshToken}` | rotate 續期（回 fresh businessList） | **`serviceAuth`**（read 即可） ← 需 service key |
| GET | `/auth/be2/login?loginFlow=POPUP` | 瀏覽器登入頁（OAuth/確認頁登入腿） | 瀏覽器流，非 S2S；需部署 origin 在 `BE2_DOMAIN` 白名單 |

**A 要 RD 做的**：
1. **發 stage service key + prod service key**，scope 需含 **`read`**（`login-authorization-code`/`refresh-token` 走 `serviceAuth:read`；`WRITE_SERVICE_KEY`=read+write 也可，`GATEWAY_SERVICE_KEY`/`BE2CI_SERVICE_KEY` **不行**）。
   - ⚠️ **現況卡點**：手上這把 stage key（`EvIry7…Vt5`）換碼回 **401 `AU9997 "Service key is invalid"`**（login 同帳號同 host 200）→ 這把 stage auth-service 不認，請確認是否 stage 環境 + read scope 的正確值。
2. **prod 上線**：把 be2-mcp 部署 origin 納入 `BE2_DOMAIN`（`login.be2.domain`）白名單（prod `isDevEnv`=false 會檢查 POPUP origin）。

---

## B. 經 Gateway 的 URI（User Token，需 Entry Config per-URI 綁 Business action）

> 每條都用**使用者 JWT**（`Authorization: Bearer <user token>` + `x-auth-id: be2`）。RD 需在 Entry Config 確認：對應 platform + method + path 允許 **User Token**、且綁的 **Business action（B-key）** 在 pilot 帳號群組內。**AU9403 = 這裡缺一顆 action。**

### B-1. 已上線 action_type
| Method | Path pattern | 域 | Business action（確認/待查） |
|---|---|---|---|
| GET/PUT | `/product/api/v1/product-configs/{prodOid}/switch` | 上下架（product） | `product.product-sale-status.update` |
| GET/PUT | `/product/api/v1/products/{prodOid}/package-configs` | 上下架（plan） | `product.bundle-package-sale-status.update`（待確認確切碼） |
| GET/PUT | `/product/api/v1/products/{prodOid}/bundle-package-configs` | 上下架（bundle） | 同上家族（待確認） |
| PUT | `/product/api/v1/products/{prodOid}/package-configs/reserve-active` | 排程上下架 | 同上家族（待確認） |
| GET | `/product/api/v1/items/{itemOid}/basic-info` | 庫存平台現況讀 | `product.product-inventory.query`（讀） |
| PUT | `/product/api/v1/items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting` | 庫存管理平台切換 | `product.product-inventory.update`（待確認） |
| GET | `/product/api/v1/products/{prodOid}/packages`、`/drafts/products/{prodOid}/info`、`/drafts/products/{prodOid}/packages` | 方案/草稿現況讀 | 讀取類 |

### B-2. 庫存數量（規劃中：Session 2 塊 A）
| Method | Path pattern | Business action |
|---|---|---|
| GET | `/product/api/v1/items/{itemOid}/inventories/status` | `product.product-inventory.query` |
| POST | `/product/api/v1/items/{itemOid}/inventories/search` | `product.product-inventory.query`（讀逐日數量，✅ SIT 已 200） |
| PUT | `/product/api/v1/item-configs/{itemOid}/inventory-setting` | 庫存模式切換（✅ SIT 已 200） |
| **PUT** | **`/product/api/v1/items/{itemOid}/inventories/{supplierOid}/quantity`** | **⚠️ 逐日數量寫入 —— 這條 SIT be2-220 回 `AU9403`** |

**⚠️ B-2 的關鍵卡點（請 RD 處理）**：
> 帳號 `lance.chien@kkday.com` 打 `PUT /product/api/v1/items/{itemOid}/inventories/{supplierOid}/quantity`，被 verify v2 拒（`AU9403`，`CheckTargetRuleCache` user-with-business-oid）。帳號**已有** `product.product-inventory.update`，但 Entry Config 對 URI pattern **`api/v1/items/{*}/inventories/{*}/quantity`**（可能還有 `api/v1/items/{*}/inventories`）綁的是**別顆 Business action**。請查該 URI 規則綁定的 action code，並加進我帳號群組（或告知 code 讓我申請）。

### B-3. 商品公告（規劃中：Session 1 塊 C）—— **svc-b2c target，不是 product**
| Method | Path pattern | 備註 |
|---|---|---|
| GET | `/svc-b2c/api/v1/admin/product/announcement` | 列表（讀）`product.announcement.query` |
| POST | `/svc-b2c/api/v1/admin/product/announcement` | 建立（一筆跨多 prodOids）`product.announcement.update` |
| PATCH | `/svc-b2c/api/v1/admin/product/announcement/{announcementOid}` | 更新 |

**⚠️ B-3 的關鍵卡點（請 RD 釐清）**：
> svc-b2c announcement 的 `/verify` 對 **be2-mcp 的 auth-service S2S token 回 403**（對 web session token 則過）。想確認：announcement（target=svc-b2c）的 Entry Config 是否接受 be2-mcp 這種「auth-service 使用者 JWT」？需要哪個 Business action / 或不同 `x-auth-id`？（細節見 `sit-announcement-contract.md` §5）額外 header：`x-api-key`（前端固定 key，已有）+ `user-uuid`（=JWT platformId）。

### B-4. 價格（規劃中：3b，較後）—— 皆 draft
| Method | Path pattern |
|---|---|
| POST | `/product/api/v1/drafts/items/{itemOid}/quotations/search`（讀成本售價） |
| GET | `/product/api/v1/drafts/items/{itemOid}/prices` \| `/costs` \| `/official-prices` \| `/cost-setting` |
| PUT | `/product/api/v1/drafts/items/{itemOid}/quotations`（寫,per-date/session）\| `/prices` \| `/official-prices` |
| POST | `/product/api/v1/gross-margin/availability`（毛利驗證） |
| PATCH | `/product/api/v1/drafts/products/{prodOid}/fix-prices`（固定價 CSV 批次） |

Business action：`product.*` 價格相關（**待查真實 businessList**）。

---

## C. 給 RD 的「一次加齊」總結（最短版）

1. **stage + prod service key，read scope**（修現況 `AU9997`）。
2. **Entry Config：確認 B-1〜B-4 所有 URI pattern 對 pilot 帳號的 User Token 放行**，尤其：
   - **B-2 `.../inventories/{*}/quantity` 的 Business action**（現 `AU9403`）← 最優先。
   - **B-3 svc-b2c announcement 的 token 種類 / action**（現 S2S 403）。
3. **prod**：be2-mcp 部署 origin 納 `BE2_DOMAIN` 白名單。
4. **User Token 走 Entry Config 會驗來源 IP**（Entry Config 的 IP 欄位）——be2-mcp 部署機器 IP 需在允許範圍（見 `deploy-architecture.md`）。

> 依據：`sit-write-contracts.md`（AU9403 Kibana 追蹤）、`sit-announcement-contract.md`（§5 svc-b2c 403）、Entry Config 使用指南（Confluence KB 1987477648）。
