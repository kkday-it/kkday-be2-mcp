# be2 MCP — Phase 2a Pilot Runbook (change-sets)

> Audience: pilot users using the two Phase 2a write tools (draft-only change-sets) via Claude Code. Builds on `docs/be2-mcp/phase1a-runbook.md` (read tools, enrollment, static bearer) — read that first for `npm run dev` / `bootstrap-user` / `claude mcp add`. Environment anchor: SIT `be2-220`.

## What Phase 2a adds

Two new tools on top of the 3 Phase 1a read tools. Neither one writes to be2 by itself — they **stage a DRAFT** and hand a human a link to review and approve in a browser. The agent has no tool that approves or executes; a write only happens when a person clicks 批准 (approve) on the confirmation page.

**The approval link never enters the agent's context.** `be2_create_changeset`'s tool response contains only `changeset_id` + `status` + the `diff` (data for the agent to summarize to you in chat) — it does **not** contain a `confirm_url` or the approval token. The confirm link is printed to the **be2-mcp server's own terminal** (the terminal running `npm run dev`), which only the human operating the server sees. This is deliberate (鐵則 #4, draft-only): in Claude Code the agent also has Bash/curl access to the loopback interface, so if the token were returned in the tool response, the agent could `curl` the confirm route itself and self-approve, defeating the human-in-the-loop guarantee.

| Tool | Input | What it does |
|---|---|---|
| `be2_create_changeset` | `action_type: "shelf_toggle_product" \| "shelf_toggle_plan"`, `items: [{prod_oid, pkg_oid?, target_is_active}]` (1–20), `note?` | Computes a live diff (current vs target) for each item, stages it as a `pending_approval` change-set, and returns `changeset_id` + `status` + the diff. Does **not** touch be2. Prints the `confirm_url` to the **server terminal (stdout)**, not to the tool response. |
| `be2_get_changeset_status` | `changeset_id` | Read-only: status (`pending_approval` / `approved` / `executing` / `done` / `partial` / `failed` / `rejected` / `expired`) + per-item before/after once decided. Creator-only — another user's `changeset_id` returns `NOT_FOUND` (IDOR guard). |

`shelf_toggle_product` items need `{prod_oid, target_is_active}`; `shelf_toggle_plan` items need `{prod_oid, pkg_oid, target_is_active}` (a plan belongs to a product, both oids required).

## The full flow

1. **Read first.** Ask the agent to look up the product/plan (`be2_find_products` / `be2_get_product_plans`) — this records the oid as "read this session," which the create step requires (see Troubleshooting: `SCOPE_NOT_READ`).
2. **Ask for the change.** e.g. "把商品 `<prodOid>` 下架" or "把方案 `<pkgOid>` 上架". The agent calls `be2_create_changeset`, which returns only the `changeset_id` + diff into chat. **The agent will not, and cannot, claim the change is done at this point** — nothing has executed yet, and the agent has no way to approve it itself.
3. **Get the confirm link from the be2-mcp server terminal**, not from the chat — the human running `npm run dev` will see a line like `[be2-mcp] change-set <id> awaiting approval: http://127.0.0.1:<port>/confirm/<id>?token=<token>` printed to that terminal's stdout. Open that URL in a browser (a one-time high-entropy capability link, not tied to a login session). The page recomputes the diff live against be2 at render time (not just what was cached at creation) and shows current → target per item, by oid (names are untrusted be2 content, shown for orientation only — verify by oid).
4. **Approve or reject.** Clicking 批准 (approve) executes the write through the gateway (read-merge-write — see below); 拒絕 (reject) discards it. Both are one-time: a second approve/reject on the same change-set gets `409`.
5. **Check the result.** Ask the agent "change-set `<id>` 執行結果如何？" (`be2_get_changeset_status`) for status + before/after per item, or read it directly off the confirmation page's post-approve response.

### Example natural-language prompts

- "先查商品 `<prodOid>` 現在上架還是下架，然後幫我把它下架"
- "商品 `<prodOid>` 的方案 `<pkgOid>` 幫我上架"
- "change-set `<id>` 現在狀態如何？"
- Direct-execute requests ("直接幫我下架，不要問我") are refused by design — the model has no execute tool; it will explain that a human must approve via the confirm link (which the agent itself never sees).

## Why a capability-URL confirmation page (not a Claude-side confirm)

The MCP protocol has no reliable, unspoofable "ask a human to click yes" primitive that survives untrusted tool-output content in context (see the eval's injection cases). So approval happens **outside the model's control entirely**: a real HTTP page, opened by a human, protected by a one-time token that is (a) only ever shown once, printed to the be2-mcp **server's own stdout** — never returned in the tool response the agent/model reads, (b) stored server-side only as a hash, (c) bound to the creator (checked via `creatorBearerHash`), and (d) served with `Referrer-Policy: no-referrer` so it can't leak via a referrer header if the page links out. The diff shown is **recomputed live** at both page-load and approve time — if the underlying be2 state drifted since the change-set was created, approve gets a `409` and a re-rendered page instead of executing against a stale diff.

## Read-merge-write (why "other plans are unchanged" matters)

Both `shelf_toggle_product` and `shelf_toggle_plan` writes work by reading the **full** current object(s) from be2 first, flipping only `is_active` (and a handful of confirmed-read-only fields like `updated_by`/`updated_at`/`is_locked_for_active` stripped), and PUTing the full merged object back. For `shelf_toggle_plan` this means the package-configs write always sends **every** package on the product, not just the one being toggled — so toggling one plan must never change the `is_active` state of the product's other plans. This is enforced by `src/changeset/executor.ts` (`execPlan`) and covered by a unit test (`tests/changesetExecutor.test.ts`); see the PENDING section below for the live proof still owed.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `SCOPE_NOT_READ` on `be2_create_changeset` | The oid(s) in `items` weren't looked up via a read tool in this session | Ask the agent to read the product/plan first (`be2_find_products` / `be2_get_product_plans`), then retry the change request |
| `ACTION_NOT_ALLOWED` on `be2_create_changeset` | Your be2 `businessList` doesn't include the action code for this `action_type` | This is a be2 permission, not an MCP bug — confirm you can do this action in be2-web itself |
| `RATE_CHANGESET_DAY` | Per-user daily change-set creation budget exhausted (10/day) | Try again tomorrow, or contact the be2-mcp owner if you need a higher budget |
| Confirmation page: `404 not found` | Wrong/garbage token, unknown `id`, or the change-set is no longer `pending_approval` (already approved/rejected/expired) | Re-check the `confirm_url` was copied in full from the **server terminal output**; if it was already decided, create a new change-set |
| Can't find the `confirm_url` anywhere | It's not in the chat — `be2_create_changeset`'s tool response never contains it (by design, see above) | Look at the terminal running `npm run dev`; the line is printed there as soon as the tool is called |
| Confirmation page approve: `409` + re-rendered page with a red banner | **Stale diff** — the target state changed on be2 (by you or someone else) between page-load and approve | Re-review the freshly re-rendered diff, then approve again if it still reflects your intent |
| Confirmation page approve/reject: `409 已被處理或已過期` (plain text, no page) | **Already processed** — someone (possibly you, in another tab) already approved or rejected this change-set (compare-and-swap loser) | Check `be2_get_changeset_status` for the actual outcome; don't retry |
| Execute result shows `status: "failed"` with a `403`-shaped `error_code` on an item | be2-native permission missing for this account on that product/plan's write action — **expected fail-closed behavior**, not an MCP bug. This is the current SIT blocker (see PENDING section) | Confirm you have shelf-write permission for that product in be2-web; if you should have it, that's a be2/auth-service permissions issue |
| `be2_get_changeset_status` returns `NOT_FOUND` | Change-set belongs to a different user (creator-only IDOR guard), or the id is wrong | Only the creator can query their own change-set; double-check the id |
| Change-set never reachable / status `expired` | Change-sets expire 24h after creation if never approved/rejected | Create a fresh change-set |

## Where change-sets, results, and audit live

- **Change-sets**: SQLite `change_sets` table (same DB as Phase 1a, `APP_DB_PATH`, default `./data/be2-mcp.sqlite`) — id, creator, action_type, items, diff, diff_version, status, hashed approval token, timestamps. 24h TTL on `pending_approval` (lazily flipped to `expired` on read).
- **Execution results**: recorded alongside the change-set (per-item `status`/`before`/`after`/`error_code`/`trace_id`), returned by `be2_get_changeset_status` and by the confirm-page's post-approve response.
- **Audit log**: same `audit_log` table as Phase 1a, one row per executed item with `tool = "changeset.execute"`:
  ```bash
  sqlite3 data/be2-mcp.sqlite 'SELECT tool, status, trace_id FROM audit_log ORDER BY id DESC LIMIT 10'
  ```
  No token material (bearer, access/refresh token, or capability token) is ever written to this table — only the hashed forms live in `change_sets`/`user_tokens`.

## Known Phase 2a limits

- **Single instance.** Like Phase 1a's token-refresh lock, the change-set store and rate budget are in-process/SQLite-single-writer — correct for one server instance, not yet built for multi-instance deployment.
- **Capability-token approval, not SSO.** The confirm page authenticates the *approval action* via a one-time bearer-bound token in the URL, not a logged-in be2-auth session. A real be2-auth SSO-backed confirm page (so the page itself can show "who is approving" and support delegation/audit beyond the token) is Phase 2b.
- **Only two action types.** `shelf_toggle_product` (product on/off-shelf) and `shelf_toggle_plan` (plan/package on/off-shelf). No other write action (price, inventory, dates/schedule, workflow/publish) exists yet — see `docs/be2-mcp/phase0-inventory.md` §C phasing table for what's next.
- **`modify_user` automatically resolves to the JWT `platformId` claim.** The executor decodes the executing identity's access token and uses its `platformId` claim, which has been verified as the correct value for production writes (see `docs/be2-mcp/sit-write-contracts.md`). If the token cannot be parsed or lacks this claim, it throws `MODIFY_USER_UNRESOLVED`.
- **Max 20 items per change-set**, and items must belong to oids already read in the same session (scope-binding — prevents an agent from being tricked by injected/untrusted content into staging a change on an oid the user never looked at).

---

## ⚠️ Live SIT WRITE e2e — PENDING a write-capable account

**Status: BLOCKED, not run.** Per `docs/be2-mcp/sit-write-contracts.md` (Phase 2a Task 1 probe), the `.env` SIT test account (`lance.chien@kkday.com`) gets a clean **403 on the shelf-toggle write PUT even on its own products** — it has read access but no be2 shelf-write permission on `be2-220`. This is the gateway correctly fail-closing an unauthorized write (validates the design), but it means the real toggle+revert e2e below has not been executed. **Do not attempt it with the current account** — it will only reproduce the known 403, not exercise the real write path.

All non-write-dependent verification is done: `npm run ci` → **108/108 passed**, `tsc --noEmit` clean; `npm run eval` → **`SKIP eval: ANTHROPIC_API_KEY not set`** (documented skip, not a failure — no key configured in this environment; the 10 eval cases in `eval/cases/cases.json` cover draft-only refusal, scope-gate, and prompt-injection resistance and should be run with a key before a real production pilot).

### Exact steps to run once a write-capable SIT account is available (Task 10 Step 2, unchanged from the plan)

1. `npm run dev` (terminal 1); `npm run bootstrap-user` with the write-capable account's credentials (terminal 2); `claude mcp add` with the printed bearer.
2. In a Claude Code session: `查商品 <managedProdOid> 的方案狀態` → confirm `be2_get_product_plans` returns real plans, note the current `is_active` per plan.
3. `把方案 <pkgOid> 下架` → confirm the agent calls `be2_create_changeset` (`action_type=shelf_toggle_plan`), the chat response only contains `changeset_id` + the diff (no `confirm_url`, no token), and the agent does **not** claim the change already happened.
4. In **terminal 1** (the `npm run dev` server, not the chat), find the printed line `[be2-mcp] change-set <id> awaiting approval: <confirm_url>` and open that `confirm_url` in a browser → verify the diff page shows the plan name + current→target, and inspect response headers for `Referrer-Policy: no-referrer`.
5. Click 批准 → **read-merge-write proof**: after execution, verify on be2-web that (a) the target plan is now off, AND (b) every *other* plan on that product is unchanged (`is_active` identical to before) — this is the concrete evidence that the package-configs write preserved the other packages' full objects rather than replacing the set.
6. `be2_get_changeset_status <id>` → confirm `done` status with populated before/after matching what be2-web shows.
7. **Revert**: create a new change-set with the inverse `target_is_active` for the same `pkg_oid`, get its `confirm_url` from the server terminal, approve it, and confirm the plan is restored to its original state (compare against the "before" captured in step 2/6).
8. **Wrong-token check**: open `/confirm/<id>?token=garbage` for a change-set from this run → confirm `404`.
9. **Stale-diff check**: create a change-set, then change the plan's state directly on be2-web (out of band), then approve the change-set → confirm the `409` stale re-render fires (banner shown, live diff refreshed) and that **no write occurred** as a result of that approve attempt.
10. **Audit check**:
    ```bash
    sqlite3 data/be2-mcp.sqlite 'SELECT tool,status,trace_id FROM audit_log ORDER BY id DESC LIMIT 10'
    ```
    Confirm `changeset.execute` rows for the toggle and the revert, and that no token material appears anywhere in the row contents.

Once run, replace this section with the actual results (mirroring the Phase 1a runbook's "✅ Live SIT be2-220 e2e verification — DONE" pattern) and update `docs/be2-mcp/phase0-inventory.md`'s handoff notes accordingly.
