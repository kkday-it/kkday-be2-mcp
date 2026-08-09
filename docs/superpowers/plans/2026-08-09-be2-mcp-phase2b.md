# be2 MCP Phase 2b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 2a's capability-URL approval on the be2-mcp confirmation page with a be2-auth SSO web session (cookie), so approval requires a human be2-auth login the agent cannot obtain — closing the Phase 2a self-approval hole — with execution and live-diff reads performed as the *approver's* session identity and audited to the web session.

**Architecture:** Builds on Phase 2a (branch `feat/phase1a`). Adds a `web_sessions` table + `WebSessionStore` (idle TTL), an SSO login flow (`/confirm/login` POPUP launcher + `/confirm/session` code-exchange endpoint that mints a `be2mcp_sid` HttpOnly cookie), and rewires `/confirm/:id` / approve / reject from `?token=` capability auth to cookie-based session auth. The web session's be2 tokens are stored in the existing `user_tokens` store keyed by `sha256(session_id)`, so the existing `TokenManager.getFreshByHash` gives L2 refresh/single-flight for free. `executeChangeSet` and `liveDiff` are changed to run as the injected approver identity (session token + userLabel + modifyUser) instead of the change-set creator's stored bearer. The change-set store, state machine, CAS approve, stale guard, executor algorithm, and read-merge-write are unchanged.

**Tech Stack:** Same as Phase 1a/2a — Node 22 / TypeScript strict, `@modelcontextprotocol/sdk`, express 5, better-sqlite3, zod, `@opentelemetry/*`, vitest, tsx. No new runtime dependencies (cookies parsed with a tiny local helper — no `cookie-parser`).

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-09-be2-mcp-phase2b-design.md` and the parent spec. Every task's requirements implicitly include these.

- **Approval requires a be2-auth SSO web session; the agent must not be able to approve** (spec §0 core value). The only approve/execute path is the cookie-authenticated confirm route; no MCP tool can approve or execute (draft-only, 鐵則 #4).
- **Loopback-local**: the confirm app is served by the same be2-mcp process on `127.0.0.1:{config.port}`; no public/internal ingress. (spec §0)
- **be2-auth login = POPUP flow** (A8-proven): `window.open({authsvcUrl}/auth/be2/login?loginFlow=POPUP&redirectPath=…)` → `postMessage` with the authorizationCode → front-end POSTs it to `/confirm/session`; server exchanges it with the service key (headless S2S, cookie-free). (spec §3)
- **postMessage origin check is mandatory**: the opener accepts a message only when `event.origin` equals the be2-auth host (`new URL(config.authsvcUrl).origin`). (spec §3)
- **IDOR / approver alignment**: `/confirm/:id`, approve, reject serve a change-set only when the session's `user_label` equals the change-set `creator_label`; otherwise a generic 404 (no existence leak). (spec §4)
- **Execution + live-diff run as the approver session identity, not `creatorBearerHash`**: `executeChangeSet` takes an injected `{accessToken, userLabel, modifyUser}`; `liveDiff` uses the session's token. (spec §4)
- **Audit attributes to the web session**: approve / reject / execute audit rows record the *web* `session_id` + the logged-in `user_label` (+ IP/UA), distinct from `rec.sessionId` (the agent tool-call session that created it). (spec §4)
- **Same token store, same refresh**: the web session's be2 tokens live in the existing `user_tokens` store; refresh via `TokenManager` (L2, single-flight). (spec §2/§5)
- **Cookie**: `be2mcp_sid`, `HttpOnly; SameSite=Lax; Path=/confirm` (no `Secure` on loopback http; documented for production). (spec §5)
- **Web session idle TTL** default 8h; be2-auth cookie validity makes re-login silent. (spec §5)
- **NOT in scope (parallel, do not implement)**: resolving `modify_user`'s real userUuid, and the 403 shelf-write permission — the placeholder `modifyUserFrom` stays; live write still 403s (fail-closed). (spec §0/§7)
- **No new dependency, no public exposure, server-rendered pages** (no external assets), reuse Phase 2a `esc()` + `Referrer-Policy: no-referrer`. (spec §6)
- TypeScript `strict`, vitest, TDD, commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` on its own line.

## Pre-locked facts (verified this session)

- `AuthServiceClient.exchangeCode(code): Promise<{accessToken, refreshToken, businessList}>` exists (src/auth/authServiceClient.ts).
- JWT `authKey` claim = the user's email = the `user_label` used as `creator_label` (Task 1 SIT probe: `authKey: lance.chien@kkday.com`; Phase 1a enroll sets `userLabel` from the email). So the SSO session's `user_label` (from the token's `authKey`) will match `creator_label` for IDOR.
- `TokenStore.hashBearer(x)` = sha256 hex; `TokenStore.upsert(TokenRecord)`; `TokenManager.getFreshByHash(bearerHash)` → `{accessToken, userLabel, businessList}` (Phase 2a Task 3). Storing web-session be2 tokens under `hashBearer(session_id)` makes refresh reuse work with no new refresh code.
- `executeChangeSet(deps, changesetId)` currently resolves the token internally via `getFreshByHash(rec.creatorBearerHash)` + `deps.modifyUserFrom` (src/changeset/executor.ts) — Task 3 changes this.
- Phase 2a confirm routes authenticate with `?token=` (capability) via `load(id, token)` + `hashesEqual` (src/server/confirmRoutes.ts) — Task 5 removes this.
- Express 5; no cookie parser dependency — Task 4 adds a tiny header parser.

## File Structure

```
src/server/
  webSessionStore.ts   NEW: WebSessionStore (web_sessions table CRUD + idle TTL)
  cookies.ts           NEW: parseCookies(header) + serializeSetCookie(name,val,opts) — tiny, no dep
  ssoRoutes.ts         NEW: /confirm/login (POPUP launcher) + /confirm/session (exchange→cookie) + /confirm/logout
  confirmRoutes.ts     MODIFY: capability-token auth → session-cookie auth; IDOR; session-token liveDiff+execute; audit to web session
Modify:
  src/store/db.ts          + web_sessions table (idempotent migration)
  src/auth/jwt.ts          + decodeJwtClaims / authKey extraction
  src/changeset/executor.ts + executeChangeSet takes injected executor identity (drops internal token resolution)
  src/server/app.ts        grow ConfirmDeps (authServiceClient, tokenStore, webSessions, authOrigin); mount ssoRoutes; /confirm/logout
tests/                     mirror each
docs/be2-mcp/
  phase2b-runbook.md   NEW: SSO login + approval flow, PENDING-write section
```

---

### Task 1: web_sessions migration + WebSessionStore

**Files:**
- Create: `src/server/webSessionStore.ts`
- Modify: `src/store/db.ts` (append one table)
- Test: `tests/webSessionStore.test.ts`

**Interfaces:**
- Consumes: `openDb` (src/store/db.ts).
- Produces:
  ```ts
  export interface WebSession { sessionId: string; userLabel: string; createdAt: number; lastSeenAt: number }
  export class WebSessionStore {
    constructor(db: Database.Database, opts?: { now?: () => number; idleTtlMs?: number })  // idleTtlMs default 8h
    static newSessionId(): string                       // 32 random bytes hex (crypto.randomBytes)
    create(sessionId: string, userLabel: string): void
    get(sessionId: string): WebSession | undefined      // returns undefined + deletes row if idle past ttl
    touch(sessionId: string): void                      // set last_seen_at = now
    delete(sessionId: string): void
  }
  ```

- [ ] **Step 1: Write the failing test**

`tests/webSessionStore.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'

describe('WebSessionStore', () => {
  it('creates and reads a session', () => {
    const s = new WebSessionStore(openDb(':memory:'), { now: () => 1000 })
    s.create('sid1', 'user@kkday.com')
    expect(s.get('sid1')).toMatchObject({ sessionId: 'sid1', userLabel: 'user@kkday.com', createdAt: 1000, lastSeenAt: 1000 })
    expect(s.get('nope')).toBeUndefined()
  })
  it('newSessionId is 64 hex chars and unique', () => {
    const a = WebSessionStore.newSessionId()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(WebSessionStore.newSessionId()).not.toBe(a)
  })
  it('expires a session idle past ttl and deletes it', () => {
    let t = 1000
    const s = new WebSessionStore(openDb(':memory:'), { now: () => t, idleTtlMs: 100 })
    s.create('sid1', 'u')
    t = 1000 + 200
    expect(s.get('sid1')).toBeUndefined()
    // second get also undefined (row was deleted, not just filtered)
    t = 1000 + 300
    expect(s.get('sid1')).toBeUndefined()
  })
  it('touch extends idle expiry', () => {
    let t = 1000
    const s = new WebSessionStore(openDb(':memory:'), { now: () => t, idleTtlMs: 100 })
    s.create('sid1', 'u')
    t = 1050; s.touch('sid1')
    t = 1120                                   // 120 since create, but only 70 since touch
    expect(s.get('sid1')).toMatchObject({ userLabel: 'u', lastSeenAt: 1050 })
  })
  it('delete removes the session', () => {
    const s = new WebSessionStore(openDb(':memory:'), { now: () => 1000 })
    s.create('sid1', 'u'); s.delete('sid1')
    expect(s.get('sid1')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/webSessionStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the migration**

In `src/store/db.ts`, append to the `MIGRATIONS` string (before the closing backtick):
```sql
CREATE TABLE IF NOT EXISTS web_sessions (
  session_id   TEXT PRIMARY KEY,
  user_label   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
```

- [ ] **Step 4: Implement**

`src/server/webSessionStore.ts`:
```ts
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'

export interface WebSession { sessionId: string; userLabel: string; createdAt: number; lastSeenAt: number }

export class WebSessionStore {
  private now: () => number
  private idleTtlMs: number
  constructor(private db: Database.Database, opts: { now?: () => number; idleTtlMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.idleTtlMs = opts.idleTtlMs ?? 8 * 3600_000
  }
  static newSessionId(): string { return randomBytes(32).toString('hex') }

  create(sessionId: string, userLabel: string): void {
    const t = this.now()
    this.db.prepare('INSERT OR REPLACE INTO web_sessions (session_id, user_label, created_at, last_seen_at) VALUES (?,?,?,?)')
      .run(sessionId, userLabel, t, t)
  }
  get(sessionId: string): WebSession | undefined {
    const r = this.db.prepare('SELECT * FROM web_sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined
    if (!r) return undefined
    if ((r.last_seen_at as number) + this.idleTtlMs < this.now()) { this.delete(sessionId); return undefined }
    return { sessionId: r.session_id as string, userLabel: r.user_label as string, createdAt: r.created_at as number, lastSeenAt: r.last_seen_at as number }
  }
  touch(sessionId: string): void {
    this.db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE session_id = ?').run(this.now(), sessionId)
  }
  delete(sessionId: string): void {
    this.db.prepare('DELETE FROM web_sessions WHERE session_id = ?').run(sessionId)
  }
}
```

- [ ] **Step 5: Run tests + commit**

Run: `npx vitest run tests/webSessionStore.test.ts && npx tsc --noEmit` → PASS.
```bash
git add src/server/webSessionStore.ts src/store/db.ts tests/webSessionStore.test.ts
git commit -m "feat(phase2b): web_sessions table + WebSessionStore with idle TTL"
```

---

### Task 2: JWT claims decode (extract session user_label from token)

**Files:**
- Modify: `src/auth/jwt.ts`
- Test: `tests/jwtClaims.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `decodeJwtClaims(jwt: string): Record<string, unknown>` — payload base64url decode ONLY (never verifies; same rule as `decodeJwtExpMs`). Used to read `authKey` (email = user_label) after an SSO exchange.

- [ ] **Step 1: Write the failing test**

`tests/jwtClaims.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { decodeJwtClaims } from '../src/auth/jwt.js'

function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

describe('decodeJwtClaims', () => {
  it('returns the payload claims (incl. authKey email)', () => {
    const c = decodeJwtClaims(fakeJwt({ authKey: 'user@kkday.com', subAuthOid: 42, exp: 123 }))
    expect(c.authKey).toBe('user@kkday.com')
    expect(c.subAuthOid).toBe(42)
  })
  it('throws on a non-JWT', () => {
    expect(() => decodeJwtClaims('nope')).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/jwtClaims.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `src/auth/jwt.ts`, add (keep the existing `decodeJwtExpMs`):
```ts
// Payload decode ONLY — never signature verification (verification is delegated to auth-service).
export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('not a JWT')
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
}
```
(If `decodeJwtExpMs` already parses the payload, you may refactor it to call `decodeJwtClaims` and read `.exp` — keep its behavior identical and its tests green.)

- [ ] **Step 4: Run tests + commit**

Run: `npx vitest run tests/jwtClaims.test.ts tests/jwt.test.ts && npx tsc --noEmit` → PASS.
```bash
git add src/auth/jwt.ts tests/jwtClaims.test.ts
git commit -m "feat(phase2b): decodeJwtClaims (read authKey email for SSO session label)"
```

---

### Task 3: executeChangeSet — inject the approver identity (drop internal token resolution)

Changes the executor to run as an injected identity instead of resolving the creator's stored token. Keeps the Phase 2a caller working (still resolves via `creatorBearerHash` for now) so all existing tests stay green; Task 5 switches the source to the session.

**Files:**
- Modify: `src/changeset/executor.ts`
- Modify: `src/server/confirmRoutes.ts` (caller: resolve identity, pass it in — interim, still capability-token auth)
- Test: `tests/changesetExecutor.test.ts` (update to the new signature)

**Interfaces:**
- Consumes: `ChangeSetStore`, `GatewayClient`, `AuditLog` (unchanged); NO longer `TokenManager`/`modifyUserFrom` inside the executor.
- Produces:
  ```ts
  export interface ExecutorDeps { changeSets: ChangeSetStore; gateway: GatewayClient; audit: AuditLog; now: () => number }
  export interface ExecutorIdentity { accessToken: string; userLabel: string; modifyUser: string; sessionId: string }
  export async function executeChangeSet(deps: ExecutorDeps, changesetId: string, who: ExecutorIdentity): Promise<{ status: 'done'|'partial'|'failed'; results: ItemResult[] }>
  // Precondition: rec.status === 'approved'. Uses who.accessToken for gateway writes, who.modifyUser in payloads,
  // and audits with sessionId=who.sessionId + userLabel=who.userLabel.
  ```
- **Rationale (spec §4):** the token is resolved by the caller *before* execution, so a token-resolution failure never strands a change-set in `executing` (the caller resolves first, then CAS→approved, then executes). The old internal stuck-state guard around `getFreshByHash` is removed with the token resolution it guarded; the executor still sets `executing` then a terminal status, and per-item failures are still isolated.
- **CRITICAL ordering (agy round-1):** the caller MUST resolve the FULL identity — token AND `modifyUser` — *before* `casStatus` flips `pending_approval → approved`. `modifyUserFrom` can throw (the placeholder guard throws unless the env flag is set; a real resolver could 5xx). If that throw happens after the CAS, the change-set is stranded in `approved` (never executes, never fails). Resolve `{accessToken, userLabel, modifyUser}` first; only on success CAS→approved→execute. A resolution failure leaves the change-set `pending_approval` and returns an error to the operator (retryable).

- [ ] **Step 1: Update the executor test to the new signature (RED)**

In `tests/changesetExecutor.test.ts`: remove `tokenManager`/`modifyUserFrom` from the `deps` factory; call `executeChangeSet(deps, id, who)` with `who = { accessToken: 'sess-token', userLabel: 'approver@kkday.com', modifyUser: 'UUID-1', sessionId: 'websess-1' }`. Update assertions:
- product/plan write tests: gateway PUT body carries `modify_user: 'UUID-1'` (from `who`); the gateway is called with `who.accessToken`.
- add an assertion that the audit row for a write has `sessionId: 'websess-1'` and `userLabel: 'approver@kkday.com'` (NOT `rec.sessionId`/`rec.creatorLabel`).
- the plan read-merge-write preservation test (k2 keeps `name`, both drop `updated_by/at`) stays.
- **DELETE the now-obsolete test** "token-refresh failure → status failed not stuck" (it referenced `deps.tokenManager.getFreshByHash` mocking + `modifyUserFrom`, which no longer exist on `ExecutorDeps` — leaving it guarantees a TS compile failure). The token is resolved by the caller now. Keep "a non-approved change-set is refused (BAD_STATE)".

Run: `npx vitest run tests/changesetExecutor.test.ts` → FAIL (signature mismatch).

- [ ] **Step 2: Implement the executor change**

In `src/changeset/executor.ts`:
- Change `ExecutorDeps` to `{ changeSets, gateway, audit, now }` (drop `tokenManager`, `modifyUserFrom`).
- Add `ExecutorIdentity` (exported).
- New signature `executeChangeSet(deps, changesetId, who: ExecutorIdentity)`.
- Remove the `getFreshByHash` + `modifyUserFrom` block and its stuck-state try/catch. After the `rec.status !== 'approved'` guard, `setStatus('executing')`, then use `who.accessToken` where `at` was used and `who.modifyUser` where `modifyUser` was used.
- Everywhere an audit row is written (per-item + any failure row), use `sessionId: who.sessionId, userLabel: who.userLabel` instead of `rec.sessionId`/`rec.creatorLabel`.
- Keep: `byOid` grouping, `Promise.allSettled`, per-item trace spans, read-merge-write (`execProduct`/`execPlan` unchanged except they already take `at`/`modifyUser` as params — pass `who.accessToken`/`who.modifyUser`), final `done/partial/failed`, `recordResults`.

- [ ] **Step 3: Update the current caller (interim — keep 2a green)**

In `src/server/confirmRoutes.ts` approve handler, resolve the FULL identity (token AND modifyUser) the *Phase 2a way* **BEFORE** the `casStatus` call (this is replaced in Task 5). Ordering matters: a `modifyUserFrom` throw must abort while the change-set is still `pending_approval`, never after CAS→approved.
```ts
// resolve identity FIRST (may throw — must be before casStatus)
const user = await deps.tokenManager.getFreshByHash(rec.creatorBearerHash)
const who = { accessToken: user.accessToken, userLabel: user.userLabel, modifyUser: deps.modifyUserFrom(user.accessToken), sessionId: rec.sessionId }
// then the existing stale-diff check + casStatus + audit, then:
const out = await executeChangeSet(deps, rec.id, who)
```
So the approve handler order becomes: load → liveDiff → stale check → **resolve `who` (token+modifyUser)** → `casStatus` pending→approved → audit → `executeChangeSet(deps, id, who)`. If resolving `who` throws, the async-route wrapper returns 500 but the change-set stays `pending_approval` (no CAS happened) — retryable, not stranded.
`ConfirmDeps` still `extends ExecutorDeps` but `ExecutorDeps` no longer has `tokenManager`/`modifyUserFrom`; add them explicitly to `ConfirmDeps` for now: `export interface ConfirmDeps extends ExecutorDeps { tokenManager: TokenManager; modifyUserFrom: (at: string) => string }`. (Task 5 keeps this shape; the token/modifyUser SOURCE switches from `creatorBearerHash` to the web session.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/changesetExecutor.test.ts tests/confirmRoutes.test.ts && npx tsc --noEmit` → PASS. (confirmRoutes tests still pass — behavior is unchanged, only the internal resolution moved to the caller.)

- [ ] **Step 5: Commit**

```bash
git add src/changeset/executor.ts src/server/confirmRoutes.ts tests/changesetExecutor.test.ts
git commit -m "feat(phase2b): executeChangeSet runs as an injected approver identity (token resolved by caller)"
```

---

### Task 4: SSO login flow — /confirm/login (POPUP) + /confirm/session (exchange→cookie) + cookie helper

**Files:**
- Create: `src/server/cookies.ts`, `src/server/ssoRoutes.ts`
- Test: `tests/cookies.test.ts`, `tests/ssoRoutes.test.ts`

**Interfaces:**
- Consumes: `AuthServiceClient.exchangeCode` (src/auth/authServiceClient.ts), `TokenStore` (upsert + hashBearer), `WebSessionStore` (Task 1), `decodeJwtClaims` (Task 2), `decodeJwtExpMs` (jwt.ts).
- Produces:
  ```ts
  // src/server/cookies.ts
  export function parseCookies(header: string | undefined): Record<string, string>
  export function serializeSetCookie(name: string, value: string, opts: { httpOnly?: boolean; sameSite?: 'Lax'|'Strict'; path?: string; maxAgeSec?: number }): string
  // src/server/ssoRoutes.ts
  export interface SsoDeps { authServiceClient: AuthServiceClient; tokenStore: TokenStore; webSessions: WebSessionStore; authOrigin: string; now: () => number }
  export function buildSsoRouter(deps: SsoDeps): express.Router
  //   GET  /confirm/login?next=…   → POPUP launcher HTML (origin-checked postMessage → POST /confirm/session → redirect next)
  //   POST /confirm/session {code} → exchangeCode → decode authKey → sessionId=newSessionId()
  //                                   tokenStore.upsert({bearerHash:hashBearer(sessionId), userLabel, tokens…})
  //                                   webSessions.create(sessionId, userLabel) → Set-Cookie be2mcp_sid → 200 {ok}
  //   POST /confirm/logout         → clear cookie + webSessions.delete
  ```

- [ ] **Step 1: Write the failing cookie test**

`tests/cookies.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseCookies, serializeSetCookie } from '../src/server/cookies.js'

describe('cookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; be2mcp_sid=abc; b=2')).toEqual({ a: '1', be2mcp_sid: 'abc', b: '2' })
    expect(parseCookies(undefined)).toEqual({})
  })
  it('serializes an HttpOnly cookie', () => {
    const c = serializeSetCookie('be2mcp_sid', 'abc', { httpOnly: true, sameSite: 'Lax', path: '/confirm' })
    expect(c).toContain('be2mcp_sid=abc')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Path=/confirm')
  })
})
```

- [ ] **Step 2: Run to verify it fails** → `npx vitest run tests/cookies.test.ts` → FAIL.

- [ ] **Step 3: Implement cookies.ts**

`src/server/cookies.ts`:
```ts
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}
export function serializeSetCookie(name: string, value: string,
  opts: { httpOnly?: boolean; sameSite?: 'Lax' | 'Strict'; path?: string; maxAgeSec?: number } = {}): string {
  let c = `${name}=${encodeURIComponent(value)}`
  if (opts.path) c += `; Path=${opts.path}`
  if (opts.sameSite) c += `; SameSite=${opts.sameSite}`
  if (opts.httpOnly) c += '; HttpOnly'
  if (opts.maxAgeSec !== undefined) c += `; Max-Age=${opts.maxAgeSec}`
  return c
}
```

- [ ] **Step 4: Write the failing ssoRoutes test**

`tests/ssoRoutes.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { openDb } from '../src/store/db.js'
import { TokenStore } from '../src/store/tokenStore.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import { buildSsoRouter } from '../src/server/ssoRoutes.js'

function fakeJwt(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`
}
let server: Server, base: string, tokenStore: TokenStore, webSessions: WebSessionStore
beforeEach(async () => {
  const db = openDb(':memory:')
  tokenStore = new TokenStore(db); webSessions = new WebSessionStore(db, { now: () => 1000 })
  const jwt = fakeJwt({ authKey: 'approver@kkday.com', exp: Math.floor(Date.now() / 1000) + 3000 })
  const authServiceClient = { exchangeCode: async (_c: string) => ({ accessToken: jwt, refreshToken: 'r', businessList: [] }) } as never
  const router = buildSsoRouter({ authServiceClient, tokenStore, webSessions, authOrigin: 'https://auth-220.sit.kkday.com', now: () => 1000 })
  const app = express(); app.use(express.json()); app.use(router)
  server = app.listen(0); await new Promise(r => server.on('listening', r as () => void))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

describe('SSO routes', () => {
  it('GET /confirm/login serves a click-gated POPUP launcher that pins the be2-auth origin', async () => {
    const r = await fetch(`${base}/confirm/login?next=${encodeURIComponent('/confirm/cs1')}`)
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toContain('loginFlow=POPUP')
    expect(html).toContain('auth-220.sit.kkday.com')          // the pinned origin for postMessage check
    expect(html).toContain('id="loginBtn"')                   // popup opens on click (not on load) — browsers block load-time popups
    expect(html).toContain('addEventListener')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
  })
  it('POST /confirm/session exchanges a code, creates a session, sets an HttpOnly cookie', async () => {
    const r = await fetch(`${base}/confirm/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'auth-code-1' }) })
    expect(r.status).toBe(200)
    const setCookie = r.headers.get('set-cookie')!
    expect(setCookie).toContain('be2mcp_sid=')
    expect(setCookie).toContain('HttpOnly')
    // the session exists and is labelled by the token's authKey email
    const sid = /be2mcp_sid=([^;]+)/.exec(setCookie)![1]
    expect(webSessions.get(sid)!.userLabel).toBe('approver@kkday.com')
    // the be2 token was stored under hashBearer(sessionId) so getFreshByHash works later
    expect(tokenStore.getByBearerHash(TokenStore.hashBearer(sid))!.userLabel).toBe('approver@kkday.com')
  })
  it('POST /confirm/session rejects a missing code', async () => {
    const r = await fetch(`${base}/confirm/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(400)
  })
})
```

- [ ] **Step 5: Run to verify it fails** → `npx vitest run tests/ssoRoutes.test.ts` → FAIL.

- [ ] **Step 6: Implement ssoRoutes.ts**

`src/server/ssoRoutes.ts`:
```ts
import express from 'express'
import type { AuthServiceClient } from '../auth/authServiceClient.js'
import { TokenStore } from '../store/tokenStore.js'
import type { WebSessionStore } from './webSessionStore.js'
import { decodeJwtClaims, decodeJwtExpMs } from '../auth/jwt.js'
import { serializeSetCookie } from './cookies.js'

export interface SsoDeps {
  authServiceClient: AuthServiceClient; tokenStore: TokenStore; webSessions: WebSessionStore
  authOrigin: string; now: () => number
}

function esc(s: unknown): string { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)) }

export function buildSsoRouter(deps: SsoDeps): express.Router {
  const r = express.Router()
  const h = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response) => { void fn(req, res).catch(() => { if (!res.headersSent) res.status(500).send('internal error') }) }

  // POPUP launcher. Opens be2-auth in a popup; on postMessage from the be2-auth origin ONLY,
  // extracts the authorizationCode, POSTs it to /confirm/session, then navigates to `next`.
  r.get('/confirm/login', (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/confirm/') ? req.query.next : '/'
    const loginUrl = `${deps.authOrigin}/auth/be2/login?loginFlow=POPUP&redirectPath=${encodeURIComponent(deps.authOrigin + '/auth/be2/login')}`
    res.status(200).send(`<!doctype html><meta charset=utf-8><title>be2 登入</title>
<body><p>需登入 be2 才能審批變更。</p><button id="loginBtn">登入 be2</button><p id="msg"></p><script>
  var AUTH_ORIGIN = ${JSON.stringify(deps.authOrigin)};
  var NEXT = ${JSON.stringify(next)};
  var LOGIN_URL = ${JSON.stringify(loginUrl)};
  var pop = null;
  // window.open MUST run inside a user gesture (click) — browsers block popups opened on load. (agy round-1)
  document.getElementById('loginBtn').addEventListener('click', function () {
    pop = window.open(LOGIN_URL, 'be2login', 'width=480,height=640');
    document.getElementById('msg').textContent = '請於彈出視窗登入…';
  });
  window.addEventListener('message', function (e) {
    if (e.origin !== AUTH_ORIGIN) return;            // MANDATORY origin check (spec §3)
    var code = (e.data && (e.data.authorizationCode || e.data.code)) || null;
    if (!code) return;
    fetch('/confirm/session', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ code: code }) })
      .then(function(r){ if(!r.ok) throw new Error('session'); if(pop) pop.close(); location.replace(NEXT); })
      .catch(function(){ document.getElementById('msg').textContent = '登入失敗,請重試。'; });
  });
</script></body>`)
  })

  r.post('/confirm/session', express.json(), h(async (req, res) => {
    const code = String((req.body as { code?: unknown })?.code ?? '')
    if (!code) { res.status(400).json({ error: { code: 'NO_CODE', message: 'missing authorization code' } }); return }
    const tokens = await deps.authServiceClient.exchangeCode(code)
    const userLabel = String(decodeJwtClaims(tokens.accessToken).authKey ?? '')
    if (!userLabel) { res.status(502).json({ error: { code: 'NO_USER', message: 'token has no authKey' } }); return }
    const sessionId = (await import('./webSessionStore.js')).WebSessionStore.newSessionId()
    deps.tokenStore.upsert({
      bearerHash: TokenStore.hashBearer(sessionId), userLabel,
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, businessList: tokens.businessList,
      accessExpiresAt: decodeJwtExpMs(tokens.accessToken), updatedAt: deps.now(),
    })
    deps.webSessions.create(sessionId, userLabel)
    res.setHeader('Set-Cookie', serializeSetCookie('be2mcp_sid', sessionId, { httpOnly: true, sameSite: 'Lax', path: '/confirm' }))
    res.status(200).json({ ok: true })
  }))

  r.post('/confirm/logout', (req, res) => {
    const { parseCookies } = require('./cookies.js') as typeof import('./cookies.js')
    const sid = parseCookies(req.header('cookie'))['be2mcp_sid']
    if (sid) deps.webSessions.delete(sid)
    res.setHeader('Set-Cookie', serializeSetCookie('be2mcp_sid', '', { httpOnly: true, sameSite: 'Lax', path: '/confirm', maxAgeSec: 0 }))
    res.status(200).send('logged out')
  })
  return r
}
```
Note: use a top-level `import { WebSessionStore }` and `import { parseCookies }` rather than dynamic `import()`/`require()` if the implementer prefers — the dynamic forms above avoid a circular-import worry but a static import is fine since `webSessionStore.ts`/`cookies.ts` don't import `ssoRoutes.ts`. Prefer static imports; adjust the two call sites accordingly.

- [ ] **Step 7: Run tests + typecheck + commit**

Run: `npx vitest run tests/cookies.test.ts tests/ssoRoutes.test.ts && npx tsc --noEmit` → PASS.
```bash
git add src/server/cookies.ts src/server/ssoRoutes.ts tests/cookies.test.ts tests/ssoRoutes.test.ts
git commit -m "feat(phase2b): SSO login flow — POPUP launcher + code-exchange session endpoint + cookie helper"
```

---

### Task 5: Rewire /confirm routes from capability-token to session-cookie auth

**Files:**
- Modify: `src/server/confirmRoutes.ts`
- Test: `tests/confirmRoutes.test.ts` (rewrite auth setup to cookies)

**Interfaces:**
- Consumes: `WebSessionStore` (Task 1), `TokenManager.getFreshByHash` (Phase 2a), `parseCookies` (Task 4), `ExecutorIdentity`/`executeChangeSet` (Task 3), `modifyUserFrom` (placeholder, still injected — parallel).
- Produces: `ConfirmDeps` grows `{ webSessions: WebSessionStore }`; the router:
  - `requireSession(req) → { session, ctxToken }`: read `be2mcp_sid` cookie → `webSessions.get` (undefined → 401 redirect to `/confirm/login?next=…`); `webSessions.touch`; `tokenManager.getFreshByHash(TokenStore.hashBearer(sessionId))` → fresh be2 token.
  - `/confirm/:id` (GET): requireSession → load change-set by id → **IDOR: `session.userLabel === rec.creatorLabel` else 404** → `liveDiff(rec, sessionToken)` → render (no token hidden input; forms carry only `diff_version`).
  - approve: requireSession → IDOR → `liveDiff(rec, sessionToken)` → stale 409 → CAS pending→approved → `executeChangeSet(deps, id, { accessToken: sessionToken, userLabel: session.userLabel, modifyUser: deps.modifyUserFrom(sessionToken), sessionId: session.sessionId })` → audit `session_id = session.sessionId, userLabel = session.userLabel`.
  - reject: requireSession → IDOR → CAS → audit to web session.
  - Remove `load(id, token)`, `hashesEqual`, `tokenOf`, and all `?token=`/hidden-token handling.

- [ ] **Step 1: Rewrite the confirmRoutes test to cookie auth (RED)**

Rewrite `tests/confirmRoutes.test.ts` so:
- setup builds a `WebSessionStore`, creates a session (`webSessions.create('sid-A','owner@kkday.com')`) and stores a be2 token under `hashBearer('sid-A')` (so `getFreshByHash` returns it); the seeded change-set has `creatorLabel: 'owner@kkday.com'`.
- requests send `Cookie: be2mcp_sid=sid-A` instead of `?token=`.
- Tests (keep the Phase 2a security properties, re-expressed for sessions):
  - no cookie → `GET /confirm/:id` redirects (302) to `/confirm/login?next=…` (or 401); approve with no cookie → not executed (**proves the agent, which has no cookie, cannot approve**).
  - **dead-session**: valid cookie but `tokenManager.getFreshByHash` throws (mock it to reject with `AuthError('REAUTH_REQUIRED')`) → `requireSession` deletes the session + the request redirects to `/confirm/login` (NOT a 500); assert `webSessions.get(sid)` is now undefined and no gateway write happened.
  - cookie of a DIFFERENT user (session `other@kkday.com`) → 404 (IDOR, no existence leak).
  - GET sets `Referrer-Policy: no-referrer` and shows the product name.
  - approve with matching diff_version executes once + sets done + writes; the gateway PUT used the SESSION token (assert via the mock gateway capturing the bearer) — not `creatorBearerHash`.
  - stale diff_version → 409, no execute.
  - double-approve (concurrent, same cookie) → executes once (CAS), second 409.
  - approve + reject each write an audit row with `session_id === 'sid-A'` and `userLabel === 'owner@kkday.com'`.
  - **modifyUser resolution failure leaves the change-set pending (not stranded)**: inject a `modifyUserFrom` that throws; approve → the change-set stays `pending_approval` (NOT `approved`/`executing`) and no gateway write happened — proves `modifyUser` is resolved before `casStatus`.

Run: `npx vitest run tests/confirmRoutes.test.ts` → FAIL.

- [ ] **Step 2: Implement the rewire**

In `src/server/confirmRoutes.ts`:
- Imports: add `import { parseCookies } from './cookies.js'`, `import { TokenStore } from '../store/tokenStore.js'`, `import type { WebSessionStore } from './webSessionStore.js'`, `import type { TokenManager } from '../auth/tokenManager.js'`.
- `ConfirmDeps`: `extends ExecutorDeps { tokenManager: TokenManager; webSessions: WebSessionStore; modifyUserFrom: (at: string) => string }`.
- Add:
  ```ts
  async function requireSession(req: express.Request): Promise<{ sessionId: string; userLabel: string; accessToken: string } | undefined> {
    const sid = parseCookies(req.header('cookie'))['be2mcp_sid']
    if (!sid) return undefined
    const sess = deps.webSessions.get(sid)   // undefined if idle-expired (row deleted)
    if (!sess) return undefined
    let user
    try {
      user = await deps.tokenManager.getFreshByHash(TokenStore.hashBearer(sid))
    } catch {
      // be2 refresh token expired/revoked (AuthError REAUTH_REQUIRED) or upstream unavailable:
      // the web session is dead. Delete it and treat as no-session so the caller redirects to
      // login — otherwise every /confirm request 500s in a loop until the idle TTL. (agy round-1)
      deps.webSessions.delete(sid)
      return undefined
    }
    deps.webSessions.touch(sid)
    return { sessionId: sid, userLabel: sess.userLabel, accessToken: user.accessToken }
  }
  function loginRedirect(res: express.Response, next: string) { res.redirect(302, `/confirm/login?next=${encodeURIComponent(next)}`) }
  ```
- `liveDiff(rec, accessToken)`: change to take the token param and use it (drop `getFreshByHash(rec.creatorBearerHash)`).
- GET `/confirm/:id`:
  ```ts
  res.setHeader('Referrer-Policy', 'no-referrer')
  const who = await requireSession(req)
  if (!who) { loginRedirect(res, `/confirm/${req.params.id}`); return }
  const rec = deps.changeSets.get(String(req.params.id))
  if (!rec || rec.creatorLabel !== who.userLabel || rec.status !== 'pending_approval') { res.status(404).send('not found'); return }
  const { diff, version } = await liveDiff(rec, who.accessToken)
  res.status(200).send(renderPage(rec.id, diff, version))    // renderPage no longer takes a token
  ```
- approve:
  ```ts
  res.setHeader('Referrer-Policy', 'no-referrer')
  const who = await requireSession(req)
  if (!who) { loginRedirect(res, `/confirm/${req.params.id}`); return }
  const rec = deps.changeSets.get(String(req.params.id))
  if (!rec || rec.creatorLabel !== who.userLabel || rec.status !== 'pending_approval') { res.status(404).send('not found'); return }
  const { diff, version } = await liveDiff(rec, who.accessToken)
  if (version !== String(req.body?.diff_version)) { res.status(409).send(renderPage(rec.id, diff, version, '<p style="color:#b00">目標欄位已被改動,請重新確認。</p>')); return }
  // Resolve modifyUser BEFORE casStatus (agy round-2): modifyUserFrom can throw (placeholder guard /
  // real resolver 5xx). If it threw AFTER the CAS, the change-set would be stranded in 'approved'.
  // Resolving here keeps it pending_approval on failure (the async wrapper returns 500, no CAS ran).
  const modifyUser = deps.modifyUserFrom(who.accessToken)
  const wonCas = deps.changeSets.casStatus(rec.id, 'pending_approval', 'approved', deps.now())
  if (!wonCas) { res.status(409).send('已被處理或已過期'); return }
  deps.audit.record({ userLabel: who.userLabel, sessionId: who.sessionId, clientInfo: 'confirm-page:' + String(req.headers['user-agent'] ?? '').slice(0, 80), tool: 'changeset.approve', params: { changeset_id: rec.id, ip: req.ip }, status: 'ok', traceId: 'n/a', durationMs: 0 })
  const out = await executeChangeSet(deps, rec.id, { accessToken: who.accessToken, userLabel: who.userLabel, modifyUser, sessionId: who.sessionId })
  res.status(200).send(`<!doctype html><meta charset=utf-8><h1>執行結果:${esc(out.status)}</h1><pre>${esc(JSON.stringify(out.results, null, 2))}</pre>`)
  ```
- reject: `requireSession` + IDOR + `casStatus(...'rejected')` + audit `sessionId: who.sessionId, userLabel: who.userLabel`.
- `renderPage(id, diff, diffVersion, banner?)`: drop the `token` param and the two hidden `token` inputs; approve/reject forms post only `diff_version` (approve) / nothing (reject) — auth is the cookie.
- Delete `load`, `hashesEqual`, `tokenOf`.

- [ ] **Step 3: Run tests + typecheck**

Run: `npx vitest run tests/confirmRoutes.test.ts tests/changesetExecutor.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/confirmRoutes.ts tests/confirmRoutes.test.ts
git commit -m "feat(phase2b): confirm routes use be2-auth session cookie (IDOR by session user, session-token exec, web-session audit); remove capability-token"
```

---

### Task 6: Wire into app.ts + integration test

**Files:**
- Modify: `src/server/app.ts`
- Test: `tests/serverIntegration.test.ts` (add a confirm-without-cookie assertion; tool list unchanged at 5)

**Interfaces:**
- Consumes: `buildSsoRouter` (Task 4), grown `ConfirmDeps` (Task 5), `WebSessionStore`, `AuthServiceClient`, `TokenStore`.
- Produces: the server mounts the SSO router + the session-authed confirm router; a single shared `WebSessionStore`, `TokenStore`, `AuthServiceClient`, `TokenManager`.

- [ ] **Step 1: Wire app.ts**

In `src/server/app.ts` `buildApp`:
- Construct once: `const webSessions = new WebSessionStore(db)`, reuse the existing `tokenStore`, `tokenManager`, `authServiceClient` (already built for the tool pipeline — reuse the same instances), `const authOrigin = new URL(config.authsvcUrl).origin`.
- Mount SSO first: `app.use(buildSsoRouter({ authServiceClient, tokenStore, webSessions, authOrigin, now: Date.now }))`.
- Grow the confirm router deps: `app.use(buildConfirmRouter({ changeSets, gateway: deps.gateway, audit: deps.audit, now: Date.now, tokenManager, webSessions, modifyUserFrom: modifyUserFromPlaceholder }))` — note `ExecutorDeps` no longer needs `tokenManager`/`modifyUserFrom` (those are on ConfirmDeps now); pass exactly what the grown `ConfirmDeps` requires.
- Body parsing: the confirm approve/reject forms are `application/x-www-form-urlencoded` (from the HTML `<form>`); keep `express.urlencoded({extended:false})` on the confirm router (Phase 2a already had it) so `req.body.diff_version` parses. `/confirm/session` uses `express.json()` (mounted inline in ssoRoutes).

- [ ] **Step 2: Update the integration test**

In `tests/serverIntegration.test.ts`: keep the 5-tool assertion. Add: `GET /confirm/<random-id>` with no cookie → 302 redirect to `/confirm/login` (proves session gate). `GET /confirm/login` → 200 and contains `loginFlow=POPUP`.

- [ ] **Step 3: Run the full suite + smoke**

Run: `npm run ci` → PASS. Smoke: `npm run dev`, then `curl -si http://127.0.0.1:8787/confirm/nope | head -1` → `302`; `curl -s http://127.0.0.1:8787/confirm/login | grep -c POPUP` → `1`.

- [ ] **Step 4: Commit**

```bash
git add src/server/app.ts tests/serverIntegration.test.ts
git commit -m "feat(phase2b): mount SSO router + session-authed confirm routes in the server"
```

---

### Task 7: Security tests + runbook + trackers (exit gate)

**Files:**
- Create: `tests/phase2bSecurity.test.ts`, `docs/be2-mcp/phase2b-runbook.md`
- Modify: `docs/be2-mcp/phase0-inventory.md`, `CLAUDE.md`

- [ ] **Step 1: Security test — the agent cannot approve, capability-token path is gone**

`tests/phase2bSecurity.test.ts` (spins the built app like the integration test):
- `POST /confirm/<id>/approve` with NO cookie AND with `?token=<anything>` → does NOT execute (redirect/404); assert the change-set stays `pending_approval` and no gateway write happened. This is the **self-approval-closed** proof: an agent (no be2-auth session) cannot approve even if it knows the change-set id and tries the old capability-token param.
- A valid session cookie for a DIFFERENT user cannot approve another user's change-set (IDOR → 404, no execute).

Run: `npx vitest run tests/phase2bSecurity.test.ts` → (write RED first if practical) → PASS.

- [ ] **Step 2: Full local gate**

Run: `npm run ci` → PASS; `npm run eval` → SKIP (no key) exit 0. Record counts for the runbook.

- [ ] **Step 3: Write `docs/be2-mcp/phase2b-runbook.md`**

Sections: prerequisites (VPN/office network for be2-auth, Node 22, `.env`); the SSO approval flow (agent stages via `be2_create_changeset` → reports `changeset_id` + diff; operator opens `http://127.0.0.1:8787/confirm/<id>`; if not logged in, the POPUP be2-auth login appears (silent if be2-auth cookie valid); operator reviews diff → 批准); logout (`/confirm/logout`); troubleshooting (redirected to login → your web session expired, log in again; 404 on your own change-set → you're logged in as a different be2 user than the one that created it; 403 at execute → be2 shelf-write permission missing, EXPECTED, and the current blocker; stale 409 → re-review); where sessions/audit live; **the self-approval closure** (the agent has no be2-auth session, so it cannot approve — this is the Phase 2b security improvement over 2a); Phase 2b limits (loopback single-host; write still 403-blocked; modify_user placeholder). Add a "⚠️ Live SIT WRITE e2e — PENDING a write-capable account" section listing the exact steps (login via POPUP → open diff → approve → execute 403 fail-closed today; toggle+revert once a write account exists).

- [ ] **Step 4: Update trackers**

`docs/be2-mcp/phase0-inventory.md` handoff: dated line — Phase 2b implemented (SSO confirm web app, session-cookie approval, self-approval hole closed, executor/liveDiff/audit attributed to the web session; NN passed; plan agy-approved); live WRITE e2e still DEFERRED (403 blocker); B2 REDIRECT-flow allowlist small-confirm noted (POPUP proven). `CLAUDE.md`: note the confirm page now needs be2-auth SSO login (no more capability URL).

- [ ] **Step 5: Commit**

```bash
git add tests/phase2bSecurity.test.ts docs/be2-mcp/phase2b-runbook.md docs/be2-mcp/phase0-inventory.md CLAUDE.md
git commit -m "test+docs(phase2b): self-approval-closed security tests + pilot runbook + trackers"
```

---

## Self-Review (performed at planning time)

- **Spec coverage**: §0 loopback + SSO session replaces capability-URL ✔ (T4 login flow, T5 rewire). §0 core value (agent can't approve) ✔ (T5 no-cookie test + T7 security test proving the old `?token=` path is gone and no cookie = no approve). §2 architecture (POPUP → /confirm/session → cookie; same token store) ✔ (T1 store-under-hashBearer(sid), T4 exchange). §3 be2-auth POPUP + mandatory origin check ✔ (T4 login page pins `authOrigin`, checks `event.origin`). §4 IDOR session.user==creator ✔ (T5), executor+liveDiff use session token ✔ (T3 signature + T5 caller), audit to web session ✔ (T3 executor rows + T5 route rows). §5 web_sessions + cookie + idle TTL + logout + TokenManager refresh reuse ✔ (T1, T4, T5 requireSession). §6 server-rendered, esc, Referrer-Policy, functional UI ✔ (T4/T5). §7 modify_user/403 parallel, placeholder stays ✔ (T5 still injects `modifyUserFrom`; T7 runbook PENDING). §9 tests (session lifecycle, cookie, exchange, session-auth, IDOR, CAS once, session-token exec, web-session audit, no-cookie-can't-approve, origin check) ✔ (T1/T4/T5/T6/T7). §10 exit gate ✔ (T7).
- **Deliberately parallel/deferred (not gaps)**: real `modify_user` userUuid resolver + 403 write permission (spec §0/§7) — placeholder retained, live write e2e PENDING a write-capable account (mirrors Phase 2a). B2 REDIRECT-flow `redirectPath` allowlist is a small Phase 0 confirm; POPUP is the implemented path.
- **Type consistency**: `ExecutorDeps` (T3, drops tokenManager/modifyUserFrom) vs `ConfirmDeps` (T5, adds tokenManager+webSessions+modifyUserFrom) — consistent; `ExecutorIdentity {accessToken,userLabel,modifyUser,sessionId}` used identically in T3 executor and T5 caller; `WebSessionStore` API (T1) used in T4/T5/T6; `TokenStore.hashBearer(sessionId)` keying used identically in T4 (store) and T5 (`requireSession` read); `decodeJwtClaims` (T2) used in T4; `parseCookies`/`serializeSetCookie` (T4) used in T4/T5.
- **Placeholder scan**: no TBDs. The one intentional placeholder (`modifyUserFrom`) is spec-sanctioned parallel work, retained and documented, not a plan gap.

<!-- agy-peer-reviewed: 2026-08-09T13:44:07Z rounds=3 verdict=approved -->
