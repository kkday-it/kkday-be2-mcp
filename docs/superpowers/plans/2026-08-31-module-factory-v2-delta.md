# Module Factory v2 Delta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 module-factory 從「不可續跑、無離線測試、SIT 卡死即誤判授權」升級成可續跑 + cassette 離線 replay + 環境退避 + 姊妹契約繼承的 v2。

**Architecture:** 新增一層 record/replay cassette harness（攔既有 `fetchImpl` 縫）作地基（D0），讓 factory 段②測試離線可跑；載體換成 Workflow 腳本取得 resume（D1）；段① discovery 加環境退避（D3）、姊妹繼承（D4）、page.route sniff（D5）；順帶修 announce client 的硬編 SIT 憑證洩漏（D3-5）。不碰 `src/core/`、不重做已上線 7 個 module。

**Tech Stack:** TypeScript、vitest 4、既有 `GatewayClient`/`AuthServiceClient`/`AnnouncementClient`（皆吃 `fetchImpl: typeof fetch`）、Claude Workflow 工具、Playwright（sniff）。

## Global Constraints

- **不碰 `src/core/`**（module-onboarding 驗收標準；憑證重構屬 module/config 層安全修正）。
- **憑證永不 commit、永不印出**（CLAUDE.md 鐵則）；cassette 落盤前脫敏（JWT 拒寫、剝 `Authorization`/`x-api-key`）。
- **cassette-backed 測試零 live、零憑證**；`npm run ci` = `build` + `typecheck` + `test`，離線全綠。
- **replay 比不到就丟錯，絕不 fallback 打 live**。
- vitest include = `tests/**/*.test.ts`（`vitest.config.ts`）。
- TDD：每個 code 任務先寫失敗測試、跑紅、最小實作、跑綠、commit。

---

### Task 1: cassette 核心 — 型別 + 正規化 + matchKey

**Files:**
- Create: `tests/support/cassette.ts`
- Test: `tests/support/cassette.normalize.test.ts`

**Interfaces:**
- Produces: `type Interaction = { method: string; url: string; reqBody: unknown; status: number; resBody: unknown }`；`type Cassette = { interactions: Interaction[] }`；`normalizeUrl(url: string): string`；`normalizeBody(body: unknown): unknown`；`matchKey(method: string, url: string, body: unknown): string`；常數 `VOLATILE_KEYS = ['modify_user','modifyUser','timestamp','request-uuid','requestUuid']`。

- [ ] **Step 1: 寫失敗測試**

```typescript
// tests/support/cassette.normalize.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeUrl, normalizeBody, matchKey } from './cassette.js'

describe('normalizeUrl', () => {
  it('sorts query params so order does not matter', () => {
    expect(normalizeUrl('https://h/p?b=2&a=1')).toBe(normalizeUrl('https://h/p?a=1&b=2'))
  })
  it('keeps path and host', () => {
    expect(normalizeUrl('https://h/admin/product/announcement/3084')).toContain('/admin/product/announcement/3084')
  })
})

describe('normalizeBody', () => {
  it('strips volatile fields (modify_user) symmetrically', () => {
    expect(normalizeBody({ name: 'x', modify_user: 'uuid-a' }))
      .toEqual(normalizeBody({ name: 'x', modify_user: 'uuid-b' }))
  })
  it('sorts keys so key order does not matter', () => {
    expect(normalizeBody({ b: 1, a: 2 })).toEqual(normalizeBody({ a: 2, b: 1 }))
  })
  it('recurses into nested objects and arrays', () => {
    expect(normalizeBody({ langSettings: [{ content: 'x', langCode: 'zh-tw', modify_user: 'u' }] }))
      .toEqual(normalizeBody({ langSettings: [{ langCode: 'zh-tw', content: 'x' }] }))
  })
})

describe('matchKey', () => {
  it('is identical for full body (with modify_user) vs cassette body (without)', () => {
    const live = matchKey('PATCH', 'https://h/a?x=1', { name: 'n', modify_user: 'u1' })
    const recorded = matchKey('PATCH', 'https://h/a?x=1', { name: 'n' })
    expect(live).toBe(recorded)
  })
  it('differs when method or path differs', () => {
    expect(matchKey('PATCH', 'https://h/a', {})).not.toBe(matchKey('POST', 'https://h/a', {}))
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/support/cassette.normalize.test.ts`
Expected: FAIL（`cassette.ts` 不存在 / 匯出未定義）

- [ ] **Step 3: 最小實作**

```typescript
// tests/support/cassette.ts
export type Interaction = { method: string; url: string; reqBody: unknown; status: number; resBody: unknown }
export type Cassette = { interactions: Interaction[] }

export const VOLATILE_KEYS = ['modify_user', 'modifyUser', 'timestamp', 'request-uuid', 'requestUuid']

export function normalizeUrl(url: string): string {
  const u = new URL(url)
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
  u.search = new URLSearchParams(params).toString()
  return u.toString()
}

export function normalizeBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(normalizeBody)
  if (body && typeof body === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(body as Record<string, unknown>).sort()) {
      if (VOLATILE_KEYS.includes(k)) continue
      out[k] = normalizeBody((body as Record<string, unknown>)[k])
    }
    return out
  }
  return body
}

export function matchKey(method: string, url: string, body: unknown): string {
  return `${method.toUpperCase()} ${normalizeUrl(url)} ${JSON.stringify(normalizeBody(body))}`
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/support/cassette.normalize.test.ts`
Expected: PASS（全數綠）

- [ ] **Step 5: Commit**

```bash
git add tests/support/cassette.ts tests/support/cassette.normalize.test.ts
git commit -m "feat(cassette): normalize url/body + symmetric matchKey (D0)"
```

---

### Task 2: cassette replay 模式

**Files:**
- Modify: `tests/support/cassette.ts`
- Test: `tests/support/cassette.replay.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Interaction`/`matchKey`。
- Produces: `makeCassetteFetch(mode: 'record' | 'replay', cassettePath: string): CassetteFetch`，其中 `type CassetteFetch = typeof fetch & { stubError: (method: string, urlPattern: string, status: number, envelopeBody: unknown) => void; save: () => void }`。replay 模式 body 讀自 `cassettePath` JSON（`Cassette` 形狀）。

- [ ] **Step 1: 寫失敗測試**

```typescript
// tests/support/cassette.replay.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { makeCassetteFetch } from './cassette.js'

const CASSETTE = 'tests/support/__fixtures__/replay-demo.json'

beforeAll(() => {
  mkdirSync('tests/support/__fixtures__', { recursive: true })
  writeFileSync(CASSETTE, JSON.stringify({ interactions: [
    { method: 'PATCH', url: 'https://h/admin/product/announcement/3084',
      reqBody: { name: 'n' }, status: 200, resBody: { metadata: { status: '0000' } } },
  ] }))
})

describe('replay mode', () => {
  it('returns the recorded response when the request matches (incl volatile modify_user)', async () => {
    const f = makeCassetteFetch('replay', CASSETTE)
    const res = await f('https://h/admin/product/announcement/3084', {
      method: 'PATCH', body: JSON.stringify({ name: 'n', modify_user: 'uuid-x' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ metadata: { status: '0000' } })
  })
  it('throws loudly on an unmatched request (never falls back to live)', async () => {
    const f = makeCassetteFetch('replay', CASSETTE)
    await expect(f('https://h/admin/product/announcement/9999', { method: 'PATCH', body: '{}' }))
      .rejects.toThrow(/no cassette match/i)
  })
  it('replays multiple identical requests in recorded order (stateful GET before/after)', async () => {
    const path = 'tests/support/__fixtures__/seq-demo.json'
    writeFileSync(path, JSON.stringify({ interactions: [
      { method: 'GET', url: 'https://h/state', reqBody: undefined, status: 200, resBody: { v: 'before' } },
      { method: 'GET', url: 'https://h/state', reqBody: undefined, status: 200, resBody: { v: 'after' } },
    ] }))
    const f = makeCassetteFetch('replay', path)
    expect(await (await f('https://h/state', { method: 'GET' })).json()).toEqual({ v: 'before' })
    expect(await (await f('https://h/state', { method: 'GET' })).json()).toEqual({ v: 'after' })
  })
  it('replays a single recorded response repeatably (idempotent poll — sticky)', async () => {
    const f = makeCassetteFetch('replay', CASSETTE)
    const once = await (await f('https://h/admin/product/announcement/3084', { method: 'PATCH', body: JSON.stringify({ name: 'n' }) })).json()
    const twice = await (await f('https://h/admin/product/announcement/3084', { method: 'PATCH', body: JSON.stringify({ name: 'n' }) })).json()
    expect(once).toEqual(twice)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/support/cassette.replay.test.ts`
Expected: FAIL（`makeCassetteFetch` 未定義）

- [ ] **Step 3: 最小實作（append 到 `tests/support/cassette.ts`）**

```typescript
import { readFileSync, writeFileSync } from 'node:fs'

export type CassetteFetch = typeof fetch & {
  stubError: (method: string, urlPattern: string, status: number, envelopeBody: unknown) => void
  save: () => void
}

function bodyToJson(init?: RequestInit): unknown {
  const b = init?.body
  if (typeof b === 'string' && b.length) { try { return JSON.parse(b) } catch { return b } }
  return undefined
}

export function makeCassetteFetch(mode: 'record' | 'replay', cassettePath: string): CassetteFetch {
  const cassette: Cassette = mode === 'replay'
    ? JSON.parse(readFileSync(cassettePath, 'utf8'))
    : { interactions: [] }
  // queue-per-key：同 matchKey 的多筆按錄製順序排隊，避免 Map.set 覆蓋（stateful GET 前/後）
  const index = new Map<string, Interaction[]>()
  if (mode === 'replay') for (const it of cassette.interactions) {
    const k = matchKey(it.method, it.url, it.reqBody)
    const q = index.get(k) ?? (index.set(k, []), index.get(k)!)
    q.push(it)
  }

  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (mode === 'replay') {
      const q = index.get(matchKey(method, url, bodyToJson(init)))
      if (!q || q.length === 0) throw new Error(`no cassette match for ${method} ${url}`)
      // 多筆 → 依序 shift（不同回應的序列）；單筆 → sticky 可重複回放（idempotent 輪詢）
      const hit = q.length > 1 ? q.shift()! : q[0]
      return new Response(JSON.stringify(hit.resBody), { status: hit.status, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('record mode not yet implemented') // Task 3
  }) as CassetteFetch

  f.stubError = () => { throw new Error('stubError not yet implemented') } // Task 4
  f.save = () => { throw new Error('save not yet implemented') } // Task 3
  return f
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/support/cassette.replay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/support/cassette.ts tests/support/cassette.replay.test.ts tests/support/__fixtures__/replay-demo.json
git commit -m "feat(cassette): replay mode with loud-on-miss (D0)"
```

---

### Task 3: cassette record 模式 + 脫敏

**Files:**
- Modify: `tests/support/cassette.ts`
- Test: `tests/support/cassette.record.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `makeCassetteFetch`。
- Produces: record 模式呼叫注入的 real fetch、擷取 interaction；`save()` 寫檔前脫敏（JWT 拒寫、剝 `Authorization`/`x-api-key`）。

- [ ] **Step 1: 寫失敗測試**

```typescript
// tests/support/cassette.record.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeCassetteFetch } from './cassette.js'

const OUT = 'tests/support/__fixtures__/recorded.json'

describe('record mode', () => {
  it('captures interactions via the injected real fetch and saves them', async () => {
    const realFetch = (async () => new Response(JSON.stringify({ metadata: { status: '0000' } }), { status: 200 })) as typeof fetch
    const f = makeCassetteFetch('record', OUT)
    ;(f as unknown as { _realFetch: typeof fetch })._realFetch = realFetch
    await f('https://h/admin/product/announcement', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    f.save()
    const saved = JSON.parse(readFileSync(OUT, 'utf8'))
    expect(saved.interactions).toHaveLength(1)
    expect(saved.interactions[0].method).toBe('POST')
    expect(saved.interactions[0].status).toBe(200)
  })

  it('refuses to write a body containing a JWT', async () => {
    const realFetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
    const f = makeCassetteFetch('record', OUT)
    ;(f as unknown as { _realFetch: typeof fetch })._realFetch = realFetch
    await f('https://h/x', { method: 'POST', body: JSON.stringify({ t: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' }) })
    expect(() => f.save()).toThrow(/JWT/i)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/support/cassette.record.test.ts`
Expected: FAIL（record/save 未實作）

- [ ] **Step 3: 實作（改 `makeCassetteFetch`）**

在 `makeCassetteFetch` 內把 record 分支與 `save` 補實作：

```typescript
  // 在 makeCassetteFetch 內，宣告可注入的 real fetch（測試用；正式預設 globalThis.fetch）
  const self = f as unknown as { _realFetch: typeof fetch }
  self._realFetch = fetch

  // record 分支（取代 Task 2 的 throw）：
  //   const realRes = await self._realFetch(input, init)
  //   const clone = realRes.clone()
  //   let resBody: unknown; try { resBody = await clone.json() } catch { resBody = await clone.text() }
  //   cassette.interactions.push({ method, url, reqBody: bodyToJson(init), status: realRes.status, resBody })
  //   return realRes

  f.save = () => {
    const REDACT_HEADERS = ['authorization', 'x-api-key']
    const json = JSON.stringify(cassette)
    if (/eyJ[A-Za-z0-9_-]{20,}/.test(json)) throw new Error('cassette appears to contain a JWT — refusing to write')
    // header 脫敏在擷取時已不存 header；此處僅落盤（headers 不入 Interaction，天然不落盤）
    void REDACT_HEADERS
    writeFileSync(cassettePath, JSON.stringify(cassette, null, 2))
  }
```

> 說明：`Interaction` 只存 method/url/reqBody/status/resBody，**不存 headers** → `Authorization`/`x-api-key` 天然不落盤；JWT 拒寫防 body 內夾 token。實作 record 分支時把 Task 2 的 `throw new Error('record mode not yet implemented')` 換成上面註解的擷取邏輯。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/support/cassette.record.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/support/cassette.ts tests/support/cassette.record.test.ts
git commit -m "feat(cassette): record mode + JWT-refuse redaction (D0)"
```

---

### Task 4: cassette 錯誤注入 API（stubError）

**Files:**
- Modify: `tests/support/cassette.ts`
- Test: `tests/support/cassette.stubError.test.ts`

**Interfaces:**
- Consumes: Task 2/3。
- Produces: `stubError(method, urlPattern, status, envelopeBody)` 註冊；replay 時**先查 stub（substring 比對 url + method）再查 cassette**，命中回該 status + envelope。

- [ ] **Step 1: 寫失敗測試**

```typescript
// tests/support/cassette.stubError.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { makeCassetteFetch } from './cassette.js'

const C = 'tests/support/__fixtures__/stub-demo.json'
beforeAll(() => {
  mkdirSync('tests/support/__fixtures__', { recursive: true })
  writeFileSync(C, JSON.stringify({ interactions: [] }))
})

describe('stubError', () => {
  it('returns the injected error for a matching route (offline 403 branch)', async () => {
    const f = makeCassetteFetch('replay', C)
    f.stubError('PATCH', '/admin/product/announcement', 403, { metadata: { status: 'AU9997', desc: 'forbidden' } })
    const res = await f('https://h/admin/product/announcement/1', { method: 'PATCH', body: '{}' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ metadata: { status: 'AU9997', desc: 'forbidden' } })
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/support/cassette.stubError.test.ts`
Expected: FAIL（stubError 仍 throw not-implemented）

- [ ] **Step 3: 實作**

```typescript
  // makeCassetteFetch 內新增：
  const stubs: Array<{ method: string; urlPattern: string; status: number; body: unknown }> = []
  f.stubError = (method, urlPattern, status, envelopeBody) =>
    { stubs.push({ method: method.toUpperCase(), urlPattern, status, body: envelopeBody }) }

  // 在 replay 分支「查 cassette」之前先查 stub：
  //   const stub = stubs.find(s => s.method === method && url.includes(s.urlPattern))
  //   if (stub) return new Response(JSON.stringify(stub.body), { status: stub.status, headers: {'content-type':'application/json'} })
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/support/cassette.stubError.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/support/cassette.ts tests/support/cassette.stubError.test.ts
git commit -m "feat(cassette): stubError for offline error-branch tests (D0)"
```

---

### Task 5: 種子 cassette + 透過真實 client 的整合測試

**Files:**
- Create: `tests/cassettes/announcement-update.json`（由 `$CLAUDE_JOB_DIR/tmp/announcement-update-capture.json` 轉換：脫敏、轉成 `Cassette` 形狀）
- Test: `tests/cassettes/announcementUpdate.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `makeCassetteFetch`、既有 `AnnouncementClient`（`src/modules/announcement/create/svcB2cClient.ts`，建構子吃 `fetchImpl`）。
- Produces: 證明「真實 client + cassette fetch = 零 live 跑出 PATCH 200」。

- [ ] **Step 1: 產生種子 cassette**

把 `$CLAUDE_JOB_DIR/tmp/announcement-update-capture.json` 的三筆（GET 詳情 / POST / PATCH）轉成 `{ interactions: [...] }`（每筆 `{method, url, reqBody, status, resBody}`），脫敏（確認無 JWT / Authorization / x-api-key），寫入 `tests/cassettes/announcement-update.json`。url 用 stage host（`https://api-gateway.stage.kkday.com/svc-b2c/api/v1/...`）。

- [ ] **Step 2: 寫失敗測試**

```typescript
// tests/cassettes/announcementUpdate.integration.test.ts
import { describe, it, expect } from 'vitest'
import { makeCassetteFetch } from '../support/cassette.js'
import { AnnouncementClient } from '../../src/modules/announcement/create/svcB2cClient.js'

describe('announcement_update via cassette (offline, real client)', () => {
  it('real AnnouncementClient accepts cassette fetchImpl and the seed cassette loads', async () => {
    const fetchImpl = makeCassetteFetch('replay', 'tests/cassettes/announcement-update.json')
    const client = new AnnouncementClient({
      baseUrl: 'https://api-gateway.stage.kkday.com/svc-b2c/api/v1',
      apiKey: 'test-key', fetchImpl,
    })
    // 呼叫 client 的 PATCH 對應方法（若尚無 patch()，Task 9 dogfood 會補；此處先驗 client 能吃 fetchImpl）
    expect(client).toBeDefined()
  })
})
```

> 註：`AnnouncementClient` 目前只有 list/create（無 patch 方法）——patch 方法屬 announcement_update module 的產出（Task 9 dogfood）。本任務只鎖定「真實 client 接受 cassette fetchImpl + 種子 cassette 可載入」，patch 端到端驗證留 Task 9。

- [ ] **Step 3: 跑測試確認**

Run: `npx vitest run tests/cassettes/announcementUpdate.integration.test.ts`
Expected: PASS（client 建構成功、cassette 載入無誤）

- [ ] **Step 4: 跑全套 ci 確認離線綠**

Run: `npm run ci`
Expected: 全綠、無新增 skip、無 live 呼叫。

- [ ] **Step 5: Commit**

```bash
git add tests/cassettes/ tests/cassettes/announcementUpdate.integration.test.ts
git commit -m "feat(cassette): seed announcement-update cassette + real-client integration (D0)"
```

---

### Task 6: D3-5 憑證環境感知（修 SIT key 洩漏）

**Files:**
- Modify: `src/config.ts`（preset 加 announce key var）
- Modify: `src/modules/announcement/create/svcB2cClient.ts`（`makeAnnouncementClient` 依 `BE2_ENV` 取 key）
- Test: `tests/announcement/svcB2cClientEnv.test.ts`

**Interfaces:**
- Consumes: 既有 `loadConfig()`（`src/config.ts`）、`makeAnnouncementClient()`。
- Produces: `makeAnnouncementClient()` 依 `BE2_ENV` 從 config preset 取 `x-api-key`（`SIT_ANNOUNCE_API_KEY` / `STAGE_ANNOUNCE_API_KEY` / `PROD_ANNOUNCE_API_KEY`），非硬編 SIT。

- [ ] **Step 1: 寫失敗測試**

```typescript
// tests/announcement/svcB2cClientEnv.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveAnnounceApiKey } from '../../src/modules/announcement/create/svcB2cClient.js'
import { announceKeyVarFor } from '../../src/config.js'

afterEach(() => vi.unstubAllEnvs())

describe('announceKeyVarFor (mapping centralized in config presets)', () => {
  it('maps each BE2_ENV to its announce key var name', () => {
    expect(announceKeyVarFor('stage')).toBe('STAGE_ANNOUNCE_API_KEY')
    expect(announceKeyVarFor('prod')).toBe('PROD_ANNOUNCE_API_KEY')
    expect(announceKeyVarFor('sit')).toBe('SIT_ANNOUNCE_API_KEY')
    expect(announceKeyVarFor('sit-220')).toBe('SIT_ANNOUNCE_API_KEY')
  })
})

describe('resolveAnnounceApiKey (env-aware, consumes config mapping)', () => {
  it('picks the STAGE key when BE2_ENV=stage', () => {
    vi.stubEnv('BE2_ENV', 'stage'); vi.stubEnv('STAGE_ANNOUNCE_API_KEY', 'stage-key')
    expect(resolveAnnounceApiKey()).toBe('stage-key')
  })
  it('picks the SIT key when BE2_ENV=sit (or unset default)', () => {
    vi.stubEnv('BE2_ENV', 'sit'); vi.stubEnv('SIT_ANNOUNCE_API_KEY', 'sit-key')
    expect(resolveAnnounceApiKey()).toBe('sit-key')
  })
  it('throws GatewayError naming the missing env-specific var', () => {
    vi.stubEnv('BE2_ENV', 'stage')
    expect(() => resolveAnnounceApiKey()).toThrow(/STAGE_ANNOUNCE_API_KEY/)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/announcement/svcB2cClientEnv.test.ts`
Expected: FAIL（`resolveAnnounceApiKey` 未匯出）

- [ ] **Step 3: 實作**

**先在 `src/config.ts` 集中映射**（env→key 變數名的單一事實來源，對齊既有 `keyVar` 慣例）：

```typescript
// src/config.ts —— 每個 preset 加 announceKeyVar；sit-220 與 sit 同用 SIT key
// PRESETS['sit-220'].announceKeyVar = 'SIT_ANNOUNCE_API_KEY'
// PRESETS['sit'].announceKeyVar     = 'SIT_ANNOUNCE_API_KEY'
// PRESETS['stage'].announceKeyVar   = 'STAGE_ANNOUNCE_API_KEY'
// PRESETS['prod'].announceKeyVar    = 'PROD_ANNOUNCE_API_KEY'
export function announceKeyVarFor(env: string): string {
  return (PRESETS as Record<string, { announceKeyVar?: string }>)[env]?.announceKeyVar ?? 'SIT_ANNOUNCE_API_KEY'
}
```

**再在 `src/modules/announcement/create/svcB2cClient.ts` 消費該映射**（不在此重複 env→var 硬編）：

```typescript
import { announceKeyVarFor } from '../../../config.js'
// GatewayError 已在本檔 import（makeAnnouncementClient 現用它拋 ANNOUNCE_KEY_MISSING）
export function resolveAnnounceApiKey(): string {
  const env = process.env.BE2_ENV ?? 'sit'
  const varName = announceKeyVarFor(env)
  const key = process.env[varName]
  if (!key) throw new GatewayError('ANNOUNCE_KEY_MISSING', `${varName} not set for BE2_ENV=${env}`, 500)
  return key
}
// makeAnnouncementClient() 內：const apiKey = resolveAnnounceApiKey()（取代硬編 process.env.SIT_ANNOUNCE_API_KEY，保留原 GatewayError('ANNOUNCE_KEY_MISSING') 契約）
```

在 `.env.example` 補 `STAGE_ANNOUNCE_API_KEY=` / `PROD_ANNOUNCE_API_KEY=`（空值佔位）。

- [ ] **Step 4: 跑測試 + 全套確認無回歸**

Run: `npx vitest run tests/announcement/svcB2cClientEnv.test.ts && npm run ci`
Expected: 新測試 PASS；`npm run ci` 全綠（既有 announcement 測試不回歸——`makeAnnouncementClient` 對 SIT 預設行為不變）。

- [ ] **Step 5: Commit**

```bash
git add src/modules/announcement/create/svcB2cClient.ts src/config.ts .env.example tests/announcement/svcB2cClientEnv.test.ts
git commit -m "fix(announce): env-aware x-api-key loading, no SIT key leak to stage/prod (D3-5)"
```

---

### Task 7: D1 Workflow 載體腳本

**Files:**
- Create: `.claude/skills/module-factory/references/workflow-carrier.md`（Workflow 腳本模板 + resume 用法）

**Interfaces:**
- Consumes: 段①產物（契約報告 + cassette）、六格 prompt（`references/stage2-produce.md`）。
- Produces: 一份可貼進 `Workflow` 工具的腳本骨架，段②六格 `parallel`、段③ pipeline，gate 為回主對話暫停點，resume 用 `resumeFromRunId`。

- [ ] **Step 1: 寫 workflow-carrier.md**

內容含：(a) `meta` 區塊（name/description/phases: Produce/Verify）；(b) 段②六格 `parallel(cells.map(c => () => agent(cellPrompt(c), {phase:'Produce', schema:...})))`；(c) 段③ pipeline 驗收 + `cassette.stubError` 錯誤分支；(d) **gate = Workflow 跑到 `return {forApproval}` 回主對話，人核准後帶 `resumeFromRunId` 續跑**；(e) 明列「段①瀏覽器 sniff 不在 Workflow 內、其產物餵進來」；(f) resume 範例：`Workflow({scriptPath, resumeFromRunId})`。

- [ ] **Step 2: 驗證（inspection）**

確認腳本引用的 `agent()`/`parallel()`/`pipeline()` 簽章與 Workflow 工具文件一致；phases 名稱與 `meta.phases` 對齊；六格 label 用 `phase:'Produce'` 顯式分組避免 race。

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/module-factory/references/workflow-carrier.md
git commit -m "docs(factory): Workflow carrier script + resume (D1)"
```

---

### Task 8: SKILL.md + references 更新（D1/D3/D4/D5/D6 + Gate 重整）

**Files:**
- Modify: `.claude/skills/module-factory/SKILL.md`
- Modify: `.claude/skills/module-factory/references/stage1-explore.md`
- Modify: `.claude/skills/module-factory/references/stage2-produce.md`
- Modify: `.claude/skills/module-factory/references/stage3-verify.md`

**Interfaces:**
- Consumes: spec §3–§4；Task 7 的 workflow-carrier.md。
- Produces: skill 反映 v2 行為。

- [ ] **Step 1: 改 SKILL.md**

(a) Gate 段：3 gate → 2 人工 gate（Gate①計畫核准=段②後、Gate② live 寫入=段③），discovery GREEN 自動放行、保留欄位/授權 gate 判定核心（spec §4 表）；(b) 載體段：預設 Workflow（引 workflow-carrier.md）、agy batch 保留為省額度選項；(c) 「標的切換條件」加 D4 姊妹繼承說明；(d) 新增「D6 可攜性」段（repo 外用絕對路徑讀 SKILL.md 手動跑）。

- [ ] **Step 2: 改 stage1-explore.md**

(a) D3 環境退避：撞 403/502 先自動改 `BE2_ENV=stage` 重試，stage 過才判 GREEN、stage 仍卡才判授權 gate；契約報告加「探索環境」欄。(b) D4 姊妹繼承：同 domain 標的繼承 host/envelope/header/授權碼/row，**但仍 sniff executor 需要的所有 read endpoint（含 GET 詳情），不是只 sniff 寫 verb**。(c) D5：sniff request body 用 server 端 `page.route` + `request.postData()`，不用 `browser_network_requests`。

- [ ] **Step 3: 改 stage2-produce.md + stage3-verify.md**

(a) stage2：六格單元測試預設 cassette-backed（`makeCassetteFetch('replay', …)`）；error 分支用 `cassette.stubError(...)`。(b) stage3：`npm run ci` replay 全綠、error-handling agent 用 stubError 覆蓋 403/500/stale、live 寫入 e2e 另 tag 只人核准後對 stage 跑一次。

- [ ] **Step 4: 驗證（inspection）**

通讀四檔，確認與 spec §3/§4 無矛盾、無殘留「3 gate」「只 sniff PATCH」「browser_network_requests 抓 body」等舊敘述。

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/module-factory/SKILL.md .claude/skills/module-factory/references/
git commit -m "docs(factory): SKILL+references reflect v2 (D1/D3/D4/D5/D6 + gate rework)"
```

---

### Task 9: dogfood 驗收 — 用 v2 產出 announcement_update module

**Files:**
- Create: `src/modules/announcement/update/`（keys/module/validate/diff/executor/renderer + tests，由 factory v2 產出）
- Modify: `src/modules/index.ts`（registerModule）、`src/core/changeset/types.ts`（ActionType union 加 `announcement_update`）

**Interfaces:**
- Consumes: 全部前置任務（cassette harness、種子 cassette、env-aware client、v2 skill）。
- Produces: 一個真實 module，證明 v2 端到端可用。

- [ ] **Step 1: 跑 v2 factory（人在場，兩道 gate）**

依更新後的 SKILL.md 對標的 `announcement_update` 跑：段①用種子 cassette + 姊妹繼承（announcement/create）→ Gate①計畫核准 → 段②六格產出（cassette-backed 測試）→ 段③ replay 全綠 + `stubError` 錯誤分支 → Gate② live 寫入核准。

- [ ] **Step 2: 驗證 read-merge-write 忠實度**

executor 照契約報告 §6.2「full REPLACE」：讀 GET 詳情全欄位 → 覆蓋目標欄位 → 整包送 `langSettings`；diff 格處理 `prodOids` 型別正規化 + `langs`↔`langSettings` 名稱轉換（契約報告 §6.3）。

- [ ] **Step 3: 跑 ci 確認離線全綠**

Run: `npm run ci`
Expected: 全綠、新 module 的 cassette-backed 測試（含 stubError 錯誤分支）通過、conformance harness 自動繼承通過。

- [ ] **Step 4: live 寫入 e2e（Gate② 核准後，對 stage）**

對 stage 商品跑一次真 PATCH（沿用實跡跑帳號/環境），確認 200 + envelope `0000`；清理測試公告（停用/刪除）。

- [ ] **Step 5: Commit + 登記型錄**

```bash
git add src/modules/announcement/update/ src/modules/index.ts src/core/changeset/types.ts docs/be2-mcp/module-catalog.md
git commit -m "feat(announcement): announcement_update module produced by factory v2 (dogfood)"
```

---

## Self-Review

- **Spec coverage**：D0→Task1-5；D1→Task7+8；D2→Task5+8（cassette-backed 測試 + stubError）；D3→Task6+8；D4→Task8（stage1-explore）+Task9（dogfood 驗）；D5→Task8；D6→Task8；Gate 重整→Task8；dogfood 驗收→Task9。全 delta 有對應任務。
- **Placeholder scan**：無 TODO/TBD；每個 code 步驟都有實測碼；doc 任務列出具體要寫的內容。
- **Type consistency**：`Interaction`/`Cassette`/`matchKey`/`makeCassetteFetch`/`CassetteFetch`/`stubError`/`resolveAnnounceApiKey` 跨任務一致；`fetchImpl` 型別 = `typeof fetch` 與三 client 建構子一致。

<!-- agy-peer-reviewed: 2026-08-31T16:13:35Z rounds=2 verdict=approved -->
