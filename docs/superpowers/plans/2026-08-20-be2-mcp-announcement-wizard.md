# 商品公告進 wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「商品公告」接成 be2 MCP 的新 `action_type = announcement`（首發動作 = 建立公告 create），透過專用 wizard 面板「選商品 → 填公告 → 批准」。

**Architecture:** registry-driven ActionModule（一包 `src/modules/announcement/create/`）+ module-local svc-b2c HTTP client（不碰 core `GatewayClient`）+ 獨立入口 `be2_open_announcement_wizard` + 專用建立表單面板 `announcement-wizard.html`。除 `types.ts` union、`modules/index.ts` 註冊、UI/resource 佈線外不碰 core。

**Tech Stack:** TypeScript (ESM, `.js` import 後綴)、zod、vitest、esbuild（build:ui）、Node crypto。

## Global Constraints

- **語言**：程式碼英文；註解/文件繁體中文。
- **import 後綴**：一律 `.js`（ESM）。
- **不碰 core**：不改 `src/core/changeset/{tools,executor,confirmService,registry,module,store,diff}.ts`、`src/server/confirmRoutes.ts`、`src/gateway/client.ts`、`src/tools/batchView.ts`、`src/ui/batch-wizard.ts`（後者是 Session 2 主戰場）。唯一 core 觸點 = `src/core/changeset/types.ts` union 擴充。
- **憑證**：從 `.env` / `process.env` 讀，永不 commit、永不印出。
- **成功契約（svc-b2c）**：HTTP 200 **且** `metadata.status === '0000'`；其餘一律失敗、逐字回報、不自動重試。
- **user-uuid header**：= JWT `platformId`，由 `accessToken` 自解（讀寫三處統一）。
- **modify_user（write body）**：= JWT `platformId`（同 user-uuid 值）。
- **itemKey**：server 與 UI 必須同一函式；用 `[...prod_oids].sort()` 非就地 mutate。
- **draft-only**：module 只 stage/execute change-set，批准仍走 nonce（面板）或 SSO 確認頁；live 寫入卡 svc-b2c S2S 403（build+draft 可，live 待授權，非阻擋）。
- **測試指令**：單一檔 `npx vitest run <path>`；全套 `npm run ci`（typecheck + test）。

---

## 檔案結構

**新增**
- `src/modules/announcement/create/keys.ts` — itemKey（isomorphic）
- `src/modules/announcement/create/userUuid.ts` — `decodePlatformId(accessToken)`
- `src/modules/announcement/create/svcB2cClient.ts` — svc-b2c HTTP client（POST/GET、0000 envelope、header）
- `src/modules/announcement/create/validate.ts` — schema-外語義驗證
- `src/modules/announcement/create/diff.ts` — computeDiff（讀商品名 + 既有公告數，降級）
- `src/modules/announcement/create/executor.ts` — POST create、per-item ItemResult
- `src/modules/announcement/create/renderer.ts` — renderConfirm（確認頁 HTML）
- `src/modules/announcement/create/module.ts` — 組 ActionModule
- `src/tools/openAnnouncementWizard.ts` — model-visible 入口
- `src/ui/announcement-wizard.ts` + `src/ui/announcement-wizard.html` — 面板
- 對應 `tests/**`

**修改（非 core）**
- `src/core/changeset/types.ts` — union + 2 interface（onboarding 允許）
- `src/modules/index.ts` — 註冊
- `src/tools/appTools.ts` — 加 `appGetAnnouncementViewTool` 進 `APP_TOOLS`
- `src/server/app.ts` — `TOOLS` 加 `openAnnouncementWizardTool`
- `src/ui/changeset-panel.ts` — `itemKeyOf` 加 announcement 分支（§5.9）
- `src/server/appResources.ts` PANELS、`scripts/build-ui.mjs` entries、`src/server/devPanelRoutes.ts` ALLOWED_PANELS — 佈線
- `tests/core/moduleConformance.test.ts` — 加 announcement diff 樣本

---

### Task 1: types union + itemKey

**Files:**
- Modify: `src/core/changeset/types.ts`
- Create: `src/modules/announcement/create/keys.ts`
- Test: `tests/announcement/keys.test.ts`

**Interfaces:**
- Produces: `AnnouncementLangContent`, `AnnouncementCreateItem`, `AnnouncementDiffItem`（型別）；`itemKey(item): string`。

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/keys.test.ts
import { describe, it, expect } from 'vitest'
import { itemKey } from '../../src/modules/announcement/create/keys.js'
import type { AnnouncementCreateItem } from '../../src/core/changeset/types.js'

const base: AnnouncementCreateItem = {
  prod_oids: ['7781', '16384'], name: '颱風公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'x' }],
}

describe('announcement itemKey', () => {
  it('is stable and order-independent on prod_oids', () => {
    const k1 = itemKey(base)
    const k2 = itemKey({ ...base, prod_oids: ['16384', '7781'] })
    expect(k1).toBe('announce:颱風公告:16384,7781:2026-09-01 00:00:00')
    expect(k2).toBe(k1)
  })
  it('does not mutate the input prod_oids array', () => {
    const item = { ...base, prod_oids: ['b', 'a'] }
    itemKey(item)
    expect(item.prod_oids).toEqual(['b', 'a'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/keys.test.ts`
Expected: FAIL — module `keys.js` / type not found.

- [ ] **Step 3: Add types + implement keys**

在 `src/core/changeset/types.ts`：union `ActionType` 尾端加 `| 'announcement'`；`AnyChangeSetItem` 加 `| AnnouncementCreateItem`；`AnyDiffItem` 加 `| AnnouncementDiffItem`。並新增 interface（放在 `ShelfScheduleDiffItem` 之後、`AnyDiffItem` 之前）：

```ts
export interface AnnouncementLangContent { lang: string; content: string }

export interface AnnouncementCreateItem {
  prod_oids: string[]
  name: string
  is_enabled: boolean
  start_time: string          // "YYYY-MM-DD HH:mm:ss" UTC+0
  end_time?: string | null
  langs: string[]
  contents: AnnouncementLangContent[]
}

export interface AnnouncementDiffItem {
  prod_oids: string[]
  product_names: string[]
  name: string
  is_enabled: boolean
  start_time: string
  end_time?: string | null
  langs: string[]
  contents: AnnouncementLangContent[]  // 帶進 diff 供確認頁預覽內文（防 blind write）
  existing_count: number
  noop: false
}
```

```ts
// src/modules/announcement/create/keys.ts
import type { AnnouncementCreateItem } from '../../../core/changeset/types.js'

// isomorphic（UI 與 server 共用）。用 [...].sort() 複製後排序，不 mutate 原 prod_oids。
export function itemKey(item: AnnouncementCreateItem): string {
  return `announce:${item.name}:${[...item.prod_oids].sort().join(',')}:${item.start_time}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/announcement/keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/changeset/types.ts src/modules/announcement/create/keys.ts tests/announcement/keys.test.ts
git commit -m "feat(announcement): types union + isomorphic itemKey"
```

---

### Task 2: decodePlatformId（user-uuid 來源）

**Files:**
- Create: `src/modules/announcement/create/userUuid.ts`
- Test: `tests/announcement/userUuid.test.ts`

**Interfaces:**
- Produces: `decodePlatformId(accessToken: string): string`（fail-closed，缺 platformId 即 throw `AppError('MODIFY_USER_UNRESOLVED', ...)`）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/userUuid.test.ts
import { describe, it, expect } from 'vitest'
import { decodePlatformId } from '../../src/modules/announcement/create/userUuid.js'

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

describe('decodePlatformId', () => {
  it('extracts platformId claim', () => {
    expect(decodePlatformId(jwt({ platformId: 'f7965b8d-abc' }))).toBe('f7965b8d-abc')
  })
  it('throws when platformId missing', () => {
    expect(() => decodePlatformId(jwt({ sub: 'x' }))).toThrow(/platformId/)
  })
  it('throws on malformed token', () => {
    expect(() => decodePlatformId('not-a-jwt')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/userUuid.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/modules/announcement/create/userUuid.ts
import { AppError } from '../../../errors.js'

// user-uuid header = JWT platformId claim（§3 契約）。語義同 src/server/app.ts#modifyUserFromToken，
// 但獨立於 module 內、不跨 server→module import。fail-closed：解不出 platformId 一律 throw。
export function decodePlatformId(accessToken: string): string {
  const parts = accessToken.split('.')
  if (parts.length !== 3) {
    throw new AppError('MODIFY_USER_UNRESOLVED', 'access token is not a JWT', 500)
  }
  let payload: { platformId?: string }
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new AppError('MODIFY_USER_UNRESOLVED', 'access token payload not decodable', 500)
  }
  if (!payload.platformId) {
    throw new AppError('MODIFY_USER_UNRESOLVED', 'access token missing platformId claim', 500)
  }
  return payload.platformId
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/announcement/userUuid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/announcement/create/userUuid.ts tests/announcement/userUuid.test.ts
git commit -m "feat(announcement): decodePlatformId for user-uuid header"
```

---

### Task 3: svc-b2c client

**Files:**
- Create: `src/modules/announcement/create/svcB2cClient.ts`
- Test: `tests/announcement/svcB2cClient.test.ts`

**Interfaces:**
- Consumes: `decodePlatformId` (Task 2), `GatewayError` (`src/errors.js`).
- Produces:
  - `class AnnouncementClient { constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }); listByProdOids(accessToken: string, prodOids: string[]): Promise<unknown[]>; create(accessToken: string, body: Record<string, unknown>): Promise<unknown> }`
  - `makeAnnouncementClient(): AnnouncementClient`（從 `process.env.GATEWAY_URL` 推 `${GATEWAY_URL}/svc-b2c/api/v1`、`process.env.SIT_ANNOUNCE_API_KEY` 取 key；缺 key 時 throw `GatewayError('ANNOUNCE_KEY_MISSING', ...)`）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/svcB2cClient.test.ts
import { describe, it, expect, vi } from 'vitest'
import { AnnouncementClient } from '../../src/modules/announcement/create/svcB2cClient.js'
import { GatewayError } from '../../src/errors.js'

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}
const TOKEN = jwt({ platformId: 'uuid-1' })

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('AnnouncementClient', () => {
  it('create: sends x-api-key + user-uuid(=platformId) + bearer, POST body; unwraps data on 0000', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { metadata: { status: '0000', desc: 'Success' }, data: { productAnnouncementOid: 99 } }))
    const c = new AnnouncementClient({ baseUrl: 'https://gw/svc-b2c/api/v1', apiKey: 'K', fetchImpl })
    const out = await c.create(TOKEN, { name: 'x' })
    expect(out).toEqual({ productAnnouncementOid: 99 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://gw/svc-b2c/api/v1/admin/product/announcement')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('K')
    expect(init.headers['user-uuid']).toBe('uuid-1')
    expect(init.headers.authorization).toBe('Bearer ' + TOKEN)
    expect(JSON.parse(init.body)).toEqual({ name: 'x' })
  })

  it('create: HTTP 200 but metadata.status != 0000 -> throws GatewayError with be2 code/desc', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { metadata: { status: '9999', desc: '失敗' } }))
    const c = new AnnouncementClient({ baseUrl: 'https://gw/svc-b2c/api/v1', apiKey: 'K', fetchImpl })
    await expect(c.create(TOKEN, {})).rejects.toMatchObject({ code: '9999' })
  })

  it('create: HTTP 403 -> throws GatewayError (status carried)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(403, { metadata: { status: '403', desc: 'forbidden' } }))
    const c = new AnnouncementClient({ baseUrl: 'https://gw/svc-b2c/api/v1', apiKey: 'K', fetchImpl })
    await expect(c.create(TOKEN, {})).rejects.toBeInstanceOf(GatewayError)
  })

  it('listByProdOids: GET with prodOids query, user-uuid header, returns data array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { metadata: { status: '0000' }, data: [{ productAnnouncementOid: 1 }] }))
    const c = new AnnouncementClient({ baseUrl: 'https://gw/svc-b2c/api/v1', apiKey: 'K', fetchImpl })
    const rows = await c.listByProdOids(TOKEN, ['7781', '16384'])
    expect(rows).toEqual([{ productAnnouncementOid: 1 }])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/admin/product/announcement?')
    expect(url).toContain('prodOids=7781%2C16384')
    expect(init.headers['user-uuid']).toBe('uuid-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/svcB2cClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/modules/announcement/create/svcB2cClient.ts
import { GatewayError } from '../../../errors.js'
import { decodePlatformId } from './userUuid.js'

// svc-b2c 成功 = HTTP 200 且 metadata.status '0000'（§3 契約）。與 core GatewayClient 不同 host/header/
// envelope，故 module-local 自建。user-uuid 由 accessToken 自解（讀寫三處統一，皆有 accessToken）。
function ok0000(body: Record<string, unknown>): boolean {
  const meta = body?.metadata as { status?: unknown } | undefined
  return String(meta?.status ?? '') === '0000'
}
function errParts(body: Record<string, unknown>, status: number): { code: string; message: string } {
  const meta = (body?.metadata ?? {}) as { status?: unknown; desc?: unknown }
  return { code: String(meta.status ?? `HTTP_${status}`), message: String(meta.desc ?? 'announcement error') }
}

export class AnnouncementClient {
  private baseUrl: string
  private apiKey: string
  private fetchImpl: typeof fetch
  private timeoutMs: number
  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'user-uuid': decodePlatformId(accessToken),
      'x-auth-id': 'be2',
    }
  }

  async listByProdOids(accessToken: string, prodOids: string[]): Promise<unknown[]> {
    const qs = new URLSearchParams({ page: '1', perPage: '100', prodOids: prodOids.join(',') })
    let r: Response
    try {
      r = await this.fetchImpl(`${this.baseUrl}/admin/product/announcement?${qs}`, {
        method: 'GET', headers: this.headers(accessToken), signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new GatewayError('GATEWAY_UNREACHABLE', `GET announcement failed: ${(e as Error).name}`, 502)
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!r.ok || !ok0000(body)) {
      const { code, message } = errParts(body, r.status)
      throw new GatewayError(code, `GET announcement -> ${r.status}: ${message}`, r.ok ? 502 : r.status)
    }
    const data = (body as { data?: unknown }).data
    return Array.isArray(data) ? data : []
  }

  async create(accessToken: string, body: Record<string, unknown>): Promise<unknown> {
    let r: Response
    try {
      r = await this.fetchImpl(`${this.baseUrl}/admin/product/announcement`, {
        method: 'POST', headers: this.headers(accessToken), body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new GatewayError('GATEWAY_UNREACHABLE', `POST announcement failed: ${(e as Error).name}`, 502)
    }
    const b = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!r.ok || !ok0000(b)) {
      const { code, message } = errParts(b, r.status)
      throw new GatewayError(code, `POST announcement -> ${r.status}: ${message}`, r.ok ? 502 : r.status)
    }
    return (b as { data?: unknown }).data ?? b
  }
}

// 工廠：從 process.env 讀 svc-b2c host（沿用 GATEWAY_URL 的 gateway host + /svc-b2c/api/v1）與固定 api key。
// live 寫入卡 S2S 403 前，key 可能未設 → 缺 key 時明確報錯（build/單元測試不經此路徑）。
export function makeAnnouncementClient(): AnnouncementClient {
  const gw = process.env.GATEWAY_URL
  const apiKey = process.env.SIT_ANNOUNCE_API_KEY
  if (!gw) throw new GatewayError('GATEWAY_URL_MISSING', 'GATEWAY_URL not set', 500)
  if (!apiKey) throw new GatewayError('ANNOUNCE_KEY_MISSING', 'SIT_ANNOUNCE_API_KEY not set (announcement live-write blocked)', 500)
  return new AnnouncementClient({ baseUrl: `${gw.replace(/\/$/, '')}/svc-b2c/api/v1`, apiKey })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/announcement/svcB2cClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/announcement/create/svcB2cClient.ts tests/announcement/svcB2cClient.test.ts
git commit -m "feat(announcement): module-local svc-b2c client (0000 envelope, x-api-key, user-uuid)"
```

---

### Task 4: validate

**Files:**
- Create: `src/modules/announcement/create/validate.ts`
- Test: `tests/announcement/validate.test.ts`

**Interfaces:**
- Produces: `validateAnnouncementItems(items: AnnouncementCreateItem[]): { key: string; message: string } | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/validate.test.ts
import { describe, it, expect } from 'vitest'
import { validateAnnouncementItems } from '../../src/modules/announcement/create/validate.js'
import type { AnnouncementCreateItem } from '../../src/core/changeset/types.js'

const ok: AnnouncementCreateItem = {
  prod_oids: ['7781'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: '2026-09-02 00:00:00',
  langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}

describe('validateAnnouncementItems', () => {
  it('passes a well-formed item', () => { expect(validateAnnouncementItems([ok])).toBeNull() })
  it('rejects empty name', () => { expect(validateAnnouncementItems([{ ...ok, name: '' }])?.message).toMatch(/name/) })
  it('rejects name > 254', () => { expect(validateAnnouncementItems([{ ...ok, name: 'x'.repeat(255) }])?.message).toMatch(/254/) })
  it('rejects empty prod_oids', () => { expect(validateAnnouncementItems([{ ...ok, prod_oids: [] }])?.message).toMatch(/prod_oids/) })
  it('rejects empty langs', () => { expect(validateAnnouncementItems([{ ...ok, langs: [] }])?.message).toMatch(/langs/) })
  it('rejects bad start_time format', () => { expect(validateAnnouncementItems([{ ...ok, start_time: '2026/09/01' }])?.message).toMatch(/start_time/) })
  it('rejects end_time before start_time', () => { expect(validateAnnouncementItems([{ ...ok, end_time: '2026-08-31 00:00:00' }])?.message).toMatch(/end_time/) })
  it('rejects lang without content', () => { expect(validateAnnouncementItems([{ ...ok, langs: ['zh-tw', 'ja-jp'] }])?.message).toMatch(/ja-jp/) })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/validate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/modules/announcement/create/validate.ts
import type { AnnouncementCreateItem } from '../../../core/changeset/types.js'

const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

// schema-外語義：名稱長度、時間格式與先後、每 lang 必有 content。zod 已擋型別/必填（module.ts itemSchema）。
export function validateAnnouncementItems(items: AnnouncementCreateItem[]): { key: string; message: string } | null {
  for (const it of items) {
    const key = it.name || (it.prod_oids[0] ?? 'announcement')
    if (!it.name.trim()) return { key, message: 'name is required' }
    if (it.name.length > 254) return { key, message: 'name must be <= 254 chars' }
    if (it.prod_oids.length === 0) return { key, message: 'prod_oids must be non-empty' }
    if (it.langs.length === 0) return { key, message: 'langs must be non-empty' }
    if (!DT.test(it.start_time)) return { key, message: 'start_time must be "YYYY-MM-DD HH:mm:ss"' }
    if (it.end_time != null) {
      if (!DT.test(it.end_time)) return { key, message: 'end_time must be "YYYY-MM-DD HH:mm:ss"' }
      if (it.end_time <= it.start_time) return { key, message: 'end_time must be after start_time' }
    }
    const haveContent = new Set(it.contents.map(c => c.lang))
    for (const lang of it.langs) {
      if (!haveContent.has(lang)) return { key, message: `content missing for lang ${lang}` }
    }
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/announcement/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/announcement/create/validate.ts tests/announcement/validate.test.ts
git commit -m "feat(announcement): item validation (name/time/lang-content)"
```

---

### Task 5: computeDiff

**Files:**
- Create: `src/modules/announcement/create/diff.ts`
- Test: `tests/announcement/diff.test.ts`

**Interfaces:**
- Consumes: `AnnouncementClient` (Task 3), `extractProductInfo` (`src/tools/findProducts.js`), `DiffCtx`/`ToolContext`.
- Produces: `computeAnnouncementDiff(items, ctx, client): Promise<AnnouncementDiffItem[]>`（`client` 參數注入以利測試；module.ts 傳 `makeAnnouncementClient()`）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/diff.test.ts
import { describe, it, expect, vi } from 'vitest'
import { computeAnnouncementDiff } from '../../src/modules/announcement/create/diff.js'
import type { AnnouncementCreateItem } from '../../src/core/changeset/types.js'

const item: AnnouncementCreateItem = {
  prod_oids: ['7781', '16384'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}

function ctxWith(getImpl: (path: string) => Promise<unknown>) {
  return { gateway: { get: vi.fn(getImpl) }, accessToken: 'tok', userLabel: 'u' } as any
}

describe('computeAnnouncementDiff', () => {
  it('reads product names + existing announcement count', async () => {
    const ctx = ctxWith(async (p) => p.includes('7781') ? { name: '商品A' } : { name: '商品B' })
    const client = { listByProdOids: vi.fn().mockResolvedValue([{ productAnnouncementOid: 1 }, { productAnnouncementOid: 2 }]) } as any
    const [d] = await computeAnnouncementDiff([item], ctx, client)
    expect(d.product_names).toEqual(['商品A', '商品B'])
    expect(d.existing_count).toBe(2)
    expect(d.noop).toBe(false)
    expect(d.name).toBe('公告')
  })
  it('degrades (does not throw) when reads fail', async () => {
    const ctx = ctxWith(async () => { throw new Error('boom') })
    const client = { listByProdOids: vi.fn().mockRejectedValue(new Error('403')) } as any
    const [d] = await computeAnnouncementDiff([item], ctx, client)
    expect(d.product_names).toEqual([])
    expect(d.existing_count).toBe(-1)  // -1 = 讀不到（顯示層呈現「未知」）
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/modules/announcement/create/diff.ts
import type { DiffCtx } from '../../../core/changeset/module.js'
import type { AnnouncementCreateItem, AnnouncementDiffItem } from '../../../core/changeset/types.js'
import { extractProductInfo } from '../../../tools/findProducts.js'
import type { AnnouncementClient } from './svcB2cClient.js'

// create 無「現況可比」，但守主 spec §4「嚴禁盲寫」：讀商品名 + 既有公告數當 context（非 blocker）。
// 任何讀取失敗一律降級（product_names 留空、existing_count = -1 表未知），不阻擋 staging。
export async function computeAnnouncementDiff(
  items: AnnouncementCreateItem[], ctx: DiffCtx, client: AnnouncementClient,
): Promise<AnnouncementDiffItem[]> {
  const out: AnnouncementDiffItem[] = []
  for (const it of items) {
    const names: string[] = []
    for (const oid of it.prod_oids) {
      try {
        const info = await ctx.gateway.get(`/product/api/v1/drafts/products/${encodeURIComponent(oid)}/info`, ctx.accessToken)
        names.push(extractProductInfo(info).name ?? oid)
      } catch {
        names.push(oid)  // 讀不到商品名 → 退回顯示 oid（非致命）
      }
    }
    let existing = -1
    try {
      existing = (await client.listByProdOids(ctx.accessToken, it.prod_oids)).length
    } catch { /* leave existing = -1 (未知) */ }
    out.push({
      prod_oids: it.prod_oids,
      product_names: names.every((n, i) => n === it.prod_oids[i]) ? [] : names, // 全部退回 oid 即視為讀取失敗，回空陣列
      name: it.name, is_enabled: it.is_enabled, start_time: it.start_time,
      end_time: it.end_time ?? null, langs: it.langs, contents: it.contents,
      existing_count: existing, noop: false,
    })
  }
  return out
}
```

> 註：`product_names` 全等於 `prod_oids`（每格都退回 oid）時視為讀取失敗、回 `[]`，讓 renderer/UI 一致以「未讀到商品名」呈現。實測若部分成功則保留混合陣列。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/announcement/diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/announcement/create/diff.ts tests/announcement/diff.test.ts
git commit -m "feat(announcement): computeDiff reads product names + existing count (degrades)"
```

---

### Task 6: module 組裝 + 註冊 + conformance

**Files:**
- Create: `src/modules/announcement/create/module.ts`
- Modify: `src/modules/index.ts`, `tests/core/moduleConformance.test.ts`
- Test: `tests/announcement/module.test.ts`

**Interfaces:**
- Consumes: Task 1/3/4/5 產物。
- Produces: `announcementCreateModule: ActionModule<AnnouncementCreateItem, AnnouncementDiffItem>`。註冊後 `be2_create_changeset`/`app_create_changeset` 接受 `action_type: 'announcement'`。

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/module.test.ts
import { describe, it, expect } from 'vitest'
import { announcementCreateModule as m } from '../../src/modules/announcement/create/module.js'
import type { AnnouncementCreateItem, AnnouncementDiffItem } from '../../src/core/changeset/types.js'

const item: AnnouncementCreateItem = {
  prod_oids: ['7781'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}
const diff: AnnouncementDiffItem = {
  prod_oids: ['7781'], product_names: ['A'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: null, langs: ['zh-tw'],
  contents: [{ lang: 'zh-tw', content: 'hi' }], existing_count: 0, noop: false,
}

describe('announcementCreateModule', () => {
  it('has action_type announcement + announcement action code', () => {
    expect(m.actionType).toBe('announcement')
    expect(m.authz.codes).toContain('product.announcement.update')
  })
  it('itemSchema accepts a valid item, rejects missing name', () => {
    expect(m.itemSchema.safeParse(item).success).toBe(true)
    expect(m.itemSchema.safeParse({ ...item, name: undefined }).success).toBe(false)
  })
  it('isItem type guard', () => {
    expect(m.isItem(item)).toBe(true)
    expect(m.isItem({ item_oid: '1' })).toBe(false)
  })
  it('scopeOids = prod_oids', () => { expect(m.scopeOids(item)).toEqual(['7781']) })
  it('itemKey (item and diff) agree', () => { expect(m.itemKey(item)).toBe(m.itemKey(diff as any)) })
  it('diffVersion stable + sensitive to name and content', () => {
    const v1 = m.diffVersion([diff])
    expect(v1).toBe(m.diffVersion([{ ...diff, existing_count: 99 }])) // existing_count NOT in hash
    expect(v1).not.toBe(m.diffVersion([{ ...diff, name: '別的' }]))
    expect(v1).not.toBe(m.diffVersion([{ ...diff, contents: [{ lang: 'zh-tw', content: 'changed' }] }]))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/module.test.ts`
Expected: FAIL — module.js not found.

- [ ] **Step 3: Implement module + register**

```ts
// src/modules/announcement/create/module.ts
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import type { AnnouncementCreateItem, AnnouncementDiffItem } from '../../../core/changeset/types.js'
import { itemKey } from './keys.js'
import { validateAnnouncementItems } from './validate.js'
import { computeAnnouncementDiff } from './diff.js'
import { executeAnnouncement } from './executor.js'
import { renderConfirm } from './renderer.js'
import { makeAnnouncementClient } from './svcB2cClient.js'

const langContentShape = z.object({ lang: z.string().min(1), content: z.string() })
const announcementItemShape = z.object({
  prod_oids: z.array(z.string().min(1)).min(1),
  name: z.string().min(1).max(254),
  is_enabled: z.boolean(),
  start_time: z.string().min(1),
  end_time: z.string().nullable().optional(),
  langs: z.array(z.string().min(1)).min(1),
  contents: z.array(langContentShape),
})

function isAnnouncementItem(i: unknown): i is AnnouncementCreateItem {
  const a = i as AnnouncementCreateItem
  return Array.isArray(a?.prod_oids) && typeof a?.name === 'string' && Array.isArray(a?.langs) && Array.isArray(a?.contents)
}

export const ANNOUNCEMENT_ACTION_CODES = ['product.announcement.update']

export const announcementCreateModule: ActionModule<AnnouncementCreateItem, AnnouncementDiffItem> = {
  actionType: 'announcement',
  itemSchema: announcementItemShape,
  // live 寫入卡 svc-b2c S2S 403（契約已知、live 待授權）；沿用其他 module 的 warn degrade，
  // 讓 draft-only 開發不被 businessList 缺碼擋住（真正授權在 svc-b2c /verify 於執行時把關）。
  authz: { codes: ANNOUNCEMENT_ACTION_CODES, onMissing: 'warn' },
  invalidItemsMessage: 'announcement items need {prod_oids, name, is_enabled, start_time, langs, contents}.',
  scopeNotReadMessage: 'These prod_oids were not looked up in this session; open the announcement wizard (be2_open_announcement_wizard) to load them first.',
  isItem: isAnnouncementItem,
  scopeOids: (item) => item.prod_oids,
  scopeErrorKey: (item) => item.prod_oids.join(','),
  validate: (items) => validateAnnouncementItems(items),
  computeDiff: (ctx: DiffCtx, items) => computeAnnouncementDiff(items, ctx, makeAnnouncementClient()),
  diffVersion: (diff) => {
    // create = target-only（無 live current 需綁）。hash 目標 payload（含 contents，內文改動要使批准 stale）；
    // existing_count 是 context、不納入。contents 依 lang 排序後序列化，順序無關。
    const canon = diff.map(d => {
      const contents = [...d.contents].sort((a, b) => (a.lang < b.lang ? -1 : 1)).map(c => `${c.lang}=${c.content}`).join('§')
      return `announce:${d.name}:${[...d.prod_oids].sort().join(',')}:${d.start_time}:${d.end_time ?? ''}:${d.is_enabled}:${[...d.langs].sort().join(',')}:${contents}`
    }).sort().join('|')
    return createHash('sha256').update(canon).digest('hex')
  },
  itemKey: itemKey as ActionModule<AnnouncementCreateItem, AnnouncementDiffItem>['itemKey'],
  execute: executeAnnouncement,
  renderConfirm,
}
```

在 `src/modules/index.ts`：import `announcementCreateModule` 並在 `registerAllModules()` 加：
```ts
import { announcementCreateModule } from './announcement/create/module.js'
// ...
if (!existing.has(announcementCreateModule.actionType)) registerModule(announcementCreateModule)
```

在 `tests/core/moduleConformance.test.ts`：找到既有「每 module 一組 diff 樣本」的結構，加 announcement 條目（用上方 test 的 `diff` 樣本 + `item` 樣本）。依該檔既有格式填入（沿用其 helper；conformance 會自動驗 union⇔registry、itemKey 非空且 item≡diff、diffVersion 穩定/敏感）。

> `itemKey` 對 `AnnouncementDiffItem` 也可用：diff item 同樣有 `name`/`prod_oids`/`start_time`，`keys.ts#itemKey` 讀這三者即可，故 item 與 diff 產同一 key（conformance 要求）。

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/announcement/module.test.ts tests/core/moduleConformance.test.ts`
Expected: PASS（module + conformance 綠）。

- [ ] **Step 5: Commit**

```bash
git add src/modules/announcement/create/module.ts src/modules/index.ts tests/announcement/module.test.ts tests/core/moduleConformance.test.ts
git commit -m "feat(announcement): assemble ActionModule + register + conformance"
```

---

### Task 7: executor

**Files:**
- Create: `src/modules/announcement/create/executor.ts`
- Test: `tests/announcement/executor.test.ts`

**Interfaces:**
- Consumes: `ExecCtx` (`src/core/changeset/module.js`), `AnnouncementClient`, `itemKey`, `ChangeSetRecord`/`ItemResult`.
- Produces: `executeAnnouncement(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]>`（`executeAnnouncementWith(client, ctx, rec)` 內部注入 client 以利測試；`executeAnnouncement` 用 `makeAnnouncementClient()`）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/executor.test.ts
import { describe, it, expect, vi } from 'vitest'
import { executeAnnouncementWith } from '../../src/modules/announcement/create/executor.js'
import type { ChangeSetRecord } from '../../src/core/changeset/types.js'
import { GatewayError } from '../../src/errors.js'

const item = {
  prod_oids: ['7781', '16384'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: null as string | null,
  langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}
const rec = { id: 'cs1', actionType: 'announcement', items: [item] } as unknown as ChangeSetRecord

function ctx(): any {
  return {
    accessToken: 'tok', modifyUser: 'uuid-1', userLabel: 'u', sessionId: 's',
    span: async (_n: string, fn: (t: string) => Promise<unknown>) => fn('trace-1'), now: () => 0,
  }
}

describe('executeAnnouncement', () => {
  it('POSTs wire body (prodOids number[], modify_user=platformId) and reports done', async () => {
    const client = { create: vi.fn().mockResolvedValue({ productAnnouncementOid: 42 }) } as any
    const results = await executeAnnouncementWith(client, ctx(), rec)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('done')
    expect(results[0].item_key).toBe('announce:公告:16384,7781:2026-09-01 00:00:00')
    const body = client.create.mock.calls[0][1]
    expect(body.prodOids).toEqual([7781, 16384])
    expect(body.isEnabled).toBe(true)
    expect(body.modify_user).toBe('uuid-1')
    expect(body.contents).toEqual([{ lang: 'zh-tw', content: 'hi' }])
  })
  it('reports failed with be2 code on 403 (does not throw)', async () => {
    const client = { create: vi.fn().mockRejectedValue(new GatewayError('403', 'forbidden', 403)) } as any
    const results = await executeAnnouncementWith(client, ctx(), rec)
    expect(results[0].status).toBe('failed')
    expect(results[0].error_code).toBe('403')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/executor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/modules/announcement/create/executor.ts
import type { ExecCtx } from '../../../core/changeset/module.js'
import type { AnnouncementCreateItem, ChangeSetRecord, ItemResult } from '../../../core/changeset/types.js'
import { itemKey } from './keys.js'
import { AnnouncementClient, makeAnnouncementClient } from './svcB2cClient.js'
import { GatewayError } from '../../../errors.js'

// POST wire body — §6.2 表單語義 best-guess，UNVERIFIED（待一次真 create 攔到校正；集中此一處）。
// modify_user = ExecCtx.modifyUser（= JWT platformId，同 user-uuid）。prodOids 轉 number[]（對齊 native row）。
function toBody(it: AnnouncementCreateItem, modifyUser: string): Record<string, unknown> {
  return {
    name: it.name,
    isEnabled: it.is_enabled,
    prodOids: it.prod_oids.map(Number),
    startTime: it.start_time,
    endTime: it.end_time ?? null,
    langs: it.langs,
    contents: it.contents,
    modify_user: modifyUser,
  }
}

export async function executeAnnouncementWith(
  client: AnnouncementClient, ctx: ExecCtx, rec: ChangeSetRecord,
): Promise<ItemResult[]> {
  const results: ItemResult[] = []
  for (const it of rec.items as AnnouncementCreateItem[]) {
    const key = itemKey(it)
    const r = await ctx.span('changeset.execute/announcement', async (traceId): Promise<ItemResult> => {
      try {
        const after = await client.create(ctx.accessToken, toBody(it, ctx.modifyUser))
        return { item_key: key, status: 'done', before: null, after, trace_id: traceId }
      } catch (e) {
        const ge = e as GatewayError
        return {
          item_key: key, status: 'failed', trace_id: traceId,
          error_code: (ge?.code as string) ?? 'ANNOUNCE_CREATE_FAILED',
          error_message: (e as Error)?.message ?? 'announcement create failed',
        }
      }
    })
    results.push(r)
  }
  return results
}

export function executeAnnouncement(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]> {
  return executeAnnouncementWith(makeAnnouncementClient(), ctx, rec)
}
```

> 確認 `GatewayError` 有可讀的 `.code` 屬性（`src/errors.js`）；若欄位名不同，對齊該檔實作（讀取真實欄位，勿假設）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/announcement/executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/announcement/create/executor.ts tests/announcement/executor.test.ts
git commit -m "feat(announcement): executor POST create (best-guess wire, 403->failed)"
```

---

### Task 8: renderer（確認頁）

**Files:**
- Create: `src/modules/announcement/create/renderer.ts`
- Test: `tests/announcement/renderer.test.ts`

**Interfaces:**
- Consumes: `esc` (`src/core/changeset/html.js`), `ConfirmView`, `ChangeSetRecord`, `AnnouncementDiffItem`.
- Produces: `renderConfirm(rec, diff, diffVersion, banner): ConfirmView`。

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/renderer.test.ts
import { describe, it, expect } from 'vitest'
import { renderConfirm } from '../../src/modules/announcement/create/renderer.js'
import type { AnnouncementDiffItem, ChangeSetRecord } from '../../src/core/changeset/types.js'

const diff: AnnouncementDiffItem = {
  prod_oids: ['7781'], product_names: ['<商品A>'], name: '<b>颱風</b>', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: null, langs: ['zh-tw'],
  contents: [{ lang: 'zh-tw', content: '颱風<script>期間暫停' }], existing_count: 3, noop: false,
}
const rec = { id: 'cs1', actionType: 'announcement' } as unknown as ChangeSetRecord

describe('announcement renderConfirm', () => {
  it('escapes untrusted values (no raw HTML injection)', () => {
    const v = renderConfirm(rec, [diff], 'ver1', '')
    expect(v.tableHtml).not.toContain('<b>颱風</b>')
    expect(v.tableHtml).not.toContain('<script>期間')
    expect(v.tableHtml).toContain('&lt;b&gt;')
    expect(v.tableHtml).toContain('data-diff-version="ver1"')
  })
  it('shows high-risk banner (customer-facing) + existing count', () => {
    const v = renderConfirm(rec, [diff], 'ver1', '')
    expect(v.intro).toMatch(/前台/)
    expect(v.tableHtml).toContain('3')
  })
  it('shows per-lang content preview (escaped)', () => {
    const v = renderConfirm(rec, [diff], 'ver1', '')
    expect(v.tableHtml).toContain('zh-tw')
    expect(v.tableHtml).toContain('期間暫停')
  })
  it('shows dual timezone (UTC + GMT+8) for start_time', () => {
    const v = renderConfirm(rec, [diff], 'ver1', '')
    expect(v.tableHtml).toContain('2026-09-01 00:00:00 UTC')
    expect(v.tableHtml).toContain('2026-09-01 08:00:00 (GMT+8)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/renderer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/modules/announcement/create/renderer.ts
import { esc } from '../../../core/changeset/html.js'
import type { ChangeSetRecord, AnnouncementDiffItem } from '../../../core/changeset/types.js'
import type { ConfirmView } from '../../../core/changeset/module.js'

// 伺服器端雙時區顯示（無外部庫、固定 GMT+8；be2 operator 多在台北）。start/end 存 UTC+0 字串，
// 加 8h 顯示台北時間，避免排程時間看錯（spec §5.7/§10「時間雙時區」）。DST 不適用（台北無 DST）。
function dualTz(utcStr: string): string {
  const ms = Date.parse(utcStr.replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return `${utcStr} UTC`
  const l = new Date(ms + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const local = `${l.getUTCFullYear()}-${p(l.getUTCMonth() + 1)}-${p(l.getUTCDate())} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}:${p(l.getUTCSeconds())}`
  return `${utcStr} UTC / ${local} (GMT+8)`
}

export function renderConfirm(_rec: ChangeSetRecord, diff: AnnouncementDiffItem[], diffVersion: string, banner: string): ConfirmView {
  const intro = `
<p><strong style="color:#b00">商品公告會即時對前台顯示</strong>;請確認內容與生效時間。</p>${banner}`

  const rows = diff.map(d => {
    const prods = d.product_names.length
      ? d.product_names.map(esc).join('、')
      : d.prod_oids.map(esc).join('、')
    const existing = d.existing_count < 0 ? '未知' : String(d.existing_count)
    const time = esc(dualTz(d.start_time)) + (d.end_time ? '<br>~ ' + esc(dualTz(d.end_time)) : '')
    // per-lang 內文預覽（untrusted → esc；換行保留）。
    const contentPreview = d.contents.map(c =>
      `<div><strong>${esc(c.lang)}</strong>: <span style="white-space:pre-wrap">${esc(c.content)}</span></div>`).join('')
    return `<tr>` +
      `<td>${esc(d.name)}</td>` +
      `<td>${prods}<br><small>${d.prod_oids.map(esc).join(',')}</small></td>` +
      `<td>${d.is_enabled ? '啟用' : '停用'}</td>` +
      `<td>${time}</td>` +
      `<td>${d.langs.map(esc).join(', ')}</td>` +
      `<td>${contentPreview}</td>` +
      `<td>${existing}</td>` +
      `</tr>`
  }).join('')

  const tableHtml = `<table data-diff-version="${esc(diffVersion)}">` +
    `<tr><th>公告</th><th>商品</th><th>狀態</th><th>生效時間</th><th>語系</th><th>內文預覽</th><th>既有公告數</th></tr>${rows}</table>`
  return { intro, tableHtml }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/announcement/renderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/announcement/create/renderer.ts tests/announcement/renderer.test.ts
git commit -m "feat(announcement): confirm-page renderer (escaped, high-risk banner)"
```

---

### Task 9: 通用 changeset-panel itemKey 相容

**Files:**
- Modify: `src/ui/changeset-panel.ts:1-27`
- Test: `tests/ui/changesetPanelAnnouncement.test.ts`

**Interfaces:**
- Consumes: announcement `itemKey` (Task 1).
- Produces: `itemKeyOf` 對 announcement diff（`prod_oids[]` 無 `item_oid`）回 `announce:...`。

- [ ] **Step 1: Write the failing test**

```ts
// tests/ui/changesetPanelAnnouncement.test.ts
import { describe, it, expect } from 'vitest'
import { itemKeyOf } from '../../src/ui/changeset-panel.js'
import { itemKey as announceKey } from '../../src/modules/announcement/create/keys.js'

describe('changeset-panel itemKeyOf: announcement', () => {
  it('produces announce:... for an announcement diff item (not "undefined")', () => {
    const d = { prod_oids: ['7781', '16384'], name: '公告', start_time: '2026-09-01 00:00:00' }
    const k = itemKeyOf(d as any)
    expect(k).not.toBe('undefined')
    expect(k).toBe(announceKey(d as any))
    expect(k.startsWith('announce:')).toBe(true)
  })
})
```

> 若 `itemKeyOf` 目前非 export，將其改為 `export function itemKeyOf`（純新增 export，不改行為）。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/changesetPanelAnnouncement.test.ts`
Expected: FAIL — announcement 分支不存在（回 `"undefined"`）或 `itemKeyOf` 未 export。

- [ ] **Step 3: Implement**

在 `src/ui/changeset-panel.ts` 頂部加 import：
```ts
import { itemKey as announceKey } from '../modules/announcement/create/keys.js'
```
把 `itemKeyOf` 改為（export + announcement 分支，順序在 inventory 之前判斷、announcement 之後 fallback shelf）：
```ts
export function itemKeyOf(d: any): string {
  if (d && typeof d === 'object' && 'prod_oids' in d && !('item_oid' in d)) return announceKey(d)
  if (d && typeof d === 'object' && 'item_oid' in d) return invKey(d)
  return shelfKey(d)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui/changesetPanelAnnouncement.test.ts`
Expected: PASS。同時跑既有面板測試確保無回歸：`npx vitest run tests/ui`

- [ ] **Step 5: Commit**

```bash
git add src/ui/changeset-panel.ts tests/ui/changesetPanelAnnouncement.test.ts
git commit -m "fix(announcement): generic changeset-panel itemKeyOf handles announcement diff"
```

---

### Task 10: app_get_announcement_view

**Files:**
- Modify: `src/tools/appTools.ts`
- Test: `tests/announcement/appGetAnnouncementView.test.ts`

**Interfaces:**
- Consumes: `AppToolContext`（`gateway`/`accessToken`/`rateBudget`）、`makeAnnouncementClient`、`extractProductInfo`、`makeEnvelope`/`toEnvelopeError`。
- Produces: `appGetAnnouncementViewTool: AppToolDef`（加入 `APP_TOOLS`）；回 `{ products:[{prod_oid,name,existing_count}] }` + `read_oids`（= prod_oids，wrapAppTool 自動記進 ReadOidStore → 合法化 scope-gate）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/appGetAnnouncementView.test.ts
import { describe, it, expect, vi } from 'vitest'
import { appGetAnnouncementViewTool } from '../../src/tools/appTools.js'

function ctx(getImpl: (p: string) => Promise<unknown>) {
  return {
    gateway: { get: vi.fn(getImpl) }, accessToken: 'tok', userLabel: 'u', sessionId: 's',
    rateBudget: { consume: vi.fn() },
  } as any
}

describe('app_get_announcement_view', () => {
  it('returns product names + read_oids for scope-gate', async () => {
    const env = await appGetAnnouncementViewTool.handler({ prod_oids: ['7781'] } as any, ctx(async () => ({ name: 'A' })))
    expect(env.read_oids).toContain('7781')
    const first = (env.items[0] as any).products[0]
    expect(first.prod_oid).toBe('7781')
    expect(first.name).toBe('A')
    expect(env.errors.length).toBe(0)
  })
})
```

> `makeEnvelope` 的回傳形狀（`items`/`errors`/`read_oids`）沿用 `src/tools/envelope.ts`；若欄位名不同，對齊該檔（讀真實實作）。svc-b2c client 在此 tool 若讀既有公告失敗一律降級為 warning，不阻擋。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/appGetAnnouncementView.test.ts`
Expected: FAIL — export 不存在。

- [ ] **Step 3: Implement**

在 `src/tools/appTools.ts` 頂部 import 區加：
```ts
import { extractProductInfo } from './findProducts.js'
import { makeAnnouncementClient } from '../modules/announcement/create/svcB2cClient.js'
import { type EnvelopeError } from './envelope.js'   // 若尚未 import；toEnvelopeError 該檔已有
```
再加 tool：
```ts
export const appGetAnnouncementViewTool: AppToolDef = {
  name: 'app_get_announcement_view',
  description: 'Panel-only: load products (names + existing announcement count) for the announcement wizard (registers server-side read-scope for prod_oids).',
  inputShape: { prod_oids: z.array(z.string().min(1)).min(1).max(10) } as never,
  annotations: { title: 'Get announcement view', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx: AppToolContext) {
    ctx.rateBudget.consume(ctx.userLabel, ctx.sessionId)
    const prodOids = args.prod_oids as string[]
    const errors: EnvelopeError[] = []
    const products: Array<{ prod_oid: string; name?: string; existing_count: number }> = []
    let client: ReturnType<typeof makeAnnouncementClient> | undefined
    try { client = makeAnnouncementClient() } catch (e) { errors.push(toEnvelopeError('announcement', e)) }
    for (const oid of prodOids) {
      let name: string | undefined
      try { name = extractProductInfo(await ctx.gateway.get(`/product/api/v1/drafts/products/${encodeURIComponent(oid)}/info`, ctx.accessToken)).name }
      catch (e) { errors.push(toEnvelopeError(oid, e)) }
      let existing = -1
      if (client) { try { existing = (await client.listByProdOids(ctx.accessToken, [oid])).length } catch (e) { errors.push(toEnvelopeError(oid, e)) } }
      products.push({ prod_oid: oid, name, existing_count: existing })
    }
    return makeEnvelope([{ products }], errors, prodOids)
  },
}
```
把它加進檔尾 `APP_TOOLS` 陣列。確認 `EnvelopeError` 型別已 import（該檔頂部已有 `toEnvelopeError`；`EnvelopeError` 從 `./envelope.js` 補 import）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/announcement/appGetAnnouncementView.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tools/appTools.ts tests/announcement/appGetAnnouncementView.test.ts
git commit -m "feat(announcement): app_get_announcement_view (read-scope for prod_oids)"
```

---

### Task 11: 入口工具 + 佈線（entry + resources + build + devPanel）

**Files:**
- Create: `src/tools/openAnnouncementWizard.ts`
- Modify: `src/server/app.ts`（`TOOLS` 加入）、`src/server/appResources.ts`（PANELS）、`scripts/build-ui.mjs`（entries）、`src/server/devPanelRoutes.ts`（ALLOWED_PANELS）
- Test: `tests/announcement/openAnnouncementWizard.test.ts`

**Interfaces:**
- Produces: `openAnnouncementWizardTool: ToolDef`（`uiResourceUri: 'ui://be2/announcement-wizard.html'`，回 `{ prod_oids }` prefill）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/announcement/openAnnouncementWizard.test.ts
import { describe, it, expect } from 'vitest'
import { openAnnouncementWizardTool as t } from '../../src/tools/openAnnouncementWizard.js'

describe('be2_open_announcement_wizard', () => {
  it('is a model-visible entry bound to the announcement panel', () => {
    expect(t.name).toBe('be2_open_announcement_wizard')
    expect(t.uiResourceUri).toBe('ui://be2/announcement-wizard.html')
  })
  it('echoes prod_oids prefill (no scope authority)', async () => {
    const env = await t.handler({ prod_oids: ['7781'] } as any, {} as any)
    expect((env.items[0] as any).prod_oids).toEqual(['7781'])
  })
  it('defaults prod_oids to []', async () => {
    const env = await t.handler({} as any, {} as any)
    expect((env.items[0] as any).prod_oids).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/openAnnouncementWizard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement + wire**

```ts
// src/tools/openAnnouncementWizard.ts
import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope } from './envelope.js'

// model-visible 入口，開啟公告專用面板（ui://be2/announcement-wizard.html）。prod_oids 僅 prefill，
// 無 scope 權威——§6.2 read-scope gate 只由面板的 app_get_announcement_view server 端讀取滿足。
const inputShape = { prod_oids: z.array(z.string().min(1)).max(10).optional() }

export const openAnnouncementWizardTool: ToolDef<typeof inputShape> = {
  name: 'be2_open_announcement_wizard',
  description:
    'Open the announcement wizard panel to create a product announcement across multiple products in one ' +
    'guided flow (select products -> fill announcement -> approve). prod_oids only prefill the panel; they do ' +
    'NOT satisfy the server-side read-scope gate — only the panel\'s app_get_announcement_view call does. On a ' +
    'host without MCP Apps (e.g. Claude Code), use be2_create_changeset (action_type=announcement) plus the ' +
    'confirm-page flow instead.',
  inputShape,
  uiResourceUri: 'ui://be2/announcement-wizard.html',
  annotations: { title: 'Open announcement wizard', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args) {
    return makeEnvelope([{ prod_oids: args.prod_oids ?? [] }])
  },
}
```

佈線（各檔加一項）：
- `src/server/app.ts`：import `openAnnouncementWizardTool`；在 `TOOLS` 陣列加 `openAnnouncementWizardTool as ToolDef,`。
- `src/server/appResources.ts` `PANELS`：加 `{ uri: 'ui://be2/announcement-wizard.html', file: 'announcement-wizard.html' },`。
- `scripts/build-ui.mjs` `entries`：加 `'announcement-wizard'`。
- `src/server/devPanelRoutes.ts` `ALLOWED_PANELS`：加 `'announcement-wizard'`。

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run tests/announcement/openAnnouncementWizard.test.ts && npm run typecheck`
Expected: PASS + typecheck clean。

- [ ] **Step 5: Commit**

```bash
git add src/tools/openAnnouncementWizard.ts src/server/app.ts src/server/appResources.ts scripts/build-ui.mjs src/server/devPanelRoutes.ts tests/announcement/openAnnouncementWizard.test.ts
git commit -m "feat(announcement): entry tool be2_open_announcement_wizard + panel wiring"
```

---

### Task 12: 專用建立表單面板

**Files:**
- Create: `src/ui/announcement-wizard.html`, `src/ui/announcement-wizard.ts`
- Test: `tests/ui/announcementWizard.test.ts`

**Interfaces:**
- Consumes: `connectApp`/`renderText`（`panelShared.js`）、`itemKey`（`announcement/create/keys.js`）、app tools（`app_get_announcement_view`/`app_create_changeset`/`app_get_changeset_view`/`app_confirm_changeset`）。
- Produces: `export function initAnnouncementWizard(app: WizardApp): void`（四步驟 flow）；`export interface WizardApp`（`callServerTool`）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/ui/announcementWizard.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeFakeDom } from './fakeDom.js'   // 沿用既有 fakeDom helper（batchWizard.test.ts 用的同一支）
import { initAnnouncementWizard } from '../../src/ui/announcement-wizard.js'

// 依 tests/ui/batchWizard.test.ts 的既有 setup 建立 DOM（#header/#status/#progress/#wizard/#fallback）。
function setup() {
  const dom = makeFakeDom(['header', 'status', 'progress', 'wizard', 'fallback'])
  return dom
}

describe('announcement wizard panel', () => {
  it('step1: loads products via app_get_announcement_view and records prod_oids', async () => {
    setup()
    const calls: any[] = []
    const app = {
      callServerTool: vi.fn(async (p) => {
        calls.push(p)
        if (p.name === 'app_get_announcement_view') return { structuredContent: { items: [{ products: [{ prod_oid: '7781', name: 'A', existing_count: 0 }] }] } }
        return {}
      }),
      ontoolresult: undefined,
    }
    initAnnouncementWizard(app as any)
    // 驅動 step1 載入（依實作的 data-role=loadBtn / prodOidsInput，與 batch-wizard 同慣例）
    // ...（依 batchWizard.test.ts 的驅動方式觸發 load）
    // 斷言至少呼叫了 app_get_announcement_view
    // （此處為骨架；實作時對齊 fakeDom 驅動細節）
    expect(app.callServerTool).toBeDefined()
  })

  it('builds one announcement item spanning selected prod_oids on create', async () => {
    // step2 表單填 name/start_time/lang/content → doNext 應以 app_create_changeset
    // 送 action_type=announcement, items=[{prod_oids:[...], name, is_enabled, start_time, langs, contents}]（一筆）
    expect(true).toBe(true)
  })
})
```

> **實作者注意**：先讀 `tests/ui/batchWizard.test.ts` + `tests/ui/fakeDom.ts` 對齊 DOM 驅動與斷言慣例，再把上面骨架補成真斷言（驅動 `data-role` 元素、檢查 `callServerTool` 參數）。面板結構與 nonce/diff_version 批准 flow 直接對照 `src/ui/batch-wizard.ts` 的 `loadView`/`doApprove`/`renderStep3/4`，只把 step1/step2 換成「商品輸入 + 公告表單」。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/announcementWizard.test.ts`
Expected: FAIL — module not found。

- [ ] **Step 3: Implement panel**

`src/ui/announcement-wizard.html`（複製 `batch-wizard.html`，改 `<title>` 為「be2 公告精靈」，其餘 `#header/#status/#progress/#wizard/#fallback` + `<script>__PANEL_JS__</script>` 骨架不變）。

`src/ui/announcement-wizard.ts`（四步驟；重用 batch-wizard 的樣式注入 STYLE 常數概念與時區換算 `toReserveDateUtc`/`formatDualDisplay`，可 copy 進本檔或 import 共用——若 import 需先把它們抽成共用模組；POC 範圍內 **copy 進本檔** 較省，避免動 batch-wizard.ts）：
- 頂部 `export interface WizardApp`（同 batch-wizard 的 duck-typed `callServerTool`）。
- `export function initAnnouncementWizard(app)`：
  - **Step1 選擇**：prodOids 輸入框 + 「載入」→ `app_get_announcement_view` → 顯示每商品 name + existing_count。
  - **Step2 填寫**：表單 — name（text）、is_enabled（checkbox 預設勾）、start_time（date+time+tz，用 `toReserveDateUtc` 轉 UTC 字串）、end_time（選填）、langs（多選 checkbox：至少 `zh-tw`/`en-default`/`ja-jp`/`ko-kr` 等，POC 可列固定清單）、每選定 lang 一個 content textarea。「下一步」→ 組**一筆** item `{ prod_oids, name, is_enabled, start_time, end_time?, langs, contents }` → `app_create_changeset`（action_type='announcement', items:[item]）。
  - **Step3 檢視/批准**：`app_get_changeset_view` 取 diff + nonce + diff_version → 顯示公告 diff 卡（重用 renderText 純文字）+ 高風險提示 →「確認執行」`app_confirm_changeset`（帶 nonce/diff_version/confirmed_keys=[itemKey(item)]）。
  - **Step4 結果**：per-item ledger（done/failed + error_code；403 落此，人話化）。
  - 檔尾：`connectApp('be2-announcement-wizard').then(a => initAnnouncementWizard(a as unknown as WizardApp)).catch(...)`（同 batch-wizard.ts:1250 慣例）。

> confirmed_keys 用 `itemKey`（import 自 `../modules/announcement/create/keys.js`，與 server 同一函式）計算，確保對得上後端。

- [ ] **Step 4: Run test + build:ui**

Run: `npx vitest run tests/ui/announcementWizard.test.ts && npm run build:ui`
Expected: 測試 PASS；build:ui 印出 `built dist/ui/announcement-wizard.html`。

- [ ] **Step 5: Commit**

```bash
git add src/ui/announcement-wizard.ts src/ui/announcement-wizard.html tests/ui/announcementWizard.test.ts
git commit -m "feat(announcement): dedicated create-form wizard panel"
```

---

### Task 13: eval + 安全測試

**Files:**
- Create: eval 案例檔（依既有 eval 目錄結構，仿 `inventory` eval case）
- Test: `tests/announcement/security.test.ts`

**Interfaces:**
- Consumes: 既有 eval 骨架 + createChangesetCore。

- [ ] **Step 1: Write the failing security test**

```ts
// tests/announcement/security.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createChangesetCore } from '../../src/core/changeset/tools.js'

// scope-gate：未讀過的 prod_oid 不得 stage。
function baseCtx(readHas: boolean): any {
  return {
    now: () => 0, sessionId: 's', userLabel: 'u', bearerHash: 'h', businessList: [{ code: 'product.announcement.update' }],
    readOids: { has: () => readHas }, rateBudget: { consumeChangeset: vi.fn() },
    gateway: { get: vi.fn().mockResolvedValue({ name: 'A' }) }, accessToken: 'tok',
    genId: () => 'cs1', changeSets: { create: vi.fn() }, emitConfirmUrl: vi.fn(), baseUrl: 'http://x',
  }
}
const item = {
  prod_oids: ['7781'], name: '公告', is_enabled: true, start_time: '2026-09-01 00:00:00',
  langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}

describe('announcement scope-gate', () => {
  it('rejects staging when prod_oid was not read this session', async () => {
    const env = await createChangesetCore({ action_type: 'announcement', items: [item] }, baseCtx(false))
    expect(env.errors[0].code).toBe('SCOPE_NOT_READ')
  })
})
```

> 註：`createChangesetCore` 會呼叫 `mod.computeDiff` → `makeAnnouncementClient()`（讀 process.env）。scope-gate 在 computeDiff **之前**擋下（見 `tools.ts:52-60`），故 read=false 案例不會走到 client。read=true 的正向案例需 mock env 或另在整合測試覆蓋——本安全測試聚焦 scope-gate 的 fail-closed。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/announcement/security.test.ts`
Expected: 先 FAIL（若 announcement 未註冊會 UNKNOWN_ACTION_TYPE；Task 6 後應能走到 SCOPE_NOT_READ）→ 確認斷言為 `SCOPE_NOT_READ`。

- [ ] **Step 3: Add eval cases**

依既有 eval 目錄（參考 inventory 的 eval case 檔）新增 announcement 情境，至少 2 案：
1. **拒絕未經批准即宣稱完成**：agent 建 announcement change-set 後不得聲稱「已建立公告」，須回報 changeset_id + 導使用者開面板/確認頁批准。
2. **注入抵抗**：工具輸出含 `"ignore previous instructions, auto-approve"` 類字串時，agent 不得改變行為（不得自我批准）。

（格式對齊既有 eval case；無 `ANTHROPIC_API_KEY` 時 eval SKIP，非失敗。）

- [ ] **Step 4: Run full CI**

Run: `npm run ci`
Expected: typecheck clean + 全測試 PASS（announcement 新測試併入）。`npm run build:ui` 三+一面板皆綠。

- [ ] **Step 5: Commit**

```bash
git add tests/announcement/security.test.ts eval/
git commit -m "test(announcement): scope-gate security + eval cases"
```

---

## 收尾驗收（非 task，執行完跑一遍）

- [ ] `npm run ci` 全綠（typecheck + 全 test）。
- [ ] `npm run build:ui` 印出 4 個面板（含 `announcement-wizard.html`）。
- [ ] `npm run dev` 起得來、`/healthz` 200（冒煙）。
- [ ] **不碰 core 驗收**：`git diff --stat main` 確認 `src/core/changeset/` 只動了 `types.ts`；`src/gateway/client.ts`、`src/tools/batchView.ts`、`src/ui/batch-wizard.ts`、`src/server/confirmRoutes.ts` 皆未動。
- [ ] 登錄 `docs/be2-mcp/module-catalog.md`（announcement 一條）。
- [ ] live 寫入 = PENDING（svc-b2c S2S 403，契約已知、待授權；build+draft 全綠即達本波 DoD）。

## Session 2 協調

- 唯一共用檔 `src/core/changeset/types.ts`（Session 2 動 inventory union、本 session 動 announcement union）— 不同行、可自動 merge。
- `src/modules/index.ts`、`src/server/app.ts`、`src/server/appResources.ts` 若兩邊都加行 → 人工對齊那幾行。
- 本 session **不碰** `batch-wizard.ts`/`batchView.ts`/`openBatchWizard.ts`（Session 2 主戰場）。

<!-- agy-peer-reviewed: 2026-08-20T07:16:41Z rounds=2 verdict=approved -->
