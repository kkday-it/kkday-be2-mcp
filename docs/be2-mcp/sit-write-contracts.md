# be2-220 WRITE-contract findings (Phase 2a Task 1, controller-run 2026-08-09)

Probed live against api-gateway-220.sit.kkday.com with the `.env` account (lance.chien@kkday.com), using its OWN non-marketplace test product `546965` / plan `1967504` (created by automation). Reversible probe.

## ⚠️ CORRECTION (2026-08-09, verified by driving be2-web itself with Playwright)

The findings in §1–§5 below were **partly wrong**. Verified by clicking the real be2-web shelf toggle for product 546965 (page `https://be2-220.sit.kkday.com/v2/product/{prodOid}/sale-status/edit-detail`) and capturing the actual request:

1. **Our write endpoint + contract are CORRECT.** be2-web sends exactly `PUT {gateway}/product/api/v1/product-configs/546965/switch` with body `{"is_active":false,"modify_user":"f7965b8d-ae5f-421c-9ced-c69a7587b422"}` — the same product-service-direct endpoint our Phase 2a executor uses. Minimal body = just `{is_active, modify_user}` (no other required fields on /switch).
2. **`modify_user` = the JWT `platformId` claim** (`f7965b8d-…` = lance.chien's `platformId`), NOT a separate be2 userUuid needing an auth-service lookup. So §1 below is WRONG. The stored `24c66807-…` was just whoever last modified (lance.liu); the value you SEND is your own `platformId`. **⇒ Phase 2a's `modifyUserFromPlaceholder` (returns `platformId`) is actually CORRECT, not a placeholder — the modify_user blocker is resolved.**
3. **The 403 is genuine per-product authorization, not a mechanism/path/S2S issue.** be2-web ITSELF — real browser, real user session, correct contract — gets the SAME `403` on this write (console error + network capture confirm). Product 546965's last-modifier is `lance.liu@kkday.com`; lance.chien apparently lacks write authz on this specific product. **⇒ To get a successful live write we need a product this account can actually write** (not a code fix, not a different mechanism, not necessarily a different account — a product in this user's write scope). §4's "write-capable account" framing is imprecise: the account HAS the `product.product-sale-status.update` + `bundle-package-sale-status.update` businessList codes; it's per-oid ownership that denies 546965.

Net: executor write path/contract validated end-to-end against be2-web; `modify_user`=platformId resolved; only a write-authorized product (or that authz granted for a test product) is still needed for a green toggle. §1–§5 below are superseded where they conflict with this block.

## STAGE confirmation (2026-08-09, user-provided curls) — the write SUCCEEDS on stage

The user demonstrated the **same account + same product 546965 + same contract** succeeding on **stage** (`api-gateway.stage.kkday.com`), while SIT be2-220 returns 403. Captured working request:
```
PUT https://api-gateway.stage.kkday.com/product/api/v1/product-configs/546965/switch
headers: authorization: Bearer <be2 stage JWT>, content-type: application/json, x-auth-id: be2,
         request-uuid/x-request-id (browser tracing), origin/referer (browser CORS)
body: {"is_active":false,"modify_user":"f7965b8d-ae5f-421c-9ced-c69a7587b422"}   // modify_user = platformId
→ 200 (succeeds)
```
Conclusions:
- **The SIT be2-220 403 is purely a per-ENVIRONMENT authorization difference** (this account can write 546965 on stage, not on be2-220) — not a code, path, header, or mechanism problem. Definitive.
- **Our `GatewayClient.put` is contract-equivalent to this working request**: same method/path/body + `x-auth-id: be2`. The extra `request-uuid`/`x-request-id`/`origin`/`referer` headers are browser tracing/CORS, NOT required for authz (the SIT 403 fired even with them present, via be2-web). So our executor would succeed against an environment/product where the account is authorized.
- **`modify_user` = JWT `platformId`** reconfirmed (the successful stage PUT uses it).

### Still needed for a fully-green live write THROUGH our code
Our code can't reproduce the stage write yet because **`.env` has `STAGE_pwd` and `STAGE_AUTHSVC_SERVICE_KEY` empty** (only `STAGE_email` set), and the curl's bearer is a ~5-min token (expired). To close it, ONE of:
1. Fill `STAGE_pwd` + `STAGE_AUTHSVC_SERVICE_KEY` in `.env` → run the executor/probe against stage hosts (`auth.stage.kkday.com` / `api-gateway.stage.kkday.com`) for a reversible toggle+revert; OR
2. Paste a fresh stage be2 bearer (validity ~5 min) to drive `GatewayClient.put` directly; OR
3. Grant this account write authz on a be2-220 test product (keeps everything on the SIT anchor).

## Open-item results

### #1 modify_user = a be2 **userUuid** (UUID), NOT a JWT claim — needs auth-service resolution
- The stored `modify_user` on the product is `24c66807-352e-41da-8a28-53b482ba7f4e` (UUID); `package-configs[].updated_by` is the same UUID. So `modify_user` is the acting user's **be2 userUuid** (UUID format).
- The account's JWT claims are: `authOid=40196, authKey=<email>, subAuthOid=41546, platformOid=1, platformId=f7965b8d-…, userType=be2, deputyOid/platformDeputyOid=null, groupOids, optional`. **None equals the userUuid `24c66807`.**
- => `modifyUserFrom` CANNOT be a JWT decode. The userUuid must be resolved via an auth-service call (candidates: `POST /api/v1/verify` return, or `GET auth/be2/token/sub-user` — phase0 A8 used `token/sub-user` for the user context). **UNRESOLVED which endpoint yields the userUuid — needs a write-capable session to confirm the exact source + that the write accepts it.** The plan isolates this behind the injected `modifyUserFrom` (executor is agnostic); app.ts real wiring is BLOCKED on this.

### #2 package-configs merge-vs-replace — UNRESOLVED (write 403s, see #4)
- Could not determine merge vs replace: every PUT returned 403 (authz), never reaching field validation.
- **But the data-loss risk is CONFIRMED REAL**: each package-config object carries 13 fields — `pkg_oid, name, is_active, is_bundle, is_standalone, reserve_date, reserve_status, reserve_queue, pay_on_site_marketings, has_activity_label, user_promotion_label, updated_by, updated_at`. Stripping to `{is_active}` (the pre-agy-review executor) WOULD have wiped reserve/bundle/standalone settings on a replace. **read-merge-write (preserve each pkg's full object, flip only is_active) is validated as the correct design.**
- `updated_by` / `updated_at` are server-set (read-only) → likely must be dropped from the PUT body (add to the executor's read-only strip list alongside `is_locked_for_active`).

### #3 required-field set — UNRESOLVED (write 403s before validation).
- `/switch` GET returns: `is_active, is_global_search, instant_order_flag, is_recommend_mail, promo_tag, payment_invoice_type, modify_user, allow_modify_platform, is_locked_for_active, allow_sale_channel, market_external_edit_blocked, market_edit_block_change_reason`. `is_locked_for_active` (and likely the `market_*` fields) are read-only. Confirm the minimal accepted PUT body once a write-capable account is available.

### #4 a write-capable product/account — **BLOCKER**
- The `.env` account gets **403 on the shelf-toggle PUT even on its OWN products** (546965). So it is read-capable but lacks be2 **shelf-write permission** on be2-220 (a role/businessList limitation, not product ownership).
- **Consequence: the live write-SUCCESS e2e (Task 10) and resolving #1/#2/#3 are BLOCKED until a SIT account with be2 shelf-toggle write permission is provided** (or this account is granted it). Everything else in Phase 2a is buildable + unit-testable without it.

### #5 gateway enforces authz on PUT — CONFIRMED (design validated)
- The write PUT reaches the gateway and returns a clean **403** (fail-closed) for the unauthorized account. This validates spec §3: authz is delegated to the gateway on writes; be2-mcp needs no self-`/verify` with an internal URI. A low-privilege user gets a be2-native 403 at execution, exactly as designed.

## What this means for the build
- Tasks 2–9 proceed unchanged: the executor takes an injected `modifyUserFrom`, unit tests inject a stub (`() => 'UUID-1'`), and the 403 fail-closed path is testable. read-merge-write preserving full objects is confirmed correct.
- Task 8 app.ts wiring of the REAL `modifyUserFrom` (auth-service userUuid resolver) is deferred until #1 is resolved with a write-capable session.
- Task 10 live write e2e is BLOCKED pending a write-capable SIT account.

## inventory (Phase 3a Task 1, 2026-08-10)

Probed live against `api-gateway-220.sit.kkday.com` with the `.env` account (`lance.chien@kkday.com`), script `scripts/probe-sit-inventory.ts`. Target: `item_oid=1713281` — this is the account's OWN test product (`prod_oid 546965`, plan/`pkg_oid 1967504`, resolved live via `npm run probe-sit -- 546965` → `packages[0].item_oid`), chosen specifically to rule out "not my product" as the 403 cause (unlike the marketplace item 841808 used in Phase 1a).

### Result: BLOCKED at the quantities GET (`403`) — same failure mode as Phase 1a, now confirmed on the account's OWN item too

```
GET /product/api/v1/items/1713281/inventories/status -> 200   ({"is_processing":false,...})
GET /product/api/v1/items/1713281/inventories/0?year_month=2026-08 -> 403
GET /product/api/v1/items/1713281/inventories/1?year_month=2026-08 -> 403
GET /product/api/v1/items/1713281/inventories/2?year_month=2026-08 -> 403
```

Tried `supplier_oid` 0, 1, 2 (the same candidates Phase 1a tried on item 841808) — all three 403 on item 1713281 as well. The `/status` endpoint (no supplier dimension) returns 200 cleanly; only the per-supplier `.../inventories/{supplierOid}` read is denied.

### New finding vs. Phase 1a: the account HAS the businessList inventory action codes

`tokens.businessList` (683 entries) contains, filtered for `/invent/i`:
```
["product.product-inventory.query","product.product-inventory.update","vtrans.airport-transfer-capacity-inventory.edit"]
```
So this is **not** a missing-action-code problem (the account is action-authorized to query/update inventory in general) — it is a **per-supplier ownership/scope denial**, structurally identical to the shelf-toggle finding for product 546965 (§ above: action code present, per-oid ownership denies). The account is read-capable on `/status` (no supplier scoping) but not on the supplier-scoped quantities read, even for a product it created itself. This suggests inventory authorization is scoped by **supplier_oid** (this account isn't registered as/mapped to any supplier on be2-220), not by product ownership — consistent with `product-service` treating inventory as `item × supplier × date`.

### Q1–Q8 (spec §8) — status: OPEN, blocked before reaching the write

| Q | Question | Status |
|---|---|---|
| Q1 | Real GET shape / writable quantity field name (total vs remaining) | **OPEN** — GET never returned 200, no body observed |
| Q2 | Merge vs replace on PUT | **OPEN** — never reached (blocked before any PUT) |
| Q3 | Batching / cross-month behavior | **OPEN** — never reached |
| Q4 | Quantity field name | **OPEN** — never reached |
| Q5 | Sync vs async (`/status.is_processing`) | Baseline captured: `is_processing:false` before any write attempt (no write attempted, so no before/after transition observed) |
| Q6 | Is quantity per-SKU? | **OPEN** — never reached |
| Q7 | `modify_user` value | Not inventory-specific — reconfirmed generic: JWT `platformId` (`f7965b8d-ae5f-421c-9ced-c69a7587b422`), same as the shelf-toggle finding above |
| Q8 | 403 behavior | **CONFIRMED**: clean `403`, fail-closed, on all 3 tried `supplier_oid` values, on the account's own item — gateway/product-service enforces this before any body validation, same fail-closed pattern as the shelf-toggle write |
| — | Real businessList inventory action code | **CONFIRMED**: `product.product-inventory.query` (read) / `product.product-inventory.update` (write); also `vtrans.airport-transfer-capacity-inventory.edit` (unrelated vertical, not be2 product inventory) |

No `tests/fixtures/inventory-quantities.json` was written — the script's guard (`if (q.status !== 200) return`) means the fixture is only produced on an actual 200, which never happened.

### Blocker + unblock path (unchanged shape from the Phase 2a shelf-toggle blocker)

The `.env` SIT account is **not mapped to any supplier** on be2-220 for the tested item (or any item — `/status` has no supplier dimension so it can't discriminate; the 403 is specifically on the `{supplierOid}` path segment). Two independent unblock paths, either sufficient:
1. **be2-220 grant**: get this account mapped as a supplier for a test item on be2-220 (ask whoever owns supplier assignment — likely the same grant surface as the Phase 2a shelf-write grant, but scoped to inventory/supplier rather than product-sale-status).
2. **stage**: `.env`'s `STAGE_pwd` and `STAGE_AUTHSVC_SERVICE_KEY` are still empty (unchanged since Phase 2a) — filling them would let this probe run against stage, where the account may already have supplier mappings (per the Phase 2a stage shelf-toggle success, stage authz differs from be2-220 for this account).

**Downstream consequence for Phase 3a Tasks 2–9**: Q1–Q6 stay open. Per the plan (Task 1 interface note), later tasks proceed with **defensive/tolerant parsing** of the inventory quantities shape (accept either a `total`/`remaining`-style field, don't assume merge vs replace, cap batch size defensively) rather than a shape confirmed against a real 200. Task 9's live e2e exit gate goes **PENDING** on this same blocker, exactly as Task 10 did for the shelf-toggle in Phase 2a.

### 2026-08-10 追加(headless source-dig + live 重測):403 之謎解開 —— 是「端點選錯」,不是 supplier 授權;寫入契約已從原始碼出土;首個 be2-220 真 200 寫入達成

讀本機 `kkday-be2-api`/`kkday-be2-web` 原始碼(be2-web 庫存頁真正呼叫的鏈路)後 live 重測,推翻上節「per-supplier 對映缺失」推論:

1. **supplier 根本不用猜也不用申請對映**:`GET /product/api/v1/items/{itemOid}/supplier-mappings` → **200**,item 1713281 的真實 supplier = **15247**(`is_default:true`,「築地市場 (IT 訂單組測試用商家)」)。
2. **用真 supplier 打 `GET .../inventories/{supplierOid}` 照樣 403** —— 因為**這條是 be2-api 對 product-service 的 S2S 內部端點**(be2-api 帶自己的 service 憑證呼叫),對使用者 token 就是拒絕。**UI 實際讀逐日庫存走的是 `POST /product/api/v1/items/{itemOid}/inventories/search`**(body `{item_oid, supplier_oid, rrules?, filter?, spec?}`)→ 用使用者 token **200**。**⇒ Phase 3a 的讀取側(L0 tool + diff + executor base read)必須從 GET 換成 POST search —— 列入 FINALIZE 工作。**
3. **item 1713281 現況是 UNLIMITED**(`basic-info` 200:`inventory_setting.control_type=0, inventory_type=null`,`default_inventory_qty:null`)→ search 回 `[]` 是合法空集,不是錯誤。模式 enum(源碼):UNLIMITED=0/00、ITEM_BY_QUANTITY=10、ITEM_BY_DATETIME=11、SKU_BY_QUANTITY=20、SKU_BY_DATETIME=21(十位=control_type、個位=inventory_type)。
4. **寫入契約(源碼出土,be2-api → product-service)**:
   - **逐日數量寫入 = `PUT /product/api/v1/items/{itemOid}/inventories/{supplierOid}/quantity`**(supplier 在 path!解 T6 review 的 supplier-scoping 疑問),body `{inventory_data: {modify_type, remain_qty}, modify_user}`。
   - **`modify_type`:1 = REPLACE(set)、0 = ADD_AND_SUBTRACT(adjust)** —— 後端**原生支援相對調整**(be2-web `BatchUpdateType` enum REPLACE_ALL=0/ADD_AND_SUBTRACT=1 經 `+!value` 反轉成 code)。設計含意:executor 可繼續走「本地算絕對值 + modify_type=1」保留 would_go_negative/partial 語義,原生 adjust 為備選。
   - **`remain_qty` 形狀 = `{ [skuOid|itemOid]: { [date]: {[event]|fullday: qty} } | {fullday: qty} }`**(be2-web `InventoryRemainQtyUpdateFormatter`;維度依 control_type:item vs sku、single vs by-datetime、有無場次)→ **Q6 答案:模式為 SKU_* 時分 SKU、有場次時分 event**。
   - `modify_user` = be2-api 端 `AuthService::user()->uuid()`(與 platformId 同值,shelf 已雙證)。
   - 另兩條寫入:`PUT item-configs/{itemOid}/inventory-setting` body `{item_oid, inventory_setting:{control_type∈[0,1,2], inventory_type∈[null,0,1]}, modify_user}`(模式切換);`PUT items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting`(供應商層布林)。
5. **Live 重測結果(全程可逆,已還原)**:
   - `PUT item-configs/1713281/inventory-setting`(UNLIMITED→ITEM_BY_DATETIME)→ **200(be2-220 上此帳號首個真 200 寫入!)**;結束後切回 UNLIMITED → 200,`basic-info` 驗證還原乾淨。
   - `PUT items/1713281/inventories/15247/quantity`(modify_type 1 與 0 各試一次)→ **403** —— 數量寫入仍是 per-帳號授權拒絕(與 shelf-toggle 同類),但至此**唯一**還缺的就是這一個 endpoint 的授權。
   - BY_DATETIME 模式下 search 不帶 rrules → 422 `133001「月曆設定與Item Setting設定不符 RRule需帶recurrence_date」`⇒ by-datetime 模式的 search 需帶 item 的 `recurrence_date` rrule(讀取側 FINALIZE 時處理)。
   - `/status` 全程 `is_processing:false`(mode 切換為同步;數量寫入的 sync/async 仍待該 PUT 通了才知)。
6. **Q1–Q8 更新**:Q2(merge-vs-replace)→ **基本解**:quantity 端點是 per-date 操作語義(`modify_type` + 指定日期 map),非全月 replace;read-merge-write 的「全月回送」不需要,executor 可簡化為只送目標日期(FINALIZE 落地)。Q3(跨月)→ remain_qty 以日期為 key,結構上可跨月,上限待實測。Q4(欄位)→ 寫入欄位是 `remain_qty`(剩餘量);read 側欄位名待 search 200-with-data。Q6 → **已解**(見上)。Q1(read row 形狀)→ 唯一還缺 200-with-data 樣本。Q5 → 部分(mode 寫同步)。
7. **剩餘 blocker 收斂為一項**:`items/{itemOid}/inventories/{supplierOid}/quantity` 的 **PUT 授權**(be2-220 此帳號 403)。解法不變:220 授權或補 stage keys。讀取側已無 blocker(search 200)。

### 2026-08-10 再追加(Kibana 一錘定音):quantity PUT 的 403 = auth-service verify v2 的 per-URI 規則擋下,請求從未到達 product-service

以自訂 `request-uuid` 重放 403 PUT 後在 SIT Kibana(`new-kklog-*`)撈同一條 trace(7 hits),完整鏈路:

1. gateway 收到我們的 `PUT items/1713281/inventories/15247/quantity` → 代打 `POST auth/api/v1/verify`。
2. auth-service verify v2:`Verify v2 entry params`(`target=product, uri=api/v1/items/1713281/inventories/15247/quantity, auth_key=lance.chien@kkday.com`)→ 解析出規則 `uri_pattern: api/v1/items/{*}/inventories/{*}/quantity` → **`CheckTargetRuleCache.php` 丟 Exception「user with business oid」** → verify 回 **403 `AU9403`** → gateway 對我們回 403。
3. **product-service 全程未參與**;UI 權限閘(`PRODUCT.PRODUCT_INVENTORY.UPDATE`,帳號有)與後端 verify 規則綁的 action **不同顆** —— 這是一個 API-UI 權限不等價實例(phase0 C3 關注點):UI 讓你按存檔,verify 的 per-URI 規則要求的 business action 你的群組沒有。
4. 對照:`PUT item-configs/{oid}/inventory-setting`(模式切換)同帳號過 verify 且 200 → per-URI 規則綁的 action 逐條不同,缺的只是 quantity(可能含 `items/{*}/inventories`)這幾條的 action。

**精準的解卡請求(給 auth-service / be2 授權管理者)**:
> 帳號 lance.chien@kkday.com(be2-220)打 `PUT /product/api/v1/items/{itemOid}/inventories/{supplierOid}/quantity` 被 verify v2 拒(AU9403,`CheckTargetRuleCache` user-with-business-oid)。請查 target=product、uri_pattern `api/v1/items/{*}/inventories/{*}/quantity`(以及 `api/v1/items/{*}/inventories`)規則綁定的 business action code,並把該 action 加進我帳號所屬群組(或告知 code 由我申請)。帳號已有 `product.product-inventory.update`,顯然規則要求的是別顆。

(這也解釋 stage 可寫:同帳號在 stage 的群組含該 action、be2-220 沒有 —— 與 Phase 2a shelf-toggle 的 per-環境差異同構。)

### 2026-08-19 追加(read-with-data 樣本終於攔到):`inventories/search` 200 的真實形狀 + Phase 3a 容錯解析欄位名全錯，須 FINALIZE

於 be2-220、真人登入 + playwright,商品 2287(product-service `prod_oid 19510`)、`pkgOid 1904256`、`item_oid 1650033`(模式 **方案總量限制 = ITEM_BY_QUANTITY**,`control_type:1,inventory_type:0`,supplier `181`)。點庫存頁「搜尋條件 → 查詢」觸發:

- **Request**:`POST /product/api/v1/items/1650033/inventories/search`，body = `{"supplier_oid":181,"page":1}`（item 在 path、不在 body；此模式**不帶** rrules/filter/spec）。
- **Response 200**：`{"data":{"1650033":{"fullday":32}},"meta":{"status":"100000","desc":"成功"}}`
  - `data` **以 itemOid 為 key**（非陣列），值 `{fullday: <數量>}`。
  - **數量欄位 = `fullday`**（不是 total/remaining/quantity）；`32` = 剩餘可售量。與寫入側 `remain_qty` 的 `{fullday: qty}` 變體對齊（BY_DATETIME 模式才會出現 per-date/per-event 巢狀，本樣本是 item-quantity 故單一 fullday）。
  - envelope = product-service `meta.status "100000"`。

**⇒ Q1（read row 形狀 / 數量欄位名）解除。** 但揪出 Phase 3a `src/tools/inventoryShape.ts` 的容錯候選清單**與真實形狀全不符**（FINALIZE 待辦，非新 bug——當初就標「等真 200 再收斂」）：
- `ROWS_KEYS = ['itemInventory','item_inventory','inventories','quantities']` → 真實無 wrapper array，`data` 直接是 `{[itemOid]:{...}}` 物件。
- `QTY_KEYS = ['quantity','qty','inventory_qty','stock']` → 缺 `fullday`。
- `DATE_KEYS` → item-quantity 模式無 per-date；BY_DATETIME 樣本仍待攔（才能定 per-date/per-event 巢狀鍵名）。
- 讀取端點也仍需從 `GET .../inventories/{supplierOid}`（S2S-only、403）改為 `POST .../inventories/search`（見上節）。
- **FINALIZE 動作**：改寫 `inventoryShape.ts` 解析「`data[itemOid].fullday`」為主形狀 + 保留容錯；補 `tests/fixtures/inventory-quantities.json` 用本樣本；讀取改打 POST search。BY_DATETIME 形狀需另攔一個該模式的 item。

### 2026-08-19 追加②：quantity PUT wire body 前端實證 + 官方操作手冊權威事實

**(a) 寫入 wire body 前端實證**（be2-web 真發、be2-220 因授權 403，但 body 即真實契約）：
`PUT /product/api/v1/items/{itemOid}/inventories/{supplierOid}/quantity`，body：
```json
{"inventory_data":{"remain_qty":{"1650033":{"fullday":20}},"modify_type":0},"modify_user":"<platformId>"}
```
- `remain_qty` **與讀取回應同形狀** `{[itemOid|skuOid]:{fullday|"HH:MM": qty}}`——讀寫對稱。
- `modify_type`：`0`=ADD_AND_SUBTRACT（adjust）、`1`=REPLACE（set）。此發是 adjust。
- `modify_user` = JWT platformId（再度確認）。
- → **與源碼出土契約完全一致**（見上「2026-08-10 追加」§4），現多一層「前端實發」佐證。

**(b) 官方操作手冊權威事實**（`product-team-docs/Product/系統操作手冊/12-庫存設定.md`，這份是 product team 維護的權威文件）：

API endpoints（手冊列，與我方實證一致）：
| Method | Path | 用途 |
|---|---|---|
| PUT | `api/v1/item-configs/{itemOid}/inventory-setting` | 更新庫存模式（`control_type`+`inventory_type`） |
| POST | `api/v1/items/{item}/inventories/search` | **讀**位控資料（我方已攔 200） |
| PUT | `api/v1/items/{item}/inventories/{supplierOid}/quantity` | **寫**數量（同步、我方已攔 body） |
| PUT | `api/v1/items/{item}/inventories` | 非同步更新數量（批量變體） |

5 種庫存模式（`control_type` 十位、`inventory_type` 個位；與我方 enum 推導一致）：
| 代碼 | 中文 | control_type | inventory_type |
|---|---|---|---|
| `none` | 無限量 | -- | null |
| `item_by_amount` | 套餐總量限制 | 1 | 0 |
| `item_by_date` | 套餐總量-依日期&場次 | 1 | 1 |
| `sku_by_amount` | SKU 總量限制 | 2 | 0 |
| `sku_by_date` | SKU 總量-依日期&場次 | 2 | 1 |
（我方實測 item 1650033 = `item_by_amount`(1/0)，故讀回單一 `{itemOid:{fullday}}`。）

`remain_qty` 結構（權威）：`{"fullday": 50}`（無場次）或 `{"09:00": 20, "14:00": 30}`（有場次）→ **內層 key 是 `fullday` 或場次時間字串**。DB：`inventory.remain_qty` jsonb、`reference_type`(1=item/2=sku)、`reference_oid`(itemOid|skuOid)、`event_date`(null=總量)。

高風險/語義事實（供 renderer 警語與 diff 邏輯）：
- **數量修改立即生效**（正式資料直接異動）；歸零 → `InventoryEmpty` 事件清 sale-time cache + PubSub 通知搜尋（Solr/ES）→ 立即影響前台可售（Phase 3a renderer 紅字警語獲權威背書）。
- **銷售判斷優先序：日期場次開關 > 庫存數量**（sku-date-switch 關閉會蓋過有量）。
- 庫存 by supplier（每供應商各一份）；起訖月曆商品只能「無限量」；`none` 模式共享服務回 `MAX_QUANTITY=999`。

> 🔑 **發現高價值來源**：`kkday-it/product-team-docs` 的 `Product/系統操作手冊/` 有 33 份 product team 權威手冊（含 `04-成本售價設定.md`=3b 價格、`02-套餐設定.md`、`14-商品上架狀態設定.md`、`30-組合套餐匯入模組.md` 等）——**未來各 action_type onboarding / factory 段① 探索應優先讀對應手冊**，比逆向 API 快且權威。已記入 memory。

### 2026-08-20 追加：BY_DATETIME 樣本攔到 → 庫存讀取形狀矩陣完整

be2-220 真人登入 + playwright，商品 2247、item 1677495（**sku_by_date**：L1 key 為 32-hex sku_oid），庫存頁點查詢：
- **Request**：`POST /product/api/v1/items/1677495/inventories/search`，body = `{"rrules":[{recurrence_date, recurrence_event}], "supplier_oid":2671, "page":1}`（**日期模式必帶 `rrules`**；解掉先前 by-datetime 不帶 rrules 的 422）。
- **Response 200**（`meta.status "100000"`）：`{data:{ [sku_oid]:{ "YYYY-MM-DD":{fullday: qty|null}, … } }}`（本樣本 7 SKU × 343 日期，值多為 `null`=未設）。

**→ 讀取形狀矩陣完整（`control_type` 決定 L1 key、`inventory_type` 決定有無日期層、內層 key=`fullday`|場次時間、值=數量或 `null`）**：
| 模式 (control/inv) | L1 key | 巢狀 | 來源 |
|---|---|---|---|
| item_by_amount (1/0) | itemOid | `{itemOid:{fullday:N}}` | ✅ item 1650033 |
| sku_by_amount (2/0) | sku_oid | `{sku_oid:{fullday:N}}` | 推論（同家族） |
| item_by_date (1/1) | itemOid | `{itemOid:{date:{fullday\|"HH:MM":N}}}` | 推論 |
| sku_by_date (2/1) | sku_oid | `{sku_oid:{date:{fullday\|"HH:MM":N}}}` | ✅ item 1677495 |

**FINALIZE parser 要點（`inventoryShape.ts` 改寫依據）**：L1 key 可能是 itemOid（數字）或 sku_oid（32-hex）；可能有或沒有日期層；內層 `fullday` 或場次時間字串；**值可為 `null`**（未設，需容錯不當 0）。此矩陣＋官方手冊 `remain_qty` 定義已足以把容錯猜測換成確定解析。**同時解掉 BAA 庫存排程「依日期/場次未支援」**（memory `be2-mcp-phase3-plan`）——形狀已知即可擴。

> ⚠️ **不鎖死原則（使用者 2026-08-20 提醒）**：上表是**已確認的主形狀**，但**不同商品類型（飯店 / F&B / GYG 動態價 / OCBT / 高鐵假期等）的 response 可能有變體**。→ parser 應**以此矩陣為主解析路徑、但保留 defensive 容錯**（未知 key/缺層/null 值都優雅降級），**不要 hard-code 成單一形狀**。把「確認的形狀」當快樂路徑，不是唯一路徑；遇到沒見過的類型先記錄樣本、再擴解析，而非拋錯。

### 2026-08-19 附帶：sku-date-switch（日期/場次可售開關）讀取形狀（同 session 一併攔到，屬痛點#2 域、非庫存數量）

同頁「日期/場次銷售開關」分頁觸發（item 1650033、supplier 181）：
- **Request**：`POST /be2/api/v1/product/item/{itemOid}/sku-date-switch`，body = `{"rrules":[{recurrence_date, recurrence_event}], "supplier_oid":181, "page":1}`（`rrules` 取自 item 的 `basic-info.item_calendar_rule`；此為 **POST=讀**，phase0 §C 已定調）。
- **Response 200**（envelope `metadata.status "0000"`，非 product-service 的 `meta.status "100000"`）：
  ```
  data: { [sku_oid]: { "YYYY-MM-DD": {fullday: 0|1}, ... }, ... }
  ```
  - **確認 date-based 巢狀 = `{[sku_oid]:{[date]:{fullday:N}}}`**（key 為 sku_oid、再 date、再 `fullday`）。與 item-quantity 的 `{[itemOid]:{fullday:N}}` 一致：**`fullday` 鍵通用，巢狀深度依模式（item vs sku、single vs by-date）而變**。
  - 此域 `fullday: 1=可售 / 0=關閉`（是**可售開關**、不是數量）。→ 供未來「日期/場次可售」action_type 參考；SKU_BY_DATETIME 的庫存**數量**形狀應同結構、但 `fullday` 值為數量。
- **transient 觀察**：同 body 先 403（#75）後 200（#78）——第一發撞 token refresh race，重試即過，非授權/契約問題。

## inventory-platform read (Phase 4a Task 1, 2026-08-14)

目的:為 `inventory_platform` change-set(切換方案的庫存管理平台:BE2／BE2_SCM／EXTERNAL)定案「以 `(item_oid, supplier_oid)` 為鍵讀兩布林 `is_external_inventory`/`is_inventory_mgmt`」的讀取端點,供 Task 3 `readSupplierInventorySetting()` 實作依據。已知寫入契約(design doc §4.1,未在本次驗證):`PUT items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting` body `{is_external_inventory, is_inventory_mgmt, modify_user}`。

**Probe**:`scripts/probe-supplier-config-read.ts`(read-only,唔碰任何 PUT),對 `api-gateway-220.sit.kkday.com`,`.env` 帳號(`lance.chien@kkday.com`),目標商品 **34133**(demo 商品,PUBLISHED)。跑法:`npx tsx --env-file=.env scripts/probe-supplier-config-read.ts`。

### Step 0:解出 item_oid / supplier_oid

`GET /product/api/v1/products/34133/packages?locale=zh-tw&show_supplier=1` → **200**,回傳陣列(28 個方案)。取第一個非 bundle 方案:`pkg_oid=1936562`、`item_oid=1682339`。

**`packages?show_supplier=1` 完整欄位形狀(sanitized,供 `app_get_batch_view` 用)**:
```json
{
  "pkg_oid": "number",
  "pkg_name": "string",
  "item_oid": "number",
  "is_active": "boolean",
  "sales_deadline": "string",
  "supplier_mapping": [
    { "supplier_oid": "number", "supplier_name": "string", "is_default": "boolean" }
  ]
}
```
- 供應商資訊的鍵名是 **`supplier_mapping`**(陣列),不是 `supplier`/`suppliers`(先前設計文件的猜測欄位名有誤,已用本次 live 回應修正)。取 `is_default:true` 的元素為預設 supplier_oid(此例 `38028`)。
- **注意**:此回應**沒有** `is_bundle` 欄位(與 Phase 1a `packages.json` fixture 的舊回應形狀不同,那份含 `is_bundle`)——挑非 bundle 方案時若欄位缺席,視為非 bundle(`p.is_bundle !== true` 恆真)。若 34133 全部方案皆非 bundle,無法從本次資料確認 `is_bundle` 是否仍存在於別的商品回應,**沿用既有 fixture 的欄位名、加防禦性判斷即可,非本次阻擋項**。

### 候選端點 live 結果(全部,含 brief 外的源碼出土候選)

| # | 候選端點 | 結果 |
|---|---|---|
| 1 | `GET items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting` | **404**(`199997「查無對應的 uri」`— 路由不存在) |
| 2 | `GET items/{itemOid}/supplier-configs/{supplierOid}` | **404**(同上;另試無 supplierOid、query param、`items/{oid}/inventory-setting`、`item-configs/{oid}/inventory-setting` 四變體皆同)|
| 3 | `GET items/{itemOid}/supplier-mappings` | **200**,但元素只有 `{supplier_oid, cost_curr_code, is_default}` — **無兩布林** |
| 4 | `GET items/{itemOid}/configs`(product-service)| **403**(空 body;路由存在、verify per-URI 拒絕)— **這就是兩布林的 source of truth,見下** |
| 5 | `GET /be2/api/v1/product/item/{itemOid}/inventory`(±`supplier_oid`)與 `.../inventory/basic-info`(be2-web UI 實際打的路)| **500**(`9999「Trying to access array offset on value of type null」`)— be2-api 前綴 inventory 路由在 be2-220 **系統性 500**(Phase 1a 已記錄的同一現象,對 item 1682339/1713281 皆同,非 per-item/per-帳號)|
| 6 | `POST items/{itemOid}/inventories/search`(user-token 可用,200)| 200 但只回逐日數量 map — **無兩布林**(排除此線)|

初版 probe(commit `36a939a`)只跑了 #1–#3,當時結論 BLOCKED;本節為源碼追蹤 + 補測後的**定案**。

### 定案:兩布林的 wire 來源 = product-service `GET items/{itemOid}/basic-info` → `data.item_config.supplier_configs[]`

be2-web UI 完整鏈路已從原始碼證實(`kkday-be2-web` + `kkday-be2-api`,本機 repo):

1. 庫存頁「供應商庫存管理平台」表格(`SupplierInventoryConfigEditTable.vue`)的每列 `{isExternalInventory, isInventoryMgmt}` 來自 `EditDetail.vue` 的 `activeItemSupplierConfigMappingList` = **`itemSupplierConfig`(兩布林所在)** merge `itemSupplierMapping`(只出 `supplier_name`/`is_default`,即候選 #3 那 3 欄——所以 #3 讀不到布林是設計如此)。
2. `itemSupplierConfig` 由 store `requestGetInventoryBasicInfo` 從 be2-api `GET v1/product/item/{itemOid}/inventory/basic-info` 回應的 **`item_config.supplier_configs[]`** 取出(camelCase 轉換前的 wire 欄位即 `is_external_inventory`/`is_inventory_mgmt`,與 PUT 契約同名)。
3. S2S 原始端點: Phase 4a 發現 `GET items/{itemOid}/configs` 會對 user token 報 403。而 `GET /product/api/v1/items/{itemOid}/basic-info` 會成功回傳 200 (user token)。

**⇒ Task 3 `readSupplierInventorySetting()` 定案:`GET /product/api/v1/items/{itemOid}/basic-info`,回應取 `data.item_config.supplier_configs[]` 中 `supplier_oid` 相符的列,讀 `is_external_inventory`/`is_inventory_mgmt`。**

### Live 定案: basic-info 成功取代 configs
- **原本首選 `items/{itemOid}/configs`:403** (已成歷史)
- **取代方案 `items/{itemOid}/basic-info`:200** — 成功透過 user token 取得 `item_config`，內含 `supplier_configs` 與 `inventory_setting`。
- **Live 驗收 JSON 欄位樣貌 (Live sample shape)**:
  ```json
  {
    "supplier_oid": 38028,
    "is_inventory_mgmt": false,
    "is_external_inventory": false
  }
  ```
  且 `item_config.inventory_setting` 包含 `{control_type, inventory_type}`。
- **依 spec §4.1:read 失敗(403/500)時 diff 一律丟 `DiffError` 擋下建立,嚴禁假設預設值。**
- **權限狀態說明**：因為 `GET basic-info` 在使用 user token 時已被實證為 200 通暢，故待處理的 auth-service 權限申請目前**僅會影響逐日數量庫存（quantity PUT）端點**，對庫存管理平台切換（`inventory_platform`）已無影響（已解/歷史狀態）。
- **`modify_user` 自動解析**：寫入時的 `modify_user` 會自動由 JWT token 的 `platformId` 欄位解析出來（毋需 env flag 設定；僅在 token 缺少該 claim 時才會回報 `MODIFY_USER_UNRESOLVED`）。

### 教訓(第三次同型)

`supplier-configs` PUT 沒有鏡像 GET;真正讀取是「聚合 config 端點」(`items/{oid}/configs`)——與 Phase 3a「數量讀取是 `POST .../search` 非 GET 鏡像」同型。**任何 be2 寫入端點的現況讀取,先讀 be2-web store/api 層源碼找 UI 真實呼叫,不猜 GET 鏡像。**
