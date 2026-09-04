# SIT 商品公告（product announcement）契約探索報告

日期：2026-08-18　來源環境：SIT be2-220
> 這是 **Module Factory 段①（契約探索）的產物範本**——未來新 domain 上車時照此格式產同類報告，直接填滿 `module-onboarding.md` §1「外部依賴」checklist。
> 探索方法：playwright 登入 be2-220 真前端攔真實請求 + 前端 v3 bundle 逆向 + curl 直打驗證。憑證明文一律不入文件。

## 1. 摘要

商品公告是**全新 domain**（非 product 形狀）：不同 host（svc-b2c 而非 product-service）、不同成功 envelope（`metadata.status '0000'` 而非 product 的 `meta.status 100000`）、額外 header（`x-api-key` + `user-uuid`）。選它當 Module Factory 首發標的，正是要驗證 `ActionModule` 介面接不接得下「非 product 形狀」的 domain（對應 `module-architecture.md` watch-out 1 的思辨）。

## 2. Host / Endpoint / Envelope

| 項 | 值 | 來源 |
|---|---|---|
| host（SIT） | `https://api-gateway-220.sit.kkday.com/svc-b2c/api/v1` | ENDPOINTS.md + playwright 攔截 |
| host（prod） | `https://api-gateway.kkday.com/svc-b2c/api/v1` | ENDPOINTS.md |
| 列表 | `GET /admin/product/announcement?page=&perPage=&prodOids=` | playwright 攔截 #69 |
| 建立 | `POST /admin/product/announcement`（一筆橫跨所有選定 prodOids） | ENDPOINTS.md |
| 更新 | `PATCH /admin/product/announcement/{announcementOid}`（部分更新，實務少用） | ENDPOINTS.md |
| 成功契約 | HTTP 200 **且** `metadata.status == '0000'`；其餘一律視為失敗、逐字回報、不自動重試 | ENDPOINTS.md |

## 3. 必要 header 與來源（缺一即 403）

| header | 值 / 來源 | 實證 |
|---|---|---|
| `authorization` | `Bearer <be2 JWT>`（我方 token store 已有） | — |
| `x-api-key` | `<存於 .env API_ANNOUNCE_KEY，值不落文件>`——前端固定 key | playwright 攔自 `/v3/b2cbe/product-announcement/browse` 的真實請求 header |
| `user-uuid` | **= JWT 的 `platformId` claim**（實測攔到的值與該使用者 JWT platformId 完全一致，`f7965b8d-…`）——我方 token 解碼即得，無需另存 | playwright 攔截 + JWT 解碼交叉比對 |

gateway ACL 允許的 header 白名單（response header `access-control-allow-headers` 揭露）：`Content-Type, Authorization, request-uuid, x-deputy-oid, x-auth-id, x-api-key, user-uuid`。

**`request-uuid` 貫穿已 live 驗證（2026-09-04，SIT be2-220）**：以我方 `AnnouncementClient` 帶自訂 `request-uuid`（`f3aclcheck` 前綴）GET 公告列表（200），Kibana `new-kklog-*` 以 `request.uuid:"<uuid>"` 撈到 **9 hits**：svc-b2c REQUEST/RESPONSE（`api/v1/admin/product/announcement`）、auth `api/v1/verify` REQUEST/RESPONSE/TRACE×2、gateway 層 RESPONSE×3——**同一 uuid 貫穿 gateway→auth verify→svc-b2c 全鏈**，MCP audit ↔ be2 端 log 的 join 在公告域成立（audit spec §3.5 的 F3 caveat 就此關閉）。CORS 白名單（上行）與實際 forwarding（本段）為兩回事，兩者現皆已實證。

## 4. businessList 授權碼（前端 bundle 逆向）

| 動作 | businessList code | 來源 |
|---|---|---|
| 讀（browse/detail） | `product.announcement.query` | v3 main bundle 路由 registry 逆向 |
| 寫（create/edit） | `product.announcement.update` | 同上 |

→ change-set 的 `authz.codes` 填 `product.announcement.update`；讀取工具的 fail-fast 用 `.query`。

## 5. ⚠️ 未解 gate 項（factory 必須停下來要人，不可盲寫）

**svc-b2c 的 /verify 對「S2S token」與「web session token」判定不同：**

| token 種類 | 對 announcement 直打結果 | 意義 |
|---|---|---|
| be2-mcp 的 auth-service **S2S token**（我們 tool call 用的） | **403**（驗證階段即拒） | 目前 be2-mcp 的身分**過不了** announcement 的授權 |
| be2-web 登入 **web session token** | 過驗證（卡 502 後端暫時性，非授權問題） | 真前端身分可過 |

這是 factory **不能盲寫容錯路徑**、必須 gate 給人的關鍵發現（類比 Phase 3a 的 supplier 403，但根因不同：那是 per-supplier 範圍，這是 **token 種類**差異）。

**可能解法（需向 svc-b2c team 確認其一）：**
1. announcement 的 `/verify` 是否接受 auth-service S2S token？若否，需要哪個 service key scope / 額外宣告。
2. 或 announcement 授權天生綁 web session 身分——若是，be2-mcp 的寫入路徑需改走「確認頁 web session token」而非 tool-call 的 S2S token（架構上 confirm-page 已有 web session，可行）。
3. `x-auth-id: be2` 我們已在 GatewayClient 帶；announcement 是否需要不同的 `x-auth-id` 值待確認。

**在此 gate 解除前，announcement module 的 executor 無法對 SIT 跑出真 200**——與 3a 庫存寫入同屬「契約已知、live 寫入待授權」狀態。

## 6. 欄位 gate ✅ 已解（2026-08-19，改於 **stage** 攔到 200）

> **解除方式**：SIT svc-b2c 當時 502，改上 **be2.stage.kkday.com**（gateway `api-gateway.stage.kkday.com`，同 `/svc-b2c/api/v1` 前綴）以 lance.chien web session 用 playwright 攔真實請求——stage 後端是活的，list GET 直接 200。**factory 段②欄位 gate 解除**（list row + create 必填欄位皆到手），announcement 可從備援標的（bundle）切回真首發。

### 6.1 列表 GET 200 — envelope + row（stage 實攔）
`GET /svc-b2c/api/v1/admin/product/announcement?page=1&perPage=25` →
```
metadata: { status: "0000", desc: "Success",
            pagination: { currentPage, total, lastPage, perPage } }
data: [ row, ... ]
```
row 欄位 → 型別：
| 欄位 | 型別 | 備註 |
|---|---|---|
| `productAnnouncementOid` | number | PK；對應 PATCH 的 `{announcementOid}` |
| `name` | string | 公告標題 |
| `prodOids` | number[] | 一筆橫跨多商品（✓ 印證「一筆多 prodOids」） |
| `isEnabled` | boolean | 啟用開關 |
| `startTime` | string | `"YYYY-MM-DD HH:mm:ss"`（UTC+0） |
| `endTime` | string \| null | 同格式，可空 |
| `modifyUser` | string | 顯示名（如 `李佳樺(chiahua.lee)`）；**我方寫入送的是 JWT platformId** |
| `langs` | string | 語系（如 `zh-tw`） |

### 6.2 POST create 必填欄位（stage `/create` 表單實測，未送出）
表單欄位 → POST body 對映（`POST /svc-b2c/api/v1/admin/product/announcement`）：
- `*Name`：string，≤254
- `*Is Enabled`：boolean（預設 on）
- `*Product Oids`：逗號分隔 prod oid（UI 提示 `ex: 7781,16384`）→ 對應 row 的 `prodOids` number[]
- `*Start Time (UTC +0)`：必填 datetime
- `End Time (UTC +0)`：選填 datetime
- `*Select Languages`：必填多選，25 種語系（en-default / en-kk / … / zh-tw / ja-jp / ko-kr / th-th / vi-vn / …）；`en-default` 為 en-xx 的 fallback 文案來源
- （每語系文案 content 疑似選語系後動態展開，表單初始未顯示——**若首發 action 是 enable/disable 開關則不需要**）

### 6.3 仍待補（非 gate、非阻擋）
- [ ] **POST body 的確切 wire 格式**（欄位鍵名、`prodOids` 是 array 還 csv、是否有 per-lang content 陣列）——需送出一次 create 才攔得到（**寫入**，需人核可；可建一筆 isEnabled=off 的拋棄式再刪）。上面 6.2 是表單語義層，足夠讓 factory 產 schema/renderer/ui。
- [ ] **PATCH merge-vs-replace 語義**——同樣需一次真 PATCH。
- 授權：§5 的 **S2S token 403** gate 不變（executor live 寫入仍卡此，屬「契約已知、live 寫入待授權」，與 3a 庫存同狀態）。

## 7. 對 `module-onboarding.md` §1 的對應

| onboarding §1 checklist 項 | 狀態 |
|---|---|
| 可寫帳號與環境 | 🟡 帳號有、環境 SIT 220 有；但 announcement 授權對 S2S token 回 403（§5 gate） |
| businessList 動作碼 | ✅ 已解（§4） |
| contract probe（endpoint/必填/merge-vs-replace/modify_user/可逆） | 🟢 endpoint/header/envelope/授權碼/**row 欄位/create 必填欄位皆已解**（§6，stage 攔 200）；剩 POST wire body 確切格式 + PATCH merge-vs-replace 待一次真寫入 |

→ **factory 判定**：此 domain 可進段②「產」的部分（schema/renderer/ui 靠 ENDPOINTS.md + 本報告足夠），但 executor 的 live 驗收卡在 §5 gate——正是分段闘關制要人介入的點。
