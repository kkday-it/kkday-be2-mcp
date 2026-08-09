# be2-220 WRITE-contract findings (Phase 2a Task 1, controller-run 2026-08-09)

Probed live against api-gateway-220.sit.kkday.com with the `.env` account (lance.chien@kkday.com), using its OWN non-marketplace test product `546965` / plan `1967504` (created by automation). Reversible probe.

## ⚠️ CORRECTION (2026-08-09, verified by driving be2-web itself with Playwright)

The findings in §1–§5 below were **partly wrong**. Verified by clicking the real be2-web shelf toggle for product 546965 (page `https://be2-220.sit.kkday.com/v2/product/{prodOid}/sale-status/edit-detail`) and capturing the actual request:

1. **Our write endpoint + contract are CORRECT.** be2-web sends exactly `PUT {gateway}/product/api/v1/product-configs/546965/switch` with body `{"is_active":false,"modify_user":"f7965b8d-ae5f-421c-9ced-c69a7587b422"}` — the same product-service-direct endpoint our Phase 2a executor uses. Minimal body = just `{is_active, modify_user}` (no other required fields on /switch).
2. **`modify_user` = the JWT `platformId` claim** (`f7965b8d-…` = lance.chien's `platformId`), NOT a separate be2 userUuid needing an auth-service lookup. So §1 below is WRONG. The stored `24c66807-…` was just whoever last modified (lance.liu); the value you SEND is your own `platformId`. **⇒ Phase 2a's `modifyUserFromPlaceholder` (returns `platformId`) is actually CORRECT, not a placeholder — the modify_user blocker is resolved.**
3. **The 403 is genuine per-product authorization, not a mechanism/path/S2S issue.** be2-web ITSELF — real browser, real user session, correct contract — gets the SAME `403` on this write (console error + network capture confirm). Product 546965's last-modifier is `lance.liu@kkday.com`; lance.chien apparently lacks write authz on this specific product. **⇒ To get a successful live write we need a product this account can actually write** (not a code fix, not a different mechanism, not necessarily a different account — a product in this user's write scope). §4's "write-capable account" framing is imprecise: the account HAS the `product.product-sale-status.update` + `bundle-package-sale-status.update` businessList codes; it's per-oid ownership that denies 546965.

Net: executor write path/contract validated end-to-end against be2-web; `modify_user`=platformId resolved; only a write-authorized product (or that authz granted for a test product) is still needed for a green toggle. §1–§5 below are superseded where they conflict with this block.

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
