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
