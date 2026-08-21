# be2-mcp 登出/撤銷(A2 logout/revoke)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **分工鐵則(memory agy-work-allocation)**:實作(寫 code+測試檔)外包 agy(gemini-3.1-pro-high, `--mode accept-edits`);Claude 只編排、跑測試驗證、commit。agy headless 禁 heredoc/管線/跑測試——測試一律由 Claude 執行。

**Goal:** 給 be2-mcp 補上使用者主動撤銷 OAuth 連線的能力:RFC 7009 `POST /oauth/revoke` + discovery 宣告 + `/confirm/connections`「斷開所有 Claude 連線」頁。

**Architecture:** grant 級撤銷 helper `revokeGrant`(= 既有 refresh-reuse family revoke 形狀:刪 identity 的 `oauth_refresh` 全家 + `oauth_access` credentials、保留 `web_session`、無引用即清 identity)由兩個入口共用:公開的 revoke 端點與登入 gate 後的連線管理頁。`requireSession` 從 confirmRoutes 抽成共用 `sessionGate`。

**Tech Stack:** TypeScript + Express 5 + better-sqlite3 + vitest(既有 stack,零新依賴)。

**Spec:** `docs/superpowers/specs/2026-08-21-be2-mcp-logout-revoke-design.md`(agy approved rounds=2)。

## Global Constraints

- 分支 `feat/logout-revoke`(已從 main 切出);頻繁 commit,訊息中文、conventional prefix。
- token/secret 明文永不落 DB、log、audit(audit 只記 kind 與 hash 前 8 碼)。
- `/oauth/revoke` 一律 200 空 body(除 `token` 缺席 400)——不當存在性 oracle。
- 撤銷絕不碰 `web_session` 與 `static_bearer` credential。
- 不碰 `src/core/`;`app.ts` 的 `purgeCredential` 原樣不動。
- 每個 task 結束 `npm run ci`(typecheck+test)必須全綠才 commit。

---

### Task 1: Store 層薄查詢(4 個新方法)

**Files:**
- Modify: `src/oauth/oauthStore.ts`
- Modify: `src/store/credentialStore.ts`
- Modify: `src/store/identityStore.ts`
- Test: `tests/revocationStores.test.ts`(新檔)

**Interfaces:**
- Produces:
  - `OAuthStore.getRefreshByAccessCredHash(accessCredHash: string): OAuthRefresh | undefined`
  - `OAuthStore.countRefreshByIdentity(identityId: string): number`
  - `CredentialStore.countByIdentityAndKind(identityId: string, kind: CredentialKind): number`
  - `IdentityStore.listByUserLabel(userLabel: string): Identity[]`(`lower(trim())` 兩側正規化比對)

- [ ] **Step 1: 寫失敗測試** — `tests/revocationStores.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import type Database from 'better-sqlite3'

// A2 撤銷功能的 store 層薄查詢(spec §7)。純 SQL 查詢,無業務邏輯。
let db: Database.Database, identities: IdentityStore, credentials: CredentialStore, oauth: OAuthStore
beforeEach(() => {
  db = openDb(':memory:')
  identities = new IdentityStore(db); credentials = new CredentialStore(db); oauth = new OAuthStore(db)
})

const ident = (id: string, label: string) => identities.upsert({
  identityId: id, userLabel: label, accessToken: 'A', refreshToken: 'R',
  businessList: [], accessExpiresAt: 9e12, updatedAt: 1,
})

describe('OAuthStore revocation queries', () => {
  it('getRefreshByAccessCredHash 反查同批核發的 refresh 列;查無回 undefined', () => {
    oauth.insertRefresh({ refreshHash: 'rh1', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 0, accessCredHash: 'ah1' })
    expect(oauth.getRefreshByAccessCredHash('ah1')?.clientId).toBe('C1')
    expect(oauth.getRefreshByAccessCredHash('nope')).toBeUndefined()
  })
  it('countRefreshByIdentity 含 consumed 歷史列', () => {
    oauth.insertRefresh({ refreshHash: 'rh1', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 0 })
    oauth.insertRefresh({ refreshHash: 'rh2', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 1 })
    expect(oauth.countRefreshByIdentity('I1')).toBe(2)
    expect(oauth.countRefreshByIdentity('I2')).toBe(0)
  })
})

describe('CredentialStore.countByIdentityAndKind', () => {
  it('只數指定 kind', () => {
    credentials.insert({ credHash: 'h1', identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
    credentials.insert({ credHash: 'h2', identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 1 })
    expect(credentials.countByIdentityAndKind('I1', 'oauth_access')).toBe(1)
    expect(credentials.countByIdentityAndKind('I1', 'static_bearer')).toBe(0)
  })
})

describe('IdentityStore.listByUserLabel', () => {
  it('大小寫/前後空白正規化比對,不撈別人的', () => {
    ident('I1', 'User@KKday.com'); ident('I2', ' user@kkday.com '); ident('I3', 'other@kkday.com')
    const got = identities.listByUserLabel('user@kkday.com').map(i => i.identityId).sort()
    expect(got).toEqual(['I1', 'I2'])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗** — `npx vitest run tests/revocationStores.test.ts`,預期 FAIL(方法不存在)。
- [ ] **Step 3: 最小實作** — 三個檔各加方法(照各檔既有 row-mapping 風格):

`src/oauth/oauthStore.ts`(把 `getRefresh` 的 row→物件對映抽成私有 `rowToRefresh(r)` 供兩處共用):

```ts
getRefreshByAccessCredHash(accessCredHash: string): OAuthRefresh | undefined {
  const r = this.db.prepare('SELECT * FROM oauth_refresh WHERE access_cred_hash = ?').get(accessCredHash) as Record<string, unknown> | undefined
  return r ? this.rowToRefresh(r) : undefined
}
countRefreshByIdentity(identityId: string): number {
  return (this.db.prepare('SELECT COUNT(*) c FROM oauth_refresh WHERE identity_id = ?').get(identityId) as { c: number }).c
}
```

`src/store/credentialStore.ts`:

```ts
countByIdentityAndKind(identityId: string, kind: CredentialKind): number {
  return (this.db.prepare('SELECT COUNT(*) c FROM credentials WHERE identity_id = ? AND kind = ?').get(identityId, kind) as { c: number }).c
}
```

`src/store/identityStore.ts`(把 `get` 的 row 對映抽成私有 `rowToIdentity(r)` 共用):

```ts
listByUserLabel(userLabel: string): Identity[] {
  const rows = this.db.prepare('SELECT * FROM be2_identities WHERE lower(trim(user_label)) = lower(trim(?))').all(userLabel) as Array<Record<string, unknown>>
  return rows.map(r => this.rowToIdentity(r))
}
```

- [ ] **Step 4: 跑測試確認通過** — `npx vitest run tests/revocationStores.test.ts` PASS,`npm run ci` 全綠。
- [ ] **Step 5: Commit** — `git add src/oauth/oauthStore.ts src/store/credentialStore.ts src/store/identityStore.ts tests/revocationStores.test.ts && git commit -m "feat(revoke): store 層撤銷查詢(refresh 反查/計數/userLabel 列 identity)"`

---

### Task 2: `revokeGrant` 共用 helper

**Files:**
- Create: `src/oauth/revocation.ts`
- Test: `tests/revocation.test.ts`(新檔)

**Interfaces:**
- Consumes: Task 1 的 `countByIdentity`(既有)、`deleteRefreshByIdentity`(既有)、`deleteByIdentityAndKind`(既有)。
- Produces: `revokeGrant(deps: RevocationDeps, identityId: string): { userLabel: string } | undefined`;`RevocationDeps = { oauthStore: OAuthStore; credentials: CredentialStore; identities: IdentityStore }`。

- [ ] **Step 1: 寫失敗測試** — `tests/revocation.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { revokeGrant } from '../src/oauth/revocation.js'
import type Database from 'better-sqlite3'

let db: Database.Database, identities: IdentityStore, credentials: CredentialStore, oauth: OAuthStore
beforeEach(() => {
  db = openDb(':memory:')
  identities = new IdentityStore(db); credentials = new CredentialStore(db); oauth = new OAuthStore(db)
  identities.upsert({ identityId: 'I1', userLabel: 'u@kkday.com', accessToken: 'A', refreshToken: 'R', businessList: [], accessExpiresAt: 9e12, updatedAt: 1 })
  credentials.insert({ credHash: 'acc1', identityId: 'I1', kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  oauth.insertRefresh({ refreshHash: 'rh1', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 0, accessCredHash: 'acc1' })
  oauth.insertRefresh({ refreshHash: 'rh0', identityId: 'I1', clientId: 'C1', exp: 9e12, consumed: 1 })
})
const deps = () => ({ oauthStore: oauth, credentials, identities })

describe('revokeGrant(spec §4.4)', () => {
  it('刪整條 refresh family(含 consumed)+ oauth_access;identity 無引用即清,回 userLabel', () => {
    const out = revokeGrant(deps(), 'I1')
    expect(out?.userLabel).toBe('u@kkday.com')
    expect(oauth.countRefreshByIdentity('I1')).toBe(0)
    expect(credentials.get('acc1')).toBeUndefined()
    expect(identities.get('I1')).toBeUndefined()   // ghost 清掉
  })
  it('同 identity 還有 web_session → credential 與 identity 都保留', () => {
    credentials.insert({ credHash: 'ws1', identityId: 'I1', kind: 'web_session', expiresAt: null, updatedAt: 1 })
    revokeGrant(deps(), 'I1')
    expect(credentials.get('ws1')?.kind).toBe('web_session')
    expect(identities.get('I1')?.userLabel).toBe('u@kkday.com')
    expect(oauth.countRefreshByIdentity('I1')).toBe(0)
  })
  it('static_bearer 不受影響(kind-scoped 刪除)', () => {
    credentials.insert({ credHash: 'sb1', identityId: 'I1', kind: 'static_bearer', expiresAt: null, updatedAt: 1 })
    revokeGrant(deps(), 'I1')
    expect(credentials.get('sb1')?.kind).toBe('static_bearer')
    expect(identities.get('I1')).toBeDefined()
  })
  it('不存在的 identity → 冪等,回 undefined 不炸', () => {
    expect(revokeGrant(deps(), 'nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗** — `npx vitest run tests/revocation.test.ts` FAIL(模組不存在)。
- [ ] **Step 3: 實作** — `src/oauth/revocation.ts`:

```ts
import type { OAuthStore } from './oauthStore.js'
import type { CredentialStore } from '../store/credentialStore.js'
import type { IdentityStore } from '../store/identityStore.js'

export interface RevocationDeps { oauthStore: OAuthStore; credentials: CredentialStore; identities: IdentityStore }

// grant 級撤銷(spec §4.4):一條 OAuth 連線 = 一個 identity,kind-scoped 刪光它的 OAuth 面向
// 憑證即等於 RFC 7009「same authorization grant」語義。web_session / static_bearer 刻意不碰
// (與 tokenRoutes 的 refresh-reuse family revoke 同形狀);identity 列存真實 be2 token,
// 沒有任何 credential 引用時一併清掉(否則成 oauth-purge 要掃的 ghost)。
export function revokeGrant(deps: RevocationDeps, identityId: string): { userLabel: string } | undefined {
  const identity = deps.identities.get(identityId)
  deps.oauthStore.deleteRefreshByIdentity(identityId)
  deps.credentials.deleteByIdentityAndKind(identityId, 'oauth_access')
  if (identity && deps.credentials.countByIdentity(identityId) === 0) deps.identities.delete(identityId)
  return identity ? { userLabel: identity.userLabel } : undefined
}
```

- [ ] **Step 4: 跑測試確認通過** — `npx vitest run tests/revocation.test.ts` PASS。
- [ ] **Step 5: Commit** — `git add src/oauth/revocation.ts tests/revocation.test.ts && git commit -m "feat(revoke): grant 級撤銷 helper revokeGrant"`

---

### Task 3: `POST /oauth/revoke` + discovery 宣告 + app 接線

**Files:**
- Create: `src/oauth/revokeRoutes.ts`
- Modify: `src/oauth/discoveryRoutes.ts`(metadata 加兩欄)
- Modify: `src/server/app.ts`(`buildTokenRouter` 掛載處下一行掛 revoke router)
- Test: `tests/oauthRevoke.test.ts`(新檔)、`tests/oauthDiscovery.test.ts`(補斷言)

**Interfaces:**
- Consumes: Task 1 `getRefreshByAccessCredHash`、Task 2 `revokeGrant`。
- Produces: `buildRevokeRouter(deps: RevokeDeps): express.Router`;`RevokeDeps = { oauthStore; credentials; identities; audit: AuditLog }`。

- [ ] **Step 1: 寫失敗測試** — `tests/oauthRevoke.test.ts`(harness 仿 `tests/oauthToken.test.ts`:`buildApp` + `:memory:` db + fetch;seed 直接用 store)。測試案例對應 spec §9 #1–#9:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

const CONFIG: Config = {
  authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
  serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off', scheduleTz: 'Asia/Taipei',
}
const fakeJwt = () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, authKey: 'u@kkday.com', platformId: 'u' })}.s`
}

// seed 一條完整 OAuth 連線:identity I1 + access(明文 rawAccess) + refresh(明文 rawRefresh)
function seedGrant(db: Database.Database, opts?: { identityId?: string; clientId?: string; withAccessLink?: boolean }) {
  const identityId = opts?.identityId ?? 'I1'
  const clientId = opts?.clientId ?? 'C1'
  const identities = new IdentityStore(db); const oauth = new OAuthStore(db); const creds = new CredentialStore(db)
  identities.upsert({ identityId, userLabel: 'u@kkday.com', accessToken: fakeJwt(), refreshToken: 'R', businessList: [], accessExpiresAt: Date.now() + 3600_000, updatedAt: 1 })
  const rawAccess = `acc-${identityId}`, rawRefresh = `ref-${identityId}`
  const accessCredHash = CredentialStore.hash(rawAccess)
  creds.insert({ credHash: accessCredHash, identityId, kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  oauth.insertRefresh({ refreshHash: CredentialStore.hash(rawRefresh), identityId, clientId, exp: Date.now() + 86400_000, consumed: 0, ...(opts?.withAccessLink === false ? {} : { accessCredHash }) })
  return { identityId, rawAccess, rawRefresh, identities, oauth, creds }
}

let http: Server, base: string, db: Database.Database
beforeEach(async () => {
  db = openDb(':memory:')
  const app = buildApp({ config: CONFIG, db })
  http = createServer(app)
  await new Promise<void>(r => http.listen(0, () => r()))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterEach(() => new Promise<void>(r => http.close(() => { db.close(); r() })))

const revoke = (body: Record<string, unknown>) => fetch(`${base}/oauth/revoke`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

describe('POST /oauth/revoke(RFC 7009,spec §4)', () => {
  it('refresh 撤銷 → 整 family + access 消失、ghost identity 清掉、200 空 body', async () => {
    const g = seedGrant(db)
    const r = await revoke({ token: g.rawRefresh })
    expect(r.status).toBe(200)
    expect(g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
    expect(g.creds.getBySecret(g.rawAccess)).toBeUndefined()
    expect(g.identities.get(g.identityId)).toBeUndefined()
  })
  it('access 撤銷 → 同 grant 級效果(經 accessCredHash 反查 clientId)', async () => {
    const g = seedGrant(db)
    const r = await revoke({ token: g.rawAccess, client_id: 'C1' })
    expect(r.status).toBe(200)
    expect(g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
    expect(g.identities.get(g.identityId)).toBeUndefined()
  })
  it('web_session 同 identity 存在 → 撤銷後 session 與 identity 保留', async () => {
    const g = seedGrant(db)
    g.creds.insert({ credHash: 'ws1', identityId: g.identityId, kind: 'web_session', expiresAt: null, updatedAt: 1 })
    await revoke({ token: g.rawRefresh })
    expect(g.creds.get('ws1')).toBeDefined()
    expect(g.identities.get(g.identityId)).toBeDefined()
  })
  it('unknown token / static_bearer / web_session secret → 200 no-op、store 無變化、無 audit', async () => {
    const g = seedGrant(db)
    g.creds.insert({ credHash: CredentialStore.hash('sb-raw'), identityId: g.identityId, kind: 'static_bearer', expiresAt: null, updatedAt: 1 })
    for (const t of ['garbage', 'sb-raw']) {
      const r = await revoke({ token: t })
      expect(r.status).toBe(200)
    }
    expect(g.creds.getBySecret('sb-raw')).toBeDefined()
    expect(g.oauth.countRefreshByIdentity(g.identityId)).toBe(1)
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tool = 'oauth_revoke'").get()).toEqual({ c: 0 })
  })
  it('token 缺席 → 400 invalid_request', async () => {
    const r = await revoke({})
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('invalid_request')
  })
  it('token_type_hint 給錯(refresh 標成 access_token)→ 仍找到並撤銷', async () => {
    const g = seedGrant(db)
    await revoke({ token: g.rawRefresh, token_type_hint: 'access_token' })
    expect(g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
  })
  it('client_id 不符 → 200 no-op 且 store 無變化;client_id 缺席 → 照撤', async () => {
    const g = seedGrant(db)
    await revoke({ token: g.rawRefresh, client_id: 'WRONG' })
    expect(g.oauth.countRefreshByIdentity(g.identityId)).toBe(1)   // 沒撤
    await revoke({ token: g.rawRefresh })                          // 缺席 → 照撤
    expect(g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
  })
  it('access token 的 family 已亡(refresh 列被 purge)→ 跳過 client 檢查照撤(possession 足矣)', async () => {
    const g = seedGrant(db)
    db.prepare('DELETE FROM oauth_refresh WHERE identity_id = ?').run(g.identityId)   // 模擬 oauth-purge
    const r = await revoke({ token: g.rawAccess, client_id: 'ANYTHING' })
    expect(r.status).toBe(200)
    expect(g.creds.getBySecret(g.rawAccess)).toBeUndefined()
  })
  it('重複撤銷同一顆 → 兩次都 200(冪等)', async () => {
    const g = seedGrant(db)
    expect((await revoke({ token: g.rawRefresh })).status).toBe(200)
    expect((await revoke({ token: g.rawRefresh })).status).toBe(200)
  })
  it('撤銷後:原 access 打 /mcp → 401;原 refresh 打 /oauth/token → invalid_grant', async () => {
    const g = seedGrant(db)
    await revoke({ token: g.rawAccess })
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${g.rawAccess}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    })
    expect(mcp.status).toBe(401)
    const tok = await fetch(`${base}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: g.rawRefresh, client_id: 'C1' }),
    })
    expect(tok.status).toBe(400)
    expect(((await tok.json()) as { error: string }).error).toBe('invalid_grant')
  })
  it('audit:命中記一筆(tool=oauth_revoke),params 無 token 明文', async () => {
    const g = seedGrant(db)
    await revoke({ token: g.rawRefresh, client_id: 'C1' })
    const row = db.prepare("SELECT * FROM audit_log WHERE tool = 'oauth_revoke'").get() as { user_label: string; params_json: string }
    expect(row.user_label).toBe('u@kkday.com')
    expect(row.params_json).not.toContain(g.rawRefresh)
    expect(row.params_json).toContain('refresh_token')
  })
  it('urlencoded form body 也吃(真實 OAuth client 慣例)', async () => {
    const g = seedGrant(db)
    const r = await fetch(`${base}/oauth/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(g.rawRefresh)}`,
    })
    expect(r.status).toBe(200)
    expect(g.oauth.countRefreshByIdentity(g.identityId)).toBe(0)
  })
})
```

`tests/oauthDiscovery.test.ts` 補斷言(併入既有 authorization-server metadata 測試或新增一條):

```ts
it('宣告 revocation_endpoint(RFC 8414)', async () => {
  const r = await fetch(`${base}/.well-known/oauth-authorization-server`)
  const meta = (await r.json()) as Record<string, unknown>
  // 注意:測試 config.port=0,server 內部 baseUrl 是 http://127.0.0.1:0(≠ 實際隨機 listening
  // port)——斷言必須錨定 meta.issuer 而非 harness 的 base,比照該檔既有測試做法。
  expect(meta.revocation_endpoint).toBe(`${meta.issuer}/oauth/revoke`)
  expect(meta.revocation_endpoint_auth_methods_supported).toEqual(['none'])
})
```

- [ ] **Step 2: 跑測試確認失敗** — `npx vitest run tests/oauthRevoke.test.ts tests/oauthDiscovery.test.ts` FAIL(404 / 欄位缺)。
- [ ] **Step 3: 實作** — `src/oauth/revokeRoutes.ts`:

```ts
import express from 'express'
import type { OAuthStore } from './oauthStore.js'
import { CredentialStore } from '../store/credentialStore.js'
import type { IdentityStore } from '../store/identityStore.js'
import type { AuditLog } from '../audit/auditLog.js'
import { revokeGrant } from './revocation.js'

// RFC 7009 token revocation(spec §4)。公開端點:public client 以「持有 token」為授權,
// 回應絕不洩漏 token 是否存在(查無/歸屬不符一律 200 空 body)。撤銷語義 = grant 級
// (revokeGrant),與 tokenRoutes 的 refresh-reuse family revoke 同形狀。
export interface RevokeDeps { oauthStore: OAuthStore; credentials: CredentialStore; identities: IdentityStore; audit: AuditLog }

export function buildRevokeRouter(deps: RevokeDeps): express.Router {
  const r = express.Router()
  r.use(express.urlencoded({ extended: false }))
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  r.post('/oauth/revoke', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const token = str(body.token)
    if (!token) { res.status(400).json({ error: 'invalid_request' }); return }
    const hint = str(body.token_type_hint)
    const clientId = str(body.client_id)
    const hash = CredentialStore.hash(token)

    // hint 只是查找順序;一種查無必須擴大到另一種(RFC 7009 §2.1)。
    let identityId: string | undefined
    let kind: 'refresh_token' | 'access_token' | undefined
    let boundClientId: string | undefined
    const tryRefresh = (): boolean => {
      const row = deps.oauthStore.getRefresh(hash)   // consumed / 過期列照樣命中:撤銷冪等無害
      if (!row) return false
      identityId = row.identityId; kind = 'refresh_token'; boundClientId = row.clientId
      return true
    }
    const tryAccess = (): boolean => {
      const cred = deps.credentials.get(hash)
      if (!cred || cred.kind !== 'oauth_access') return false   // static_bearer/web_session 一律視為 unknown
      identityId = cred.identityId; kind = 'access_token'
      // family 已亡(如 oauth-purge 刪了過期 refresh)→ 反查不到 clientId → 跳過歸屬檢查,
      // possession 足矣(spec §4.3,agy round-2 conceded 的真實生產路徑)。
      boundClientId = deps.oauthStore.getRefreshByAccessCredHash(cred.credHash)?.clientId
      return true
    }
    const found = hint === 'access_token' ? (tryAccess() || tryRefresh()) : (tryRefresh() || tryAccess())

    if (!found) { res.status(200).end(); return }                                     // 不當存在性 oracle
    if (clientId && boundClientId && boundClientId !== clientId) { res.status(200).end(); return }  // 歸屬不符=視為 unknown

    const revoked = revokeGrant(deps, identityId!)
    deps.audit.record({
      userLabel: revoked?.userLabel ?? 'unknown', sessionId: '-', clientInfo: 'oauth-revoke',
      tool: 'oauth_revoke', params: { kind, client_id: clientId || undefined, cred_hash_prefix: hash.slice(0, 8) },
      status: 'ok', traceId: '-', durationMs: 0,
    })
    res.status(200).end()
  })
  return r
}
```

`src/oauth/discoveryRoutes.ts` 的 authorization-server JSON 加:

```ts
revocation_endpoint: `${baseUrl}/oauth/revoke`,
revocation_endpoint_auth_methods_supported: ['none'],
```

`src/server/app.ts` 在 `app.use(buildTokenRouter(...))` 下一行:

```ts
// A2:RFC 7009 revocation——公開端點,與 token endpoint 同姿態(public client 持有 token 即授權)。
app.use(buildRevokeRouter({ oauthStore, credentials, identities, audit }))
```

(import:`import { buildRevokeRouter } from '../oauth/revokeRoutes.js'`)

- [ ] **Step 4: 跑測試確認通過** — `npx vitest run tests/oauthRevoke.test.ts tests/oauthDiscovery.test.ts` PASS,`npm run ci` 全綠。
- [ ] **Step 5: Commit** — `git add src/oauth/revokeRoutes.ts src/oauth/discoveryRoutes.ts src/server/app.ts tests/oauthRevoke.test.ts tests/oauthDiscovery.test.ts && git commit -m "feat(revoke): RFC 7009 POST /oauth/revoke + discovery 宣告 revocation_endpoint"`

---

### Task 4: `requireSession` 抽成共用 `sessionGate`(純重構,行為不變)

**Files:**
- Create: `src/server/sessionGate.ts`
- Modify: `src/server/confirmRoutes.ts`(刪本地 `requireSession`,改 import;呼叫處 `requireSession(req)` → `requireSession(gateDeps, req)`)
- Test: 無新測試——**既有 `tests/confirmRoutes*.test.ts` 全綠即為行為不變證明**(spec §9 #16)。

**Interfaces:**
- Produces:

```ts
export interface SessionGateDeps { webSessions: WebSessionStore; credentials: CredentialStore; tokenManager: TokenManager }
export interface SessionUser { sessionId: string; userLabel: string; accessToken: string; identityId: string }
export async function requireSession(deps: SessionGateDeps, req: express.Request): Promise<SessionUser | undefined>
```

- [ ] **Step 1: 搬移** — 把 `confirmRoutes.ts` 66–100 行的 `requireSession` **原文**(含全部註解)搬到 `src/server/sessionGate.ts`,只改:`deps.webSessions/credentials/tokenManager` 引用改走參數 `deps`;**相依 import 一併搬**(`parseCookies` 自 `./cookies.js`、`WebSessionStore`/`CredentialStore`/`TokenManager` 型別 import);檔頭加一句說明「confirmRoutes 與 ssoRoutes 共用的 web-session 登入 gate(kind gate + 死 session 清理 + touch),自 confirmRoutes 抽出,行為不變」。confirmRoutes 若因此不再用到 `parseCookies` 則移除該 import(以 `npm run ci` 的 typecheck 為準)。
- [ ] **Step 2: confirmRoutes 改用** — 刪本地函式,`import { requireSession } from './sessionGate.js'`,**四個**呼叫處(GET `/confirm/:id`、POST approve、POST cancel、POST reject)改 `await requireSession({ webSessions: deps.webSessions, credentials: deps.credentials, tokenManager: deps.tokenManager }, req)`(可先在 router 頂部宣告一次 `gateDeps` 常數共用)。
- [ ] **Step 3: 驗證行為不變** — `npm run ci` 全綠(特別看 `confirmRoutes*.test.ts`、`phase2bSecurity.test.ts`)。
- [ ] **Step 4: Commit** — `git add src/server/sessionGate.ts src/server/confirmRoutes.ts && git commit -m "refactor(confirm): requireSession 抽成共用 sessionGate(行為不變)"`

---

### Task 5: `/confirm/connections` 連線管理頁(GET + POST revoke-all)

**Files:**
- Modify: `src/server/ssoRoutes.ts`(`SsoDeps` 增 4 個 dep + 兩條路由)
- Modify: `src/server/app.ts`(`buildSsoRouter` 呼叫處補傳 `oauthStore, tokenManager, audit, baseOrigin: baseUrl`)
- Test: `tests/confirmConnections.test.ts`(新檔)

**Interfaces:**
- Consumes: Task 1 全部查詢、Task 2 `revokeGrant`、Task 4 `requireSession`。
- Produces: `SsoDeps` 新增 `oauthStore: OAuthStore; tokenManager: TokenManager; audit: AuditLog; baseOrigin: string`(既有欄位不動)。

- [ ] **Step 1: 寫失敗測試** — `tests/confirmConnections.test.ts`。harness 用 **`buildApp` 全 app**(路由順序「ssoRoutes 先於 confirmRoutes 的 `/confirm/:id`」本身是被測行為),seed 直接操作 store;登入 cookie 直接鑄:`credentials.insert(kind='web_session', credHash=hash(sid))` + `webSessions.create(sid, identityId)`,request 帶 `cookie: be2mcp_sid=<sid>`。`tokenManager.getFreshByCredHash` 走真實路徑會打 auth-service——**seed 的 identity `accessExpiresAt` 給未來時間**(不觸發 refresh,直接回 store 內 token),與既有 confirmRoutes 測試同做法。測試案例對應 spec §9 #10–#16:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

const CONFIG: Config = {
  authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
  serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off', scheduleTz: 'Asia/Taipei',
}
const fakeJwt = (authKey: string) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, authKey, platformId: 'u' })}.s`
}

let http: Server, base: string, db: Database.Database
let identities: IdentityStore, oauth: OAuthStore, creds: CredentialStore, webSessions: WebSessionStore

function seedIdentity(id: string, label: string) {
  identities.upsert({ identityId: id, userLabel: label, accessToken: fakeJwt(label), refreshToken: 'R', businessList: [], accessExpiresAt: Date.now() + 3600_000, updatedAt: 1 })
}
// 一條 OAuth 連線 = identity + oauth_access + oauth_refresh
function seedConnection(id: string, label: string) {
  seedIdentity(id, label)
  creds.insert({ credHash: `acc-${id}`, identityId: id, kind: 'oauth_access', expiresAt: null, updatedAt: 1 })
  oauth.insertRefresh({ refreshHash: `ref-${id}`, identityId: id, clientId: 'C1', exp: Date.now() + 86400_000, consumed: 0, accessCredHash: `acc-${id}` })
}
// 已登入的 web session(確認頁身分)
function seedSession(sid: string, identityId: string) {
  creds.insert({ credHash: CredentialStore.hash(sid), identityId, kind: 'web_session', expiresAt: null, updatedAt: 1 })
  webSessions.create(sid, identityId)
}

beforeEach(async () => {
  db = openDb(':memory:')
  identities = new IdentityStore(db); oauth = new OAuthStore(db); creds = new CredentialStore(db)
  webSessions = new WebSessionStore(db)
  const app = buildApp({ config: CONFIG, db })
  http = createServer(app)
  await new Promise<void>(r => http.listen(0, () => r()))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterEach(() => new Promise<void>(r => http.close(() => { db.close(); r() })))

const get = (cookie?: string) => fetch(`${base}/confirm/connections`, { redirect: 'manual', headers: cookie ? { cookie } : {} })
// 關鍵:server 端 baseOrigin 由 config.port=0 組成 = 'http://127.0.0.1:0',與 harness 的實際
// 隨機 listening port(base)不同。合法 Origin 測試一律送 SERVER_ORIGIN;harness 的 base 反而
// 是「同 host 異 port」的天然錯誤樣本。
const SERVER_ORIGIN = 'http://127.0.0.1:0'
const post = (cookie: string, origin?: string) => fetch(`${base}/confirm/connections/revoke-all`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, ...(origin ? { origin } : {}) },
})

describe('/confirm/connections(spec §6)', () => {
  it('未登入 GET → 302 到 /confirm/login,next=/confirm/connections', async () => {
    const r = await get()
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe(`/confirm/login?next=${encodeURIComponent('/confirm/connections')}`)
  })
  it('登入後 GET → 只列同 userLabel 的連線(含另一 identity、大小寫差異),不列別人的、不列純 web_session 的', async () => {
    seedConnection('I1', 'u@kkday.com')
    seedConnection('I2', 'U@KKday.com ')       // 同人,大小寫/空白差異
    seedConnection('I9', 'other@kkday.com')    // 別人
    seedIdentity('I3', 'u@kkday.com')          // 同人但無 oauth 憑證 → 非連線
    seedSession('sid1', 'I1')
    const r = await get('be2mcp_sid=sid1')
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html.match(/data-conn=/g)?.length).toBe(2)   // I1 + I2
    expect(html).toContain('斷開所有 Claude 連線')
    expect(html).toContain('static bearer')             // 邊界文案(spec §6.2)
  })
  it('POST 無 Origin → 403;同 host 異 port Origin(含 harness 實際 port)→ 403;store 無變化', async () => {
    seedConnection('I1', 'u@kkday.com'); seedSession('sid1', 'I1')
    expect((await post('be2mcp_sid=sid1')).status).toBe(403)
    expect((await post('be2mcp_sid=sid1', 'http://127.0.0.1:9999')).status).toBe(403)
    expect((await post('be2mcp_sid=sid1', base)).status).toBe(403)   // harness 的實際 port ≠ server baseOrigin
    expect(oauth.countRefreshByIdentity('I1')).toBe(1)
  })
  it('POST 未登入(正確 Origin)→ 403', async () => {
    expect((await post('be2mcp_sid=nope', SERVER_ORIGIN)).status).toBe(403)
  })
  it('正確 Origin POST → 撤同 userLabel 全部連線、303 PRG、web session 仍活、別人/static_bearer 不動', async () => {
    seedConnection('I1', 'u@kkday.com')
    seedConnection('I2', 'U@KKday.com ')
    seedConnection('I9', 'other@kkday.com')
    creds.insert({ credHash: 'sb1', identityId: 'I1', kind: 'static_bearer', expiresAt: null, updatedAt: 1 })
    seedSession('sid1', 'I1')
    const r = await post('be2mcp_sid=sid1', SERVER_ORIGIN)
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe('/confirm/connections?revoked=2')
    expect(oauth.countRefreshByIdentity('I1')).toBe(0)
    expect(oauth.countRefreshByIdentity('I2')).toBe(0)
    expect(oauth.countRefreshByIdentity('I9')).toBe(1)          // 別人不動
    expect(creds.get('sb1')).toBeDefined()                      // static_bearer 不動
    const again = await get('be2mcp_sid=sid1')                  // session 仍登入
    expect(again.status).toBe(200)
    expect((await again.text())).toContain('已斷開 2 條')
    // I2 成 ghost 被清、I1 因 web_session/static_bearer 引用而保留
    expect(identities.get('I2')).toBeUndefined()
    expect(identities.get('I1')).toBeDefined()
  })
  it('稽核:逐連線記 tool=confirm_connections_revoke_all', async () => {
    seedConnection('I1', 'u@kkday.com'); seedConnection('I2', 'u@kkday.com'); seedSession('sid1', 'I1')
    await post('be2mcp_sid=sid1', SERVER_ORIGIN)
    const n = (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tool = 'confirm_connections_revoke_all'").get() as { c: number }).c
    expect(n).toBe(2)
  })
  it('revoked 參數注入 → 非 \\d{1,4} 不渲染訊息', async () => {
    seedConnection('I1', 'u@kkday.com'); seedSession('sid1', 'I1')
    const r = await fetch(`${base}/confirm/connections?revoked=<script>`, { headers: { cookie: 'be2mcp_sid=sid1' } })
    const html = await r.text()
    expect(html).not.toContain('<script>已斷開')
    expect(html).not.toContain('已斷開 <')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗** — `npx vitest run tests/confirmConnections.test.ts` FAIL(404)。
- [ ] **Step 3: 實作** — `src/server/ssoRoutes.ts`:

`SsoDeps` 增欄位(import 對應型別;`AuditLog` 自 `../audit/auditLog.js`、`OAuthStore` 自 `../oauth/oauthStore.js`、`TokenManager` 自 `../auth/tokenManager.js`):

```ts
export interface SsoDeps {
  authServiceClient: AuthServiceClient; identities: IdentityStore; credentials: CredentialStore; webSessions: WebSessionStore
  authOrigin: string; now: () => number
  // A2(spec §7 接線):連線管理頁需要 —— oauthStore(連線判定/撤銷)、tokenManager(sessionGate)、
  // audit(逐連線稽核)、baseOrigin(revoke-all 的 CSRF Origin 檢查基準)。
  oauthStore: OAuthStore; tokenManager: TokenManager; audit: AuditLog; baseOrigin: string
}
```

路由(放在 `/confirm/login` 之後、`return r` 之前;`import { requireSession } from './sessionGate.js'`、`import { revokeGrant } from '../oauth/revocation.js'`、`import { esc } from '../core/changeset/html.js'`):

```ts
const gateDeps = () => ({ webSessions: deps.webSessions, credentials: deps.credentials, tokenManager: deps.tokenManager })
// 「Claude 連線」定義(spec §6.1):有至少一顆 oauth_access 或至少一列 oauth_refresh 的 identity。
const isConnection = (identityId: string): boolean =>
  deps.oauthStore.countRefreshByIdentity(identityId) > 0 ||
  deps.credentials.countByIdentityAndKind(identityId, 'oauth_access') > 0
const listConnections = (userLabel: string) =>
  deps.identities.listByUserLabel(userLabel).filter(i => isConnection(i.identityId))

r.get('/confirm/connections', h(async (req, res) => {
  const who = await requireSession(gateDeps(), req)
  if (!who) { res.redirect(302, `/confirm/login?next=${encodeURIComponent('/confirm/connections')}`); return }
  const conns = listConnections(who.userLabel)
  const revokedRaw = String(req.query.revoked ?? '')
  const notice = /^\d{1,4}$/.test(revokedRaw) ? `<p style="color:green">已斷開 ${revokedRaw} 條 Claude 連線。</p>` : ''
  const rows = conns.map(c =>
    `<li data-conn="${esc(c.identityId)}">連線(最後活動 ${esc(new Date(c.updatedAt).toISOString())})</li>`).join('')
  res.status(200).send(`<!doctype html><meta charset=utf-8><title>Claude 連線管理</title>
<body style="font-family:sans-serif;max-width:640px;margin:2rem auto">
<h1>Claude 連線管理</h1>
<p>帳號:${esc(who.userLabel)}</p>${notice}
<p>目前共 ${conns.length} 條 Claude 連線:</p><ul>${rows}</ul>
<form method="post" action="/confirm/connections/revoke-all">
  <button type="submit" ${conns.length === 0 ? 'disabled' : ''}>斷開所有 Claude 連線</button></form>
<p style="opacity:.7;font-size:.9em">斷開後 Claude 端需重新走 OAuth 登入;headless static bearer 不受此操作影響。</p>
</body>`)
}))

r.post('/confirm/connections/revoke-all', h(async (req, res) => {
  // CSRF(spec §6.2):SameSite 對 127.0.0.1 不分 port,同機異 port 可跨站 POST 這條固定路徑,
  // 故要求 Origin 存在且完全等於自身 origin;絕不 fallback 到 Referer。
  if (req.header('origin') !== deps.baseOrigin) { res.status(403).send('forbidden'); return }
  const who = await requireSession(gateDeps(), req)
  if (!who) { res.status(403).send('forbidden'); return }
  let n = 0
  for (const conn of listConnections(who.userLabel)) {
    revokeGrant({ oauthStore: deps.oauthStore, credentials: deps.credentials, identities: deps.identities }, conn.identityId)
    deps.audit.record({
      userLabel: who.userLabel, sessionId: who.sessionId, clientInfo: 'confirm-connections',
      tool: 'confirm_connections_revoke_all', params: { identity_id: conn.identityId },
      status: 'ok', traceId: '-', durationMs: 0,
    })
    n++
  }
  res.redirect(303, `/confirm/connections?revoked=${n}`)
}))
```

`src/server/app.ts` 的 `buildSsoRouter` 呼叫處改:

```ts
app.use(buildSsoRouter({ authServiceClient, identities, credentials, webSessions, authOrigin, now: Date.now, oauthStore, tokenManager, audit, baseOrigin: baseUrl }))
```

(注意 `baseUrl` 常數宣告在此呼叫之前,直接可用。)

同時修 `tests/ssoRoutes.test.ts`、`tests/ssoIdentity.test.ts` 等直接呼叫 `buildSsoRouter` 的既有測試:beforeEach 補傳新 deps(`oauthStore: new OAuthStore(db)`、`tokenManager` 可用 `{ getFreshByCredHash: async () => { throw new Error('unused') } } as never` 之類的 stub——既有測試不經 sessionGate,不會真的呼叫;`audit: new AuditLog(db)`、`baseOrigin: 'http://127.0.0.1:1'`)。

- [ ] **Step 4: 跑測試確認通過** — `npx vitest run tests/confirmConnections.test.ts tests/ssoRoutes.test.ts` PASS,`npm run ci` 全綠。
- [ ] **Step 5: Commit** — `git add src/server/ssoRoutes.ts src/server/app.ts tests/confirmConnections.test.ts tests/ssoRoutes.test.ts tests/ssoIdentity.test.ts && git commit -m "feat(revoke): /confirm/connections 連線管理頁(Origin CSRF gate + PRG + 逐連線稽核)"`

---

### Task 6: 文件收尾 + 全量驗證

**Files:**
- Modify: `docs/be2-mcp/oauth-runbook.md`(「Token 生命週期治理」節後加「使用者主動撤銷(A2)」小節)
- Test: `npm run ci` 全量。

- [ ] **Step 1: runbook 補節** — 在 `oauth-runbook.md` 的 oauth-purge 節之後加:

```markdown
## 使用者主動撤銷(A2,2026-08-21)

兩個入口,同一個 grant 級撤銷語義(`src/oauth/revocation.ts` 的 `revokeGrant`:刪該 identity 的
oauth_refresh 全家 + oauth_access credentials;web_session/static_bearer 不碰;identity 無引用即清):

1. **RFC 7009 `POST /oauth/revoke`**(公開端點,discovery 已宣告 `revocation_endpoint`):
   `token`(必填,access/refresh 皆可)、`token_type_hint`/`client_id` 選填。一律 200 空 body
   (不洩漏 token 存在性);`client_id` 有給且與紀錄不符視為 unknown(no-op)。
2. **`/confirm/connections` 連線管理頁**:be2-auth SSO 登入後,列出同一 be2 帳號名下所有
   Claude 連線,「斷開所有 Claude 連線」一鍵全撤(POST 有 Origin 同源檢查擋 localhost CSRF)。

撤銷後的 client 端行為:Claude Code/Desktop 快取的 token 下次 tool call 撞 401 →
依 `WWW-Authenticate` 自動重走 OAuth(需重新登入 be2)。DCR client 紀錄不受影響。
邊界:這不等於 be2-web SSO 登出——auth-service 端 JWT 在 TTL(~50min)內仍有效;
headless static bearer 也不受影響(生命週期歸 `bootstrap-user`/ops 管)。
```

- [ ] **Step 2: 全量驗證** — `npm run ci` 全綠;`npm run build-ui` 若 ci 未涵蓋則跑一次確認面板資產不受影響(本案未動 UI 資產,預期綠)。
- [ ] **Step 3: Commit** — `git add docs/be2-mcp/oauth-runbook.md && git commit -m "docs(runbook): A2 使用者主動撤銷章節"`

---

## Self-Review(已跑)

1. **Spec coverage**:§4(Task 3)、§5(Task 3)、§6(Task 5)、§7 store(Task 1)+ helper(Task 2)+ 接線(Task 3/5)+ sessionGate(Task 4)、§9 測試 #1–#9(Task 3)#10–#16(Task 4/5)、§8 邊界(Task 6 runbook)。無缺。
2. **Placeholder scan**:無 TBD/TODO;每步有完整程式碼。
3. **Type consistency**:`revokeGrant(deps, identityId)` 簽名 Task 2 定義、Task 3/5 使用一致;`SessionUser`/`SessionGateDeps` Task 4 定義、Task 5 使用一致;`RevokeDeps`/`SsoDeps` 欄位與 app.ts 接線一致。

<!-- agy-peer-reviewed: 2026-08-21T05:46:07Z rounds=2 verdict=approved -->
