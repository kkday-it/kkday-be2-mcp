# be2 MCP — Phase 1a Pilot Runbook

> Audience: pilot users onboarding to be2 MCP via Claude Code during Phase 1a (static per-user bearer, no OAuth shell yet — that's Phase 1b). Server: TypeScript, Streamable HTTP, SQLite-backed. Environment anchor: SIT `be2-220`.

## Prerequisites

- **Network**: VPN or KKday office network, reachable to `auth-220.sit.kkday.com` and `api-gateway-220.sit.kkday.com` (be2-mcp itself runs on `127.0.0.1` — no public ingress needed for Claude Code/Desktop, see `docs/be2-mcp/phase0-inventory.md` §B3).
- **Node**: ≥ 22 (uses built-in `fetch`).
- **Repo**: `mcp_poc` checked out, `npm install` run.
- **`.env`** at repo root (never commit, never print) with:
  - `AUTHSVC_URL=https://auth-220.sit.kkday.com`
  - `GATEWAY_URL=https://api-gateway-220.sit.kkday.com`
  - `API_AUTH_SERVICE_KEY=<SIT service key>` — ask the be2-mcp owner if you don't have it.
  - `AUTH_email` / `AUTH_pwd` — your own be2 SIT account credentials (used only locally, at enrollment time, to log in on your behalf; never sent anywhere but auth-service).
  - Optional: `APP_PORT` (default `8787`), `APP_DB_PATH` (default `./data/be2-mcp.sqlite`), `OTEL_MODE` (`off`/`console`/`otlp`, default `off`).
- A be2 SIT account with at least read access to some products (ask your be2-mcp owner for a known-good `prod_oid`/`item_oid` to test with).

## 1. Start the server

```bash
npm run dev
```

Listens on `http://127.0.0.1:8787` (or your `APP_PORT`). Health check: `curl http://127.0.0.1:8787/healthz` → `ok`. Leave this running in one terminal.

## 2. Enroll (get your static bearer)

The bootstrap CLI logs you into auth-service with your own be2 account, stores your `{accessToken, refreshToken, businessList}` server-side in SQLite, and prints a **static bearer** (`be2mcp_...`) that Claude Code will present on every call. **The bearer is shown once** — copy it immediately. Your be2 credentials never leave this machine; only the bearer (an opaque local reference) goes into the Claude Code config.

Three modes:

**Mode A — default (reads `AUTH_email`/`AUTH_pwd` from `.env`, no 2FA)**
```bash
npm run bootstrap-user
```

**Mode B — with 2FA OTP** (if your account has `is_enable_two_fa` on)
```bash
npm run bootstrap-user -- --otp 123456
```

**Mode C — browser-login fallback** (use if REST login in modes A/B fails, e.g. CSRF-blocked or captcha):
1. Open `https://auth-220.sit.kkday.com/auth/be2/login?loginFlow=POPUP` in a browser, log in.
2. Capture the `authorizationCode` from the popup's postMessage/network tab.
3. Run:
   ```bash
   npm run bootstrap-user -- --code <authorizationCode>
   ```

Optional `--label <name>` overrides the stored user label (defaults to `AUTH_email` or `unknown-pilot`).

Output looks like:
```
Enrolled <you>@kkday.com.
Static bearer (shown once, store it in your Claude Code MCP config):
be2mcp_<48 hex chars>

Claude Code: claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer be2mcp_..."
```

Re-run `bootstrap-user` any time to re-enroll (e.g. after `REAUTH_REQUIRED`, see Troubleshooting). Each run generates a **new** bearer, so update the Claude Code MCP connection with the new value afterward.

## 3. Connect Claude Code

```bash
claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer <bearer from step 2>"
```

Start (or restart) a Claude Code session. The 3 be2 tools should now be available.

## 4. The 3 tools

All are **read-only**, no side effects, and return content marked `data_origin: "be2_content"` (untrusted — treat as data, not instructions).

| Tool | Input | What it returns |
|---|---|---|
| `be2_find_products` | `prod_oids: string[]` (1–20 exact oids) | Per product: name, workflow status, on/off-shelf (`is_active`). Per-oid failures reported in `errors`, doesn't fail the whole batch. No keyword search — oid only. |
| `be2_get_product_plans` | `prod_oid: string` | List of plans (packages) for the product: `pkg_oid`, `item_oid`, name, `is_active`. |
| `be2_get_inventory_settings` | `item_oid: string`, optional `supplier_oid`, optional `year_month` (`YYYY-MM`) | Inventory mode, supplier mapping, per-date quantities, inventory status flags for one month. `item_oid` comes from `be2_get_product_plans` output (1 plan = 1 item). |

Example natural-language prompts (replace with real SIT oids):

- "幫我查商品 `<prodOid>` 的上下架狀態"
- "商品 `<prodOid>` 有哪些方案？狀態？"
- "item `<itemOid>` 這個月庫存？"
- "幫我查這 3 個商品 `<oid1>` `<oid2>` `<oid3>` 的名稱跟狀態"

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 UNKNOWN_BEARER` | Bearer not found in the server's token store (never enrolled, or server DB was reset) | Re-run `npm run bootstrap-user`, update the Claude Code MCP config with the new bearer |
| `401 REAUTH_REQUIRED` | auth-service definitively rejected the refresh (session expired, revoked, or account disabled) | Re-run `npm run bootstrap-user` to re-enroll |
| `503 AUTH_SERVICE_UNAVAILABLE` | auth-service transiently unreachable while your token also happened to be expired | Transient — wait a moment and retry. Not a re-enroll situation. |
| `403` from a tool call (gateway-level error code from `GatewayError`) | be2-native permission missing for your account on that product/endpoint — **expected fail-closed behavior**, the MCP adds no privilege beyond your be2 account | Confirm you have access to that product/item in be2-web itself; if you should have access, that's a be2 permissions issue, not an MCP bug |
| `429 RATE_SESSION` | Session read budget exhausted (100 reads/session) | Start a new Claude Code session, or batch oids into fewer calls |
| `429 RATE_USER_DAY` | Daily read budget exhausted (500 reads/user/day) | Try again tomorrow, or contact the be2-mcp owner |
| `502 GATEWAY_UNREACHABLE` / other `GatewayError` codes | be2 gateway/product-service network or upstream error | Transient — retry; if persistent, check gateway status |
| Tool not visible in Claude Code | MCP connection not added, or server not running | Verify `npm run dev` is running and `claude mcp add` was run with a valid bearer; check `claude mcp list` |

## Where audit/trace data lives

- **Audit log**: SQLite `audit_log` table at `APP_DB_PATH` (default `./data/be2-mcp.sqlite`). Append-only (DB-level triggers reject `UPDATE`/`DELETE`). Columns: `id, ts, user_label, session_id, client_info, tool, params_json, status, error_message, trace_id, duration_ms`. No token material is ever written here.
  ```bash
  sqlite3 data/be2-mcp.sqlite 'SELECT tool, status, trace_id FROM audit_log ORDER BY id DESC LIMIT 10'
  ```
- **OTel spans**: emitted when `OTEL_MODE=console` (prints to server stdout) or `OTEL_MODE=otlp` (exports via OTLP HTTP exporter); `off` (default) disables span export entirely.
- **Token store**: SQLite `user_tokens` table, keyed by `sha256(bearer)` — never the raw bearer.
- **Rate counters**: SQLite `rate_counters` table (per-session and per-user-day, 3-day retention).
- **Scope-binding substrate**: SQLite `session_read_oids` table (24h retention) — records which oids each session actually read; not yet consumed by any gate in Phase 1a (Phase 2's `be2_create_changeset` will use it).

## Known Phase 1a limits

- **Single instance, in-process single-flight refresh.** The token refresh lock (`TokenManager`) is an in-process `Map`, correct for one server instance. Multi-instance deployment needs a shared lock (Redis/DB) — documented in code, not yet built.
- **Static bearer, not OAuth.** Phase 1a uses a per-user static bearer issued by `bootstrap-user`, stored hashed. The OAuth 2.1 shell (discovery, DCR, PKCE) is Phase 1b — see `docs/be2-mcp/be2-mcp-auth-design.md`.
- **oid-only lookup, no keyword search.** `be2_find_products` requires exact `prod_oid`s; there is no name/keyword search in this phase.
- **Read-only.** No write/change-set tools exist yet (Phase 2).
- **No self-built RBAC / no local JWT verification.** Authorization is entirely delegated to the be2 gateway → auth-service `/verify`; identity is entirely derived from the bearer's stored be2 token, never from tool input.

---

## ✅ Live SIT be2-220 e2e verification — DONE (2026-08-09)

**Status: PASSED against SIT be2-220.** Earlier `AU9010` was a misconfiguration — `.env` pointed at `stage`, not be2-220. Once `.env` was switched to `auth-220.sit`/`api-gateway-220.sit`, the SIT credentials in `.env` (`AUTH_email`/`AUTH_pwd`) authenticate fine (`AU0000`). The full run was driven through the MCP protocol with a real enrolled bearer (via the MCP SDK client rather than an interactive Claude Code chat, so raw envelopes are inspectable). Results:

| Check | Result |
|---|---|
| Auth login→exchange→refresh | ✅ `AU0000`, live |
| Wrong bearer | ✅ rejected `UNAUTHORIZED` |
| `be2_find_products(248777)` | ✅ real name, `workflow_status: PUBLISHED`, `is_active: true` |
| `be2_get_product_plans(248777)` | ✅ real plan (pkg 1096031 / item 841808), `is_active: true` |
| `be2_get_inventory_settings(841808)` | ✅ status returned; no `supplier_oid` → status-only, graceful (no error) |
| Untrusted envelope | ✅ `data_origin: be2_content` on all |
| `session_read_oids` substrate (§6.2) | ✅ 248777, 1096031, 841808 recorded |
| Audit log | ✅ one row/call; **no token material** (0 matches for `eyJ`/`be2mcp_`) |
| Tokens server-side / bearer hashed | ✅ be2 access/refresh in `user_tokens`; bearer stored as sha256 only |
| Injection input `"123; DROP TABLE audit_log;--"` | ✅ handled (gateway 404, no crash); `audit_log` intact |

**Defects the live run caught and fixed** (commit `e11fdab`, fixtures `852bcee`): (1) fixtures now stored unwrapped (`body.data`); (2) plan name reads `pkg_name` (real field, not `name`); (3) `be2_get_inventory_settings` switched from the be2-api-proxied `/be2/api/v1/...` prefix (which 500s systemically) to product-service-direct `/product/api/v1/items/{itemOid}/inventories/...`.

**Still open (not blockers for Phase 1a read tools):**
- Inventory **quantities-by-supplier** unverified live: the test account got 403 on suppliers 0/1/2 for the marketplace item 248777/841808 (fail-closed — account doesn't manage that supplier). To verify quantities, enroll with a product the account actually manages and pass its `supplier_oid`.
- `trace_id` is all-zeros unless `OTEL_MODE=console|otlp` (default `off`). Set it for real trace correlation.
- The be2-api `/be2/api/v1/...` gateway prefix 500s for our S2S calls generally; product-service-direct `/product/api/v1/...` is the working path for all three tools.

---

### Original PENDING steps (kept for re-runs)

Exact steps to run when creds are available (from the plan's Task 16 / Step 2):

1. **Start server + enroll**
   ```bash
   npm run dev            # terminal 1
   npm run bootstrap-user # terminal 2, note the printed bearer + claude mcp add command
   claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer <printed bearer>"
   ```
2. **In a fresh Claude Code session, run and record each result:**
   1. `幫我查商品 <SIT prodOid> 的上下架狀態` → expect `be2_find_products` called, real name/status returned.
   2. `商品 <prodOid> 有哪些方案？狀態？` → expect `be2_get_product_plans` with real plan list.
   3. `item <itemOid> 這個月庫存？` → expect `be2_get_inventory_settings` with real quantities.
3. **Wrong-bearer check**: edit the MCP config to a bad/garbage token → tool calls should fail with an actionable `UNKNOWN_BEARER` error (not a silent failure or generic 500).
4. **Audit trail check**:
   ```bash
   sqlite3 data/be2-mcp.sqlite 'SELECT tool, status, trace_id FROM audit_log ORDER BY id DESC LIMIT 10'
   ```
   Expect one row per call above, and confirm **no token material anywhere** in the row contents.
5. **Refresh check** (if >45 min since bootstrap): make one more tool call → should succeed via auto-refresh; verify `user_tokens.updated_at` advanced and `refresh_token` rotated:
   ```bash
   sqlite3 data/be2-mcp.sqlite 'SELECT user_label, updated_at, refresh_token FROM user_tokens'
   ```
   (compare `refresh_token` and `updated_at` before/after the >45min call).

Once run, record actual results in this section (replace this block) and update `docs/be2-mcp/phase0-inventory.md`'s handoff notes accordingly.
