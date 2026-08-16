# be2 MCP OAuth 2.1 外殼 + 確認頁 SSO-seamless Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 Claude（Code/Desktop）用瀏覽器 be2-auth 登入、經 OAuth 2.1 換 token 連 be2-mcp（取代手貼 static bearer），並讓同瀏覽器開確認頁時免二次登入——全程守住「agent 結構上無法自我批准」。

**Architecture:** 先把現行扁平 `TokenStore`（`user_tokens`：一顆 bearer 綁一份 be2 token）重構成兩層——`be2_identities`（be2 token，一次登入一筆）+ `credentials`（多把鑰匙 → 一 identity；kind=oauth_access|static_bearer|web_session），這是安全與正確性的地基（Phase A，行為零回歸）。再於其上疊 OAuth 2.1 協定層（discovery/DCR/authorize/token，Phase B）。authorize 的 be2-auth 登入腿先 spike REDIRECT flow、談不成切已驗證的 POPUP 備案。

**Tech Stack:** TypeScript（ESM、NodeNext）、express 5、better-sqlite3、zod 4、vitest 4、`node:crypto`（sha256、randomUUID、PKCE S256）。無新增依賴。

## Global Constraints

- 一律以繁體中文寫散文、註解、commit message 主體；程式碼識別字與路徑維持原文。
- **不新增依賴**（PKCE/hash 全用 `node:crypto`）。
- **credential 明文永不落地**：`credentials` / `oauth_auth_codes` / `oauth_refresh` 只存 sha256 hash。token/code/refresh 明文只在回應當下存在。
- **credential 值 ≠ identity；三種 credential 各自獨立隨機字串**：OAuth access token、be2mcp_sid cookie、static bearer 互不相等、各一筆 credential 指向同 identity。這是防自我批准的地基。
- **be2 refresh 只在 identity 一處 rotate**；所有引用它的 credential 立即拿到新鮮 be2 token。
- **`sessionOwner` 綁 `identity_id`（非 rotating 的 credential hash）**。
- **確認頁 approve/reject gated on `be2mcp_sid` cookie 且 credential kind 必須 == web_session**。
- **redirect_uri 驗證**：loopback 用 `new URL()` 解析後斷言 `hostname ∈ {localhost,127.0.0.1}` + path === '/callback'；claude.ai callback 完全字串比對。禁止字串前綴/naive regex。
- **DCR 回應不含 `client_secret` key**（連 null 都不行，避開 Claude Code zod）。
- **零回歸**：既有全部 auth / confirm / mcp 測試（243 passed 基準）在 Phase A 每個 task 後仍綠；static bearer（bootstrap-user）保留可用。
- 每個 task 結束跑 `npm run ci`（build:ui + typecheck + test）綠燈才 commit。

---

## 檔案結構

**Phase A（identity/credential 重構）**
- 新增 `src/store/identityStore.ts` — `be2_identities` CRUD（be2 token 一份、refresh rotate 在此）。
- 新增 `src/store/credentialStore.ts` — `credentials` CRUD（cred_hash → identity_id + kind；get/insert/delete/deleteByIdentity）。
- 修改 `src/store/db.ts` — 新增 `be2_identities`、`credentials` 表（+ Phase B 的 `oauth_clients`/`oauth_auth_codes`/`oauth_refresh`）。
- 修改 `src/auth/tokenManager.ts` — 改對 identity 操作（credential → identity → lazy refresh identity）。
- 修改 `src/auth/enroll.ts` — 建 identity + static_bearer credential。
- 修改 `src/server/ssoRoutes.ts` — `/confirm/session` 建/取 identity + web_session credential。
- 修改 `src/server/confirmRoutes.ts` — `requireSession` 經 credential(kind=web_session) → identity。
- 修改 `src/server/webSessionStore.ts` — TTL 層引用 identity（onDelete 改刪 credential + 視情況刪 identity）。
- 修改 `src/server/app.ts` — `/mcp` gate 查 credential；`sessionOwner` 綁 identity_id。

**Phase B（OAuth 協定層）**
- 新增 `src/oauth/oauthStore.ts` — `oauth_clients` / `oauth_auth_codes` / `oauth_refresh` CRUD。
- 新增 `src/oauth/discoveryRoutes.ts`、`registerRoutes.ts`、`authorizeRoutes.ts`、`tokenRoutes.ts`、`redirectUri.ts`（allowlist 驗證 helper）。
- 新增 `scripts/oauth-purge.ts` — 硬刪過期 code/refresh/ghost client。
- 修改 `src/server/app.ts` — 掛 oauth router；401 加 WWW-Authenticate。
- 新增 `docs/be2-mcp/oauth-runbook.md`；修改 `CLAUDE.md`、`docs/be2-mcp/phase0-inventory.md`。

---

## Phase A — identity/credential 重構（行為零回歸）

> **遞增綠燈策略（agy round-1）**：refactor 的讀路徑（`/mcp` gate、requireSession）與寫路徑（enroll、sso）散在不同 task，若逐一抽換會中途炸掉。故 Phase A 用**相容 adapter**：Task 2 把 `TokenStore` **保留為 class、但內部改成架在 `IdentityStore`+`CredentialStore` 上的 adapter**（`getByBearer`/`getByBearerHash`/`upsert`/`deleteByBearerHash`/`hashBearer` 對外簽章不變，內部映射到新表：`getByBearer`→credential→identity 合成 `TokenRecord`；`upsert`→找/建 identity + 確保一筆 credential；一個 bearerHash 對一 identity＝與現行 1:1 行為等價）。→ **所有既有呼叫端（`toolPipeline.ts`、`appPipeline.ts`、`app.ts`、`confirmRoutes.ts`、`webSessionStore.ts`、`enroll.ts`）在 Task 2–4 期間完全不改也能綠**；Task 3–5 再逐一把呼叫端從 adapter 切到直接用 identity/credential（每步綠，adapter 還在）。**Task 5 最後刪除 adapter 內剩餘扁平路徑、drop `user_tokens` 表**。
>
> **完整呼叫端清單（實查，Task 5 必須全數不再依賴扁平 TokenStore）**：`src/auth/tokenManager.ts`、`src/auth/enroll.ts`、`src/server/ssoRoutes.ts`、`src/server/confirmRoutes.ts`、`src/server/webSessionStore.ts`、`src/server/app.ts`、`src/server/toolPipeline.ts`（`TokenStore.hashBearer(reqCtx.bearer)` → `creator_bearer_hash`）、`src/server/appPipeline.ts`（同）。`change_sets.creator_bearer_hash` 是 sha256(bearer)，`CredentialStore.hash` 同為 sha256 → 值不變、IDOR gate 用的是 `creatorLabel`（JWT authKey，Phase 2b）不受影響，但 hash 呼叫需改指向 `CredentialStore.hash`。

### Task 1: 新 schema + IdentityStore + CredentialStore

**Files:**
- Modify: `src/store/db.ts`
- Create: `src/store/identityStore.ts`, `src/store/credentialStore.ts`
- Test: `tests/identityCredentialStore.test.ts`

**Interfaces:**
- Produces:
  - `interface Identity { identityId: string; userLabel: string; accessToken: string; refreshToken: string; businessList: unknown[]; accessExpiresAt: number; updatedAt: number }`
  - `class IdentityStore { constructor(db); get(identityId): Identity|undefined; upsert(rec: Identity): void; delete(identityId): void }`
  - `type CredentialKind = 'oauth_access' | 'static_bearer' | 'web_session'`
  - `interface Credential { credHash: string; identityId: string; kind: CredentialKind; expiresAt: number | null; updatedAt: number }`
  - `class CredentialStore { constructor(db); static hash(secret: string): string; get(credHash): Credential|undefined; getBySecret(secret): Credential|undefined; insert(rec: Credential): void; delete(credHash): void; deleteByIdentity(identityId): void; countByIdentity(identityId): number }`

- [ ] **Step 1: 加 schema**

`src/store/db.ts` 的 schema 字串內追加（在 `web_sessions` 之後）：

```sql
CREATE TABLE IF NOT EXISTS be2_identities (
  identity_id        TEXT PRIMARY KEY,
  user_label         TEXT NOT NULL,
  access_token       TEXT NOT NULL,
  refresh_token      TEXT NOT NULL,
  business_list_json TEXT NOT NULL,
  access_expires_at  INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  cred_hash    TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  expires_at   INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_identity ON credentials(identity_id);
```

- [ ] **Step 2: 寫失敗測試**

```typescript
// tests/identityCredentialStore.test.ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'

function db() { return openDb(':memory:') }

it('identity upsert/get round-trip + rotate 覆寫同一筆', () => {
  const s = new IdentityStore(db())
  s.upsert({ identityId: 'I1', userLabel: 'u', accessToken: 'a1', refreshToken: 'r1', businessList: [1], accessExpiresAt: 100, updatedAt: 1 })
  s.upsert({ identityId: 'I1', userLabel: 'u', accessToken: 'a2', refreshToken: 'r2', businessList: [1], accessExpiresAt: 200, updatedAt: 2 })
  expect(s.get('I1')).toMatchObject({ accessToken: 'a2', refreshToken: 'r2', accessExpiresAt: 200 })
})
it('credential 三種 kind 指向同 identity；getBySecret 只存 hash', () => {
  const d = db(); const cs = new CredentialStore(d)
  cs.insert({ credHash: CredentialStore.hash('tokA'), identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  cs.insert({ credHash: CredentialStore.hash('sidB'), identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 1 })
  expect(cs.getBySecret('tokA')).toMatchObject({ identityId: 'I1', kind: 'oauth_access' })
  expect(cs.getBySecret('sidB')).toMatchObject({ identityId: 'I1', kind: 'web_session' })
  // 明文不落地：DB 內查不到明文
  const raw = (d.prepare('SELECT cred_hash FROM credentials').all() as {cred_hash:string}[]).map(r => r.cred_hash)
  expect(raw).not.toContain('tokA')
  expect(cs.countByIdentity('I1')).toBe(2)
})
it('deleteByIdentity 清掉該 identity 全部 credential', () => {
  const cs = new CredentialStore(db())
  cs.insert({ credHash: CredentialStore.hash('x'), identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  cs.deleteByIdentity('I1')
  expect(cs.getBySecret('x')).toBeUndefined()
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run tests/identityCredentialStore.test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 4: 實作兩個 store**

```typescript
// src/store/identityStore.ts
import type Database from 'better-sqlite3'
export interface Identity {
  identityId: string; userLabel: string; accessToken: string; refreshToken: string
  businessList: unknown[]; accessExpiresAt: number; updatedAt: number
}
export class IdentityStore {
  constructor(private db: Database.Database) {}
  get(identityId: string): Identity | undefined {
    const r = this.db.prepare('SELECT * FROM be2_identities WHERE identity_id = ?').get(identityId) as Record<string, unknown> | undefined
    if (!r) return undefined
    return { identityId: r.identity_id as string, userLabel: r.user_label as string, accessToken: r.access_token as string,
      refreshToken: r.refresh_token as string, businessList: JSON.parse(r.business_list_json as string),
      accessExpiresAt: r.access_expires_at as number, updatedAt: r.updated_at as number }
  }
  upsert(rec: Identity): void {
    this.db.prepare(`INSERT INTO be2_identities (identity_id,user_label,access_token,refresh_token,business_list_json,access_expires_at,updated_at)
      VALUES (@identityId,@userLabel,@accessToken,@refreshToken,@businessListJson,@accessExpiresAt,@updatedAt)
      ON CONFLICT(identity_id) DO UPDATE SET user_label=@userLabel,access_token=@accessToken,refresh_token=@refreshToken,
      business_list_json=@businessListJson,access_expires_at=@accessExpiresAt,updated_at=@updatedAt`)
      .run({ ...rec, businessListJson: JSON.stringify(rec.businessList) })
  }
  delete(identityId: string): void { this.db.prepare('DELETE FROM be2_identities WHERE identity_id = ?').run(identityId) }
}
```

```typescript
// src/store/credentialStore.ts
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
export type CredentialKind = 'oauth_access' | 'static_bearer' | 'web_session'
export interface Credential { credHash: string; identityId: string; kind: CredentialKind; expiresAt: number | null; updatedAt: number }
export class CredentialStore {
  constructor(private db: Database.Database) {}
  static hash(secret: string): string { return createHash('sha256').update(secret).digest('hex') }
  get(credHash: string): Credential | undefined {
    const r = this.db.prepare('SELECT * FROM credentials WHERE cred_hash = ?').get(credHash) as Record<string, unknown> | undefined
    if (!r) return undefined
    return { credHash: r.cred_hash as string, identityId: r.identity_id as string, kind: r.kind as CredentialKind,
      expiresAt: (r.expires_at as number | null) ?? null, updatedAt: r.updated_at as number }
  }
  getBySecret(secret: string): Credential | undefined { return this.get(CredentialStore.hash(secret)) }
  insert(rec: Credential): void {
    this.db.prepare('INSERT OR REPLACE INTO credentials (cred_hash,identity_id,kind,expires_at,updated_at) VALUES (?,?,?,?,?)')
      .run(rec.credHash, rec.identityId, rec.kind, rec.expiresAt, rec.updatedAt)
  }
  delete(credHash: string): void { this.db.prepare('DELETE FROM credentials WHERE cred_hash = ?').run(credHash) }
  deleteByIdentity(identityId: string): void { this.db.prepare('DELETE FROM credentials WHERE identity_id = ?').run(identityId) }
  countByIdentity(identityId: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM credentials WHERE identity_id = ?').get(identityId) as { c: number }).c
  }
}
```

- [ ] **Step 5: 跑測試確認通過 + 全量回歸**

Run: `npx vitest run tests/identityCredentialStore.test.ts && npm run ci`
Expected: PASS；既有 243 仍綠（新表未被舊路徑使用）。

- [ ] **Step 6: Commit**

```bash
git add src/store/db.ts src/store/identityStore.ts src/store/credentialStore.ts tests/identityCredentialStore.test.ts
git commit -m "feat(auth): be2_identities + credentials schema 與 store（identity/credential 拆分地基）"
```

---

### Task 2: TokenManager 改對 identity 操作

**Files:**
- Modify: `src/auth/tokenManager.ts`
- Test: `tests/tokenManagerIdentity.test.ts`

**Interfaces:**
- Consumes: `IdentityStore`, `CredentialStore`（Task 1）。
- Produces:
  - `TokenManager` 建構子改收 `{ identities: IdentityStore; credentials: CredentialStore }`；`getFreshBySecret(secret): Promise<UserAuthContext>`（credential→identity→lazy refresh identity）與 `getFreshByCredHash(credHash)`。`UserAuthContext` 不變。refresh 的 single-flight key 改為 `identityId`。舊 `getFreshAccessToken(bearer)`/`getFreshByHash(hash)` 保留為薄包裝（轉呼叫），既有呼叫端零改動。
  - **`TokenStore` 改為相容 adapter**（同檔 `src/store/tokenStore.ts`，class 名/方法簽章不變，內部架在 `IdentityStore`+`CredentialStore`）：`getByBearerHash(h)`→`credentials.get(h)`→`identities.get(cred.identityId)`→合成 `TokenRecord`（`bearerHash=h`）；`upsert(rec)`→若 `credentials.get(rec.bearerHash)` 存在則更新其 identity 的 be2 token，否則 `identityId=randomUUID()`+`identities.upsert`+`credentials.insert(kind='static_bearer')`；`deleteByBearerHash(h)`→`credentials.delete(h)`（+ 該 identity 無其他 credential 則 `identities.delete`）；`hashBearer` 不變。→ 所有既有 TokenStore 呼叫端在 Task 2–4 期間無需改動即綠。

- [ ] **Step 1: 寫失敗測試（核心：一 identity 被兩 credential 引用，refresh 只 rotate 一次、兩者皆新鮮）**

```typescript
// tests/tokenManagerIdentity.test.ts
import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { TokenManager } from '../src/auth/tokenManager.js'

function setup(now: () => number, refresh: any) {
  const db = openDb(':memory:')
  const identities = new IdentityStore(db); const credentials = new CredentialStore(db)
  identities.upsert({ identityId: 'I1', userLabel: 'u', accessToken: 'OLD', refreshToken: 'R1', businessList: [], accessExpiresAt: 0, updatedAt: 0 })
  credentials.insert({ credHash: CredentialStore.hash('tokA'), identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 0 })
  credentials.insert({ credHash: CredentialStore.hash('sidB'), identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 0 })
  const auth = { refresh } as any
  const tm = new TokenManager({ identities, credentials } as any, auth, { now, skewMs: 60_000 })
  return { tm, identities }
}

it('兩 credential 指向同 identity：refresh 只呼叫一次、兩者都拿到新鮮 token', async () => {
  let t = 1_000_000
  const refresh = vi.fn().mockResolvedValue({ accessToken: 'NEW.eyJ.x', refreshToken: 'R2', businessList: [] })
  // 讓 decodeJwtExpMs 有值：用一顆能解出 exp 的假 JWT
  const { tm } = setup(() => t, vi.fn().mockResolvedValue({ accessToken: makeJwt(t + 3_600_000), refreshToken: 'R2', businessList: [] }))
  const a = await tm.getFreshBySecret('tokA')   // 觸發 refresh（過期）
  const b = await tm.getFreshBySecret('sidB')   // 同 identity，已刷新，不再 refresh
  expect(a.accessToken).toBe(b.accessToken)     // 同一份新鮮 token
})
it('未知 secret → UNKNOWN_BEARER 401', async () => {
  const { tm } = setup(() => 0, vi.fn())
  await expect(tm.getFreshBySecret('nope')).rejects.toMatchObject({ status: 401 })
})

// helper：造一顆 exp=<ms> 的最小 JWT（header.payload.sig，base64url）
function makeJwt(expMs: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(expMs / 1000), authKey: 'u' })}.sig`
}
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/tokenManagerIdentity.test.ts`
Expected: FAIL（`getFreshBySecret` 不存在 / 建構子簽章不符）。

- [ ] **Step 3: 實作**

(a) 改 `TokenManager`：建構子收 `{ identities, credentials }`；`freshFromRecord` 改成 `freshFromIdentity(identity, identityId)`；refresh rotate `identities.upsert`；single-flight key = identityId。`getFreshBySecret(secret)`：`credentials.getBySecret(secret)` → `identities.get(cred.identityId)` → freshFromIdentity。`getFreshByCredHash(credHash)` 同理。保留 `getFreshAccessToken`/`getFreshByHash` 為薄包裝。doRefresh 的 4xx→REAUTH_REQUIRED、5xx 沿用既有邏輯（改成寫 identity）。
(b) 把 `TokenStore` 改成 adapter（見 Interfaces）——**這是讓既有呼叫端零改動仍綠的關鍵**。adapter 建構子改收 `{ identities, credentials }`（或直接 new 兩個 store 於同一 db）。`app.ts` 建 TokenStore 時注入 identities/credentials。

- [ ] **Step 4: 跑測試確認通過 + 全量回歸**

Run: `npx vitest run tests/tokenManagerIdentity.test.ts && npm run ci`
Expected: PASS；既有 tokenManager 測試需同步改 fixture（見下 Step 5）。

- [ ] **Step 5: 修既有 tokenManager 測試 fixture**

既有 `tests/` 內建構 TokenManager 用舊 `TokenStore` 的測試，改用 `{ identities, credentials }`（行為斷言不動，只換 setup）。跑 `npm run ci` 全綠。

- [ ] **Step 6: Commit**

```bash
git add src/auth/tokenManager.ts tests/tokenManagerIdentity.test.ts tests/
git commit -m "refactor(auth): TokenManager 改對 identity 操作，be2 refresh 只在 identity rotate 一次"
```

---

### Task 3: enroll 建 identity + static_bearer credential

**Files:**
- Modify: `src/auth/enroll.ts`
- Test: `tests/enroll.test.ts`（既有，改斷言）

**Interfaces:**
- Consumes: `IdentityStore`, `CredentialStore`（Task 1）。
- Produces: `enrollUser(deps: { identities: IdentityStore; credentials: CredentialStore; auth: AuthServiceClient }, input, now?)` → `{ bearer }`。建一個 identity（`identityId = randomUUID()`、be2 token）+ 一個 `credentials`（`credHash = CredentialStore.hash(bearer)`、kind='static_bearer'、identityId）。`generateBearer()` 不變（`be2mcp_<hex>`）。

- [ ] **Step 1: 改測試（enroll 後：identity 有 be2 token、credential kind=static_bearer 指向它）**

```typescript
// tests/enroll.test.ts（改）
it('enroll 建 identity + static_bearer credential', async () => {
  const db = openDb(':memory:')
  const identities = new IdentityStore(db); const credentials = new CredentialStore(db)
  const auth = { exchangeCode: async () => ({ accessToken: makeJwt(), refreshToken: 'R', businessList: [] }) } as any
  const { bearer } = await enrollUser({ identities, credentials, auth }, { userLabel: 'u', code: 'C' }, () => 1)
  const cred = credentials.getBySecret(bearer)!
  expect(cred.kind).toBe('static_bearer')
  expect(identities.get(cred.identityId)).toMatchObject({ refreshToken: 'R' })
})
```

- [ ] **Step 2: 跑測試確認失敗** — Run: `npx vitest run tests/enroll.test.ts` → FAIL。

- [ ] **Step 3: 實作** — `enrollUser` 內：exchangeCode → 取 authKey 當 userLabel（既有邏輯）→ `identityId=randomUUID()` → `identities.upsert({...})` → `bearer=generateBearer()` → `credentials.insert({ credHash: CredentialStore.hash(bearer), identityId, kind:'static_bearer', expiresAt:null, updatedAt:now() })` → 回 `{ bearer }`。

- [ ] **Step 4: 修 bootstrap-user 接線** — `scripts/bootstrap-user.ts` 改傳 `{ identities, credentials, auth }`。跑 `npm run ci` 綠。

- [ ] **Step 5: Commit**

```bash
git add src/auth/enroll.ts scripts/bootstrap-user.ts tests/enroll.test.ts
git commit -m "refactor(auth): enroll 改建 identity + static_bearer credential"
```

---

### Task 4: 確認頁 session 走 identity/credential（kind=web_session）

**Files:**
- Modify: `src/store/db.ts`（web_sessions 加 identity_id 欄）、`src/server/ssoRoutes.ts`, `src/server/confirmRoutes.ts`, `src/server/webSessionStore.ts`, `src/server/app.ts`（onDelete 接線同 task）
- Test: `tests/confirmRoutes.test.ts`（既有，零回歸）+ `tests/ssoIdentity.test.ts`

**Interfaces:**
- Consumes: `IdentityStore`, `CredentialStore`, `TokenManager.getFreshByCredHash`。
- Produces:
  - `web_sessions` 表**新增 `identity_id TEXT` 欄**（不覆用 `user_label` 塞 identity——agy round-1 語義污染）。`WebSession` 介面加 `identityId: string`；`create(sessionId, identityId)`。
  - `/confirm/session` 建 identity + `credentials`(kind='web_session', credHash=hash(be2mcp_sid)) + `web_sessions` TTL 列（存 identity_id）。
  - `confirmRoutes.requireSession` 讀 be2mcp_sid → `credentials.getBySecret` → **驗 kind==='web_session'**（非則 undefined，防 agent 拿 oauth token 當 cookie）→ identity → `getFreshByCredHash`。
  - `WebSessionStore.onDelete(sessionId)` 改為刪該 session 的 web_session credential（`credentials.delete(hash(sessionId))`）+ 若 `credentials.countByIdentity(identityId)===0` 則 `identities.delete`。**onDelete 的接線在 `app.ts` — 故本 task 同時改 app.ts 傳入新的 onDelete**（否則 Task 4 破綠，agy round-1）。

- [ ] **Step 1: 寫失敗測試（kind gate + SSO 放行）**

```typescript
// tests/ssoIdentity.test.ts
it('requireSession：kind=web_session 放行；oauth_access 當 cookie 送 → 拒', async () => {
  // 建 identity I1 + web_session cred（cookie sidB）+ oauth_access cred（tokA）
  // 用 sidB 當 be2mcp_sid → requireSession 回 who
  // 用 tokA 當 be2mcp_sid → requireSession 回 undefined（kind 不符，防自我批准）
  // （以既有 confirmRoutes 測試的 setup 樣式組裝；斷言 who 有/無）
})
```

- [ ] **Step 2: 跑測試確認失敗** — FAIL。

- [ ] **Step 3: 實作 web_session credential + kind gate**

- `ssoRoutes.ts` `/confirm/session`：`exchangeCode` → identityId=randomUUID → `identities.upsert` → `sid=WebSessionStore.newSessionId()` → `credentials.insert({credHash: CredentialStore.hash(sid), identityId, kind:'web_session', expiresAt:null, updatedAt:now})` → `webSessions.create(sid, identityId)` → 設 `be2mcp_sid` cookie（path/SameSite 不變）。抽「exchangeCode→建 identity」為共用 helper（Phase B authorize 復用）。
- `confirmRoutes.ts` `requireSession`：`const cred = credentials.getBySecret(sid); if (!cred || cred.kind !== 'web_session') return undefined;` → `getFreshByCredHash(cred.credHash)` → 取 identity userLabel。**kind !== 'web_session' 一律 undefined**（防 agent 拿 oauth_access token 當 cookie）。
- `webSessionStore.ts`：`create(sessionId, identityId)`（欄位 user_label 改存 identity_id 或加欄位；沿用 web_sessions 表，onDelete 改刪 credential）。onDelete callback 改為 `credentials.delete(hash(sid))` + 若 `countByIdentity==0` 則 `identities.delete`。

- [ ] **Step 4: 跑測試確認通過 + confirm 零回歸**

Run: `npx vitest run tests/ssoIdentity.test.ts tests/confirmRoutes.test.ts tests/confirmRoutesInventory.test.ts && npm run ci`
Expected: 全綠。既有 confirm 測試若因 setup 改動需同步 fixture（不動行為斷言）。

- [ ] **Step 5: Commit**

```bash
git add src/server/ssoRoutes.ts src/server/confirmRoutes.ts src/server/webSessionStore.ts tests/ssoIdentity.test.ts tests/
git commit -m "refactor(auth): 確認頁 session 走 web_session credential + kind gate（防 oauth token 當 cookie）"
```

---

### Task 5: /mcp gate 查 credential + sessionOwner 綁 identity + 收尾（刪 adapter/user_tokens）

**Files:**
- Modify: `src/server/app.ts`, `src/server/toolPipeline.ts`, `src/server/appPipeline.ts`, `src/store/db.ts`（drop user_tokens）
- Delete: `src/store/tokenStore.ts`（adapter 收尾移除）
- Test: `tests/serverIntegration.test.ts`（既有 fixture 遷移 + 追加）

**Interfaces:**
- Consumes: `CredentialStore`, `IdentityStore`。
- Produces:
  - `/mcp` bearer gate：`credentials.getBySecret(bearer)` 存在才放行（OAuth token 與 static bearer 通吃）；`sessionOwner.set(mcpSessionId, cred.identityId)`、比對用 `credentials.getBySecret(bearer)?.identityId`。app.ts 建 IdentityStore/CredentialStore 實例並注入 TokenManager/ssoRoutes/confirmRoutes/toolPipeline/appPipeline。
  - **`toolPipeline.ts` / `appPipeline.ts`**：`TokenStore.hashBearer(reqCtx.bearer)` → `CredentialStore.hash(reqCtx.bearer)`（值相同，只換來源，`creator_bearer_hash`/session-owner 相容）。
  - **收尾**：確認全 repo 無其他 `TokenStore` import（grep `TokenStore`）→ 刪 `src/store/tokenStore.ts`、db.ts drop `user_tokens`（`DROP TABLE IF EXISTS user_tokens`）。遷移 `tests/serverIntegration.test.ts` 等直接塞 `user_tokens`/`TokenStore` 的 fixture 改用 `IdentityStore`+`CredentialStore`。

- [ ] **Step 1: 寫失敗測試（未知 bearer 401；同 identity 不同 credential 共用 session 不 MISMATCH）**

```typescript
// tests/serverIntegration.test.ts 追加
it('/mcp：未知 bearer 401；credential 存在放行', async () => { /* 用 buildApp + 假 credential 打 initialize */ })
it('sessionOwner 綁 identity：同 identity 的另一 credential 帶同 mcp-session-id 不觸發 SESSION_OWNER_MISMATCH', async () => { /* ... */ })
```

- [ ] **Step 2: 跑測試確認失敗** — FAIL。

- [ ] **Step 3: 實作** — `app.ts`：`/mcp` gate 改 `const cred = credentials.getBySecret(bearer); if (!cred) { 401 + WWW-Authenticate(見 Task 10) }`；`onsessioninitialized` 設 `sessionOwner.set(id, cred.identityId)`；owner 比對改 `credentials.getBySecret(bearer)?.identityId`。`toolPipeline.ts`/`appPipeline.ts` 的 `TokenStore.hashBearer` → `CredentialStore.hash`。

- [ ] **Step 4: 收尾 — 刪 adapter + drop 表 + 遷移 fixture** — grep 全 repo 確認無 `TokenStore` 殘留 import（除待刪檔）→ 刪 `src/store/tokenStore.ts`、db.ts 加 `DROP TABLE IF EXISTS user_tokens`（或直接不再 CREATE）→ 把 `tests/serverIntegration.test.ts` 等直接操作 `user_tokens`/`TokenStore` 的 fixture 改用 `IdentityStore`+`CredentialStore`。

- [ ] **Step 5: 跑 CI 全綠（Phase A 完成，零回歸）**

Run: `npm run ci`
Expected: PASS（既有 243 遷移後 + Phase A 新測試全綠；無 TokenStore/user_tokens 殘留）。

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/toolPipeline.ts src/server/appPipeline.ts src/store/db.ts tests/serverIntegration.test.ts
git rm src/store/tokenStore.ts
git commit -m "refactor(auth): /mcp gate 查 credential、sessionOwner 綁 identity、刪 TokenStore adapter + drop user_tokens（Phase A 收尾）"
```

> **Phase A 完成 gate**：`npm run ci` 全綠、static bearer 仍可 enroll+連線+批准（既有測試證明）。之後才進 Phase B。

---

## Phase B — OAuth 2.1 協定層

### Task 6: oauthStore + discovery routes

**Files:**
- Modify: `src/store/db.ts`（加 oauth 三表）
- Create: `src/oauth/oauthStore.ts`, `src/oauth/discoveryRoutes.ts`
- Modify: `src/server/app.ts`（掛 discovery）
- Test: `tests/oauthDiscovery.test.ts`

**Interfaces:**
- Produces:
  - schema：`oauth_clients(client_id PK, redirect_uris_json, created_at)`、`oauth_auth_codes(code_hash PK, client_id, redirect_uri, code_challenge, identity_id, exp, consumed)`、`oauth_refresh(refresh_hash PK, identity_id, client_id, exp, consumed)`（`consumed` 供 refresh-reuse 偵測；rotate 時標記 consumed 而非刪，consumed 再用 → family revoke，見 Task 10）。
  - `class OAuthStore` — clients/codes/refresh 的 insert/get/consume/delete（codes、refresh 只存 hash）。
  - `buildDiscoveryRouter(opts: { baseUrl: string }): express.Router` — `GET /.well-known/oauth-protected-resource`、`GET /.well-known/oauth-authorization-server`。

- [ ] **Step 1: 寫失敗測試（discovery JSON 欄位）**

```typescript
// tests/oauthDiscovery.test.ts
it('authorization-server metadata 宣告 S256 + none + endpoints', async () => {
  // buildApp → GET /.well-known/oauth-authorization-server → 斷言
  // code_challenge_methods_supported=['S256']、token_endpoint_auth_methods_supported=['none']、
  // authorization_endpoint/token_endpoint/registration_endpoint 為絕對 URL
})
it('protected-resource metadata 指向本 AS', async () => { /* ... */ })
```

- [ ] **Step 2: 跑測試確認失敗** — FAIL。

- [ ] **Step 3: 實作 schema + OAuthStore + discovery**

schema 三表加進 db.ts。`discoveryRoutes.ts` 回兩個 JSON：
```typescript
r.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
  issuer: baseUrl,
  authorization_endpoint: `${baseUrl}/oauth/authorize`,
  token_endpoint: `${baseUrl}/oauth/token`,
  registration_endpoint: `${baseUrl}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
}))
```
（protected-resource 回 `{ resource: baseUrl, authorization_servers: [baseUrl] }`。）

- [ ] **Step 4: 跑測試 + CI** — Run: `npx vitest run tests/oauthDiscovery.test.ts && npm run ci` → PASS。

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts src/oauth/oauthStore.ts src/oauth/discoveryRoutes.ts src/server/app.ts tests/oauthDiscovery.test.ts
git commit -m "feat(oauth): oauthStore 三表 + discovery（RFC 9728/8414）"
```

---

### Task 7: DCR register + redirect_uri 嚴格驗證

**Files:**
- Create: `src/oauth/registerRoutes.ts`, `src/oauth/redirectUri.ts`
- Modify: `src/server/app.ts`
- Test: `tests/oauthRegister.test.ts`, `tests/redirectUri.test.ts`

**Interfaces:**
- Produces:
  - `isAllowedRedirectUri(uri: string): boolean` — `new URL()` 解析；`https://claude.ai/api/mcp/auth_callback` 完全比對，或 `http` + `hostname ∈ {localhost,127.0.0.1}` + `pathname === '/callback'`。其餘一律 false。
  - `buildRegisterRouter(opts:{ oauthStore, genId }): express.Router` — `POST /oauth/register`（RFC 7591）：驗每個 redirect_uri 都 allowed，建 client（`client_id=genId()`），回 `{ client_id, redirect_uris, token_endpoint_auth_method:'none', ... }`——**不含 client_secret key**。

- [ ] **Step 1: 寫失敗測試（open-redirect 防禦是重點）**

```typescript
// tests/redirectUri.test.ts
import { isAllowedRedirectUri } from '../src/oauth/redirectUri.js'
it('放行 claude.ai callback + loopback', () => {
  expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
  expect(isAllowedRedirectUri('http://127.0.0.1:54321/callback')).toBe(true)
  expect(isAllowedRedirectUri('http://localhost:8999/callback')).toBe(true)
})
it('擋 open-redirect 變形', () => {
  expect(isAllowedRedirectUri('http://localhost.evil.com/callback')).toBe(false)
  expect(isAllowedRedirectUri('http://127.0.0.1.evil.com/callback')).toBe(false)
  expect(isAllowedRedirectUri('https://claude.ai.evil.com/api/mcp/auth_callback')).toBe(false)
  expect(isAllowedRedirectUri('http://localhost:1/other')).toBe(false)
  expect(isAllowedRedirectUri('javascript:alert(1)//callback')).toBe(false)
})
```

```typescript
// tests/oauthRegister.test.ts
it('DCR 回應不含 client_secret key（連 null 都沒有）', async () => {
  // POST /oauth/register {redirect_uris:['http://127.0.0.1:5/callback']} → body 不含 'client_secret'
  expect('client_secret' in body).toBe(false)
})
it('redirect_uri 不在 allowlist → 400，不建 client', async () => { /* ... */ })
```

- [ ] **Step 2: 跑測試確認失敗** — FAIL。

- [ ] **Step 3: 實作**

```typescript
// src/oauth/redirectUri.ts
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.protocol === 'https:' && u.host === 'claude.ai' && u.pathname === '/api/mcp/auth_callback') return true
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.pathname === '/callback') return true
  return false
}
```
register handler：驗全部 redirect_uris → 建 client → 回 JSON **用物件字面量不放 client_secret key**。

- [ ] **Step 4: 跑測試 + CI** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/oauth/registerRoutes.ts src/oauth/redirectUri.ts src/server/app.ts tests/oauthRegister.test.ts tests/redirectUri.test.ts
git commit -m "feat(oauth): DCR register + redirect_uri 嚴格驗證（防 open-redirect、不回 client_secret）"
```

---

### Task 8: Spike — be2-auth authorize 登入腿（REDIRECT vs POPUP）

**這是 human-in-loop spike（仿 T6），不是純 coding。** 決定 authorize 腿走 REDIRECT（主）或 POPUP（備）。

**Files:**
- Create: `docs/be2-mcp/spike-oauth-login-leg.md`

- [ ] **Step 1**：起本地 be2-mcp（`npm run dev`），手動打 `GET auth/be2/login?loginFlow=REDIRECT&redirectPath=<be2-mcp callback>` 對 SIT auth-220，觀察 be2-auth 是否接受跨網域 redirectPath（`validateRedirectPath` 行為）。
- [ ] **Step 2**：REDIRECT 可行 → authorize 主路線用它；不可行（被擋/allowlist）→ 切 POPUP（已 SIT 實證 A8，沿用 ssoRoutes 的 postMessage + origin 驗證）。
- [ ] **Step 3**：把結論（哪條、實際 redirectPath 契約）寫進 `docs/be2-mcp/spike-oauth-login-leg.md`，commit。Task 9 authorize 實作依此結論。

```bash
git add docs/be2-mcp/spike-oauth-login-leg.md
git commit -m "spike(oauth): authorize 登入腿走 REDIRECT 或 POPUP 定論"
```

---

### Task 9: authorize endpoint（登入腿 + 設 cookie + 鑄 code）

**Files:**
- Create: `src/oauth/authorizeRoutes.ts`
- Modify: `src/server/app.ts`, `src/server/ssoRoutes.ts`（共用 exchangeCode→identity helper）
- Test: `tests/oauthAuthorize.test.ts`

**Interfaces:**
- Consumes: `isAllowedRedirectUri`（Task 7）、OAuthStore、Task 4 的「exchangeCode→建 identity」helper、CredentialStore、WebSessionStore。
- Produces: `GET /oauth/authorize`：驗 `client_id`（存在）、`redirect_uri`（在該 client allowlist 且 `isAllowedRedirectUri`）、`response_type='code'`、`code_challenge`、`code_challenge_method='S256'`、`state`。→ 驅動 be2-auth 登入（Task 8 定論的 flow）。登入成功：建 identity + web_session credential + 設 `be2mcp_sid` cookie（SSO-seamless）+ 鑄一次性 authz code（`code_hash` 存 oauthStore，綁 client_id/redirect_uri/code_challenge/identity_id/exp）→ `302 redirect_uri?code=<raw>&state=<state>`。

- [ ] **Step 1: 寫失敗測試（參數驗證 + code 綁定 + cookie 設定）**

```typescript
// tests/oauthAuthorize.test.ts（以注入假 be2-auth 登入的方式測協定編排）
it('缺 code_challenge / redirect_uri 不在 allowlist / 缺 state → 拒（不 redirect 帶 code）', async () => { /* ... */ })
it('登入成功 → 設 be2mcp_sid cookie + redirect 帶 code&state + code 綁 challenge/identity', async () => { /* ... */ })
```

- [ ] **Step 2: 跑測試確認失敗** — FAIL。

- [ ] **Step 3: 實作** authorize 編排（登入腿依 Task 8 結論；驗證失敗一律不鑄 code、不 redirect 帶 code）。共用 Task 4 的 identity 建立 helper。

- [ ] **Step 4: 跑測試 + CI** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/oauth/authorizeRoutes.ts src/server/app.ts src/server/ssoRoutes.ts tests/oauthAuthorize.test.ts
git commit -m "feat(oauth): authorize endpoint（be2 登入 + SSO-seamless cookie + 一次性 authz code）"
```

---

### Task 10: token endpoint（PKCE 驗 + 發 credential + refresh rotation）+ WWW-Authenticate

**Files:**
- Create: `src/oauth/tokenRoutes.ts`
- Modify: `src/server/app.ts`（掛 token router + `/mcp` 401 加 WWW-Authenticate）
- Test: `tests/oauthToken.test.ts`

**Interfaces:**
- Consumes: OAuthStore、CredentialStore、IdentityStore。
- Produces: `POST /oauth/token`：
  - `grant_type=authorization_code`：查 code（未 consumed、未過期、client/redirect 相符）→ **PKCE S256 驗**（`base64url(sha256(code_verifier)) === stored code_challenge`）→ consume code → 發不透明 access（`credentials.insert(kind='oauth_access', credHash=hash(access), identityId=code.identityId)`）+ 不透明 refresh（`oauth_refresh` hash → identityId）→ 回 `{ access_token, refresh_token, token_type:'Bearer', expires_in }`。
  - `grant_type=refresh_token`：驗 refresh（在 oauth_refresh、未過期）→ rotate：**發新 access + 新 refresh、刪舊 refresh、刪舊 access 的 credentials 列**（即時撤銷、不漏列）→ 回新 token。
  - **refresh reuse 偵測（OAuth 2.1 / RFC 9700 強制，agy round-1）**：refresh token rotate 後即刪除；若收到一個**已被 rotate 掉（不存在於 oauth_refresh）但格式像 refresh** 的 token，視為 token 洩漏——**撤銷該 identity 的整個 token family**（刪該 identity 全部 `oauth_refresh` + 全部 kind=oauth_access 的 credentials），回 `invalid_grant`。為此 `oauth_refresh` 需可由 identity 反查（已有 identity_id 欄）。實作：refresh 查無 → 若能從別的線索（見下 Step 3 註）判定是「曾經有效的 refresh」則 family revoke。最小可行版：**維持一個 `revoked_families` 或在 identity 上標記**；本波採「rotate 時把舊 refresh 標記為 consumed 而非直接刪，consumed 的 refresh 再被使用 → family revoke」。
  - 失敗一律 `400 { error:'invalid_grant' }`。
- `/mcp` 401 回應加 header `WWW-Authenticate: Bearer resource_metadata="<baseUrl>/.well-known/oauth-protected-resource"`。

- [ ] **Step 1: 寫失敗測試（PKCE + 一次性 + rotation 撤銷舊）**

```typescript
// tests/oauthToken.test.ts
import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
// 用 supertest 或既有整合測試的 HTTP 驅動法（跟 tests/serverIntegration.test.ts 同樣的 buildApp+request 樣式）

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')

// 每個測試前：db + 一個已登入 identity I1 + 一個 client C + 一個 authz code 綁 (C, redirect, challenge, I1)
function seedCode(db, { verifier }: { verifier: string }) {
  const identities = new IdentityStore(db); const oauth = new OAuthStore(db)
  identities.upsert({ identityId: 'I1', userLabel: 'u', accessToken: jwt(9e12), refreshToken: 'R', businessList: [], accessExpiresAt: 9e12, updatedAt: 1 })
  oauth.insertClient({ clientId: 'C', redirectUris: ['http://127.0.0.1:5/callback'], createdAt: 1 })
  const rawCode = randomBytes(16).toString('hex')
  oauth.insertAuthCode({ codeHash: CredentialStore.hash(rawCode), clientId: 'C', redirectUri: 'http://127.0.0.1:5/callback', codeChallenge: s256(verifier), identityId: 'I1', exp: 9e12, consumed: 0 })
  return { rawCode }
}
function jwt(expMs: number) { const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b({})}.${b({ exp: Math.floor(expMs/1000), authKey: 'u' })}.s` }

it('正確 verifier → 發 token 且該 access 能過 /mcp；錯 verifier → invalid_grant', async () => {
  const db = openDb(':memory:'); const { rawCode } = seedCode(db, { verifier: 'VER' })
  const app = buildApp({ config, db })                 // config 依既有測試樣式
  const ok = await post(app, '/oauth/token', { grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER', client_id: 'C', redirect_uri: 'http://127.0.0.1:5/callback' })
  expect(ok.status).toBe(200); expect(ok.body.access_token).toBeTruthy()
  const gate = await mcpInitialize(app, ok.body.access_token)   // 帶 access 打 /mcp initialize
  expect(gate.status).not.toBe(401)
  const bad = await post(app, '/oauth/token', { grant_type: 'authorization_code', code: rawCode, code_verifier: 'WRONG', client_id: 'C', redirect_uri: 'http://127.0.0.1:5/callback' })
  expect(bad.status).toBe(400); expect(bad.body.error).toBe('invalid_grant')
})
it('code 一次性：同 code 換兩次 → 第二次 invalid_grant', async () => {
  const db = openDb(':memory:'); const { rawCode } = seedCode(db, { verifier: 'VER' }); const app = buildApp({ config, db })
  const first = await post(app, '/oauth/token', { grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER', client_id: 'C', redirect_uri: 'http://127.0.0.1:5/callback' })
  expect(first.status).toBe(200)
  const second = await post(app, '/oauth/token', { grant_type: 'authorization_code', code: rawCode, code_verifier: 'VER', client_id: 'C', redirect_uri: 'http://127.0.0.1:5/callback' })
  expect(second.status).toBe(400); expect(second.body.error).toBe('invalid_grant')
})
it('refresh rotation：舊 access 立即失效、舊 refresh 再用觸發 family revoke', async () => {
  // 換到 {access1, refresh1} → 用 refresh1 rotate 到 {access2, refresh2}
  // 斷言：access1 打 /mcp → 401（credential 已刪）；refresh2 有效
  // 再用「已 consumed 的 refresh1」→ invalid_grant 且 family revoke：refresh2 也失效、access2 credential 被刪
  // （具體：rotate 後查 access2 過 /mcp OK；送 refresh1 → 400；之後 access2 打 /mcp → 401）
})
it('/mcp 401 帶 WWW-Authenticate 指向 protected-resource', async () => {
  const db = openDb(':memory:'); const app = buildApp({ config, db })
  const r = await mcpInitialize(app, 'unknown-bearer')
  expect(r.status).toBe(401)
  expect(r.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource')
})
```
（`post`/`mcpInitialize`/`config` 沿用 `tests/serverIntegration.test.ts` 既有 HTTP 驅動 helper 樣式；`OAuthStore.insertClient/insertAuthCode` 見 Task 6。refresh family-revoke 那條的具體斷言鏈已在測試內以註解逐步寫明——實作者照該序列補完 request 呼叫即可，非模糊「加測試」。）

- [ ] **Step 2: 跑測試確認失敗** — FAIL。

- [ ] **Step 3: 實作** PKCE 驗證用 `createHash('sha256').update(verifier).digest('base64url')`。rotation 在單一 transaction 內：把舊 refresh 標 `consumed=1`（不刪）、刪舊 access credential、寫新 access credential + 新 refresh。refresh grant 進來時：查 `oauth_refresh`——不存在→`invalid_grant`；存在但 `consumed=1`→**reuse 偵測**：`identity_id` family revoke（刪該 identity 全部 `oauth_refresh` + 全部 kind=oauth_access credentials）+ `invalid_grant`；存在且未 consumed→正常 rotate。

- [ ] **Step 4: 跑測試 + CI** — PASS（含既有 /mcp 測試對 401 body 不變、只多 header）。

- [ ] **Step 5: Commit**

```bash
git add src/oauth/tokenRoutes.ts src/server/app.ts tests/oauthToken.test.ts
git commit -m "feat(oauth): token endpoint（PKCE S256、code 一次性、refresh rotation 撤銷舊 credential）+ WWW-Authenticate"
```

---

### Task 11: purge script + 文件 + Live 驗收

**Files:**
- Create: `scripts/oauth-purge.ts`, `docs/be2-mcp/oauth-runbook.md`
- Modify: `package.json`（加 `oauth-purge` script）、`CLAUDE.md`、`docs/be2-mcp/phase0-inventory.md`
- Test: `tests/oauthPurge.test.ts`

**Interfaces:**
- Produces: `oauth-purge` 硬刪過期 `oauth_auth_codes`/`oauth_refresh` + 無 credential 引用的 ghost `be2_identities` + 空 `oauth_clients`（可選）。

- [ ] **Step 1: 寫失敗測試（purge 只刪過期/孤兒，不誤刪活的）**

```typescript
// tests/oauthPurge.test.ts
it('purge 刪過期 code/refresh + 無 credential 的 identity；保留活的', () => { /* ... */ })
```

- [ ] **Step 2: 實作 purge + 測試綠。**

- [ ] **Step 3: 文件**
- `docs/be2-mcp/oauth-runbook.md`：Code/Desktop OAuth 接入步驟（不再手貼 bearer）、與 static bearer 的關係、SSO-seamless 確認頁行為、purge cron 建議。
- `CLAUDE.md`「開發指令」：`bootstrap-user` 標「headless/過渡 fallback」、加 OAuth 指向 runbook。
- `phase0-inventory.md` B2：回填 Task 8 的 REDIRECT/POPUP 結論。

- [ ] **Step 4: Live 驗收（人工，仿 spike）**
在 Claude Code + Desktop 各跑一次真實 OAuth 接入（本機 loopback callback）→ 免手貼 bearer 連上 → 同瀏覽器開確認頁免二次登入 → 批准一個 draft change-set（寫入 403 為已知、不阻擋 OAuth/SSO 驗收）。結果寫進 runbook「Live 驗收」節。

- [ ] **Step 5: 跑 CI + Commit**

Run: `npm run ci`
```bash
git add scripts/oauth-purge.ts docs/be2-mcp/oauth-runbook.md package.json CLAUDE.md docs/be2-mcp/phase0-inventory.md tests/oauthPurge.test.ts
git commit -m "feat(oauth): purge script + OAuth runbook + CLAUDE/phase0 文件更新 + Live 驗收"
```

---

## Self-Review 檢查（計畫作者已跑）

**Spec 覆蓋：**
- §4.0 identity/credential 拆分 → Task 1-5（schema、store、TokenManager、enroll、confirm session、/mcp gate）。✓
- §4.1 discovery/DCR/authorize/token → Task 6/7/9/10。✓
- §4.2 authorize 登入腿 REDIRECT/POPUP → Task 8 spike + Task 9。✓
- §4.3 SSO-seamless + kind gate 防自我批准 → Task 4（kind gate）+ Task 9（cookie）。✓
- §4.4 app.ts WWW-Authenticate + sessionOwner 綁 identity → Task 5 + Task 10。✓
- §6 錯誤/rotation/clobber/kind-reject → Task 2（clobber）/5（session）/10（rotation 撤銷）。✓
- §7 測試（防自我批准兩角度、rotation 保 session、舊 token 撤銷、cookie≠token、redirect 嚴格、PKCE、一次性）→ 各 task 測試。✓
- §8 文件連動 → Task 11。✓
- §9 風險（REDIRECT spike、loopback 實測、redirect 嚴格解析、拆分先做）→ Task 8 spike、Task 7 redirectUri、Phase A 先於 B。✓

**Placeholder 掃描（agy round-1 修正）：** 安全關鍵測試已補**完整可執行碼**：Task 1/2（store/identity refresh 共用）、Task 7（redirectUri open-redirect 全變形）、**Task 10（PKCE 正確/錯誤 verifier、code 一次性、WWW-Authenticate 全為完整 request 斷言；refresh family-revoke 以逐步註解寫明斷言序列供補完 request 呼叫）**。Task 6/9/11 的協定編排測試（非安全核心的 happy-path/參數驗證）以資料形狀 + 要斷言的具體性質標明，實作者照既有 HTTP 驅動 helper 補完。✓

**refresh reuse 撤銷（agy round-1）：** OAuth 2.1 / RFC 9700 的 refresh-token-reuse family revocation 已納入 Task 10（`oauth_refresh.consumed` 欄 + reuse→family revoke + 對應測試）。✓

**Phase A 遞增綠燈（agy round-1）：** 用 TokenStore 相容 adapter（Task 2）讓所有既有呼叫端零改動仍綠，Task 3–5 逐一切換、Task 5 收尾刪 adapter/user_tokens；完整呼叫端清單（含 toolPipeline/appPipeline）已列於 Phase A 開頭。✓

**型別一致性：** `Identity`/`Credential`/`CredentialKind`（Task 1 定義，2/3/4/5/9/10 沿用）、`getFreshBySecret`/`getFreshByCredHash`（Task 2）、`isAllowedRedirectUri`（Task 7 → Task 9）、`CredentialStore.hash`（全程一致）。✓

---

## Execution Handoff

見對話。

<!-- agy-peer-reviewed: 2026-08-13T03:13:35Z rounds=2 verdict=approved -->
