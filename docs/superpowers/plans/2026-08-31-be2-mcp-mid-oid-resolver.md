# be2-mcp 商品 mid→prod_oid 防呆解析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓所有吃商品 ID 的 be2-mcp 工具能接受 be2-web 網址上的 `prod_mid`,自動解析成內部 `prod_oid`,消滅「複製網址數字當 oid → 舊商品 404 / 新商品靜默查錯」的隱蔽 bug。

**Architecture:** 新增一支 `resolveProdOid(s)`(全域 in-memory cache、per-mid 局部失敗),在受影響工具的 handler 開頭把 `prod_mid(s)` 解析成 canonical `prod_oid` 後再走原邏輯;canonical oid 才進 scope-gate 與 `read_oids`。解析對應透過 `Envelope.resolved_ids` 曝光給 agent。反方向誤用(把 mid 當 oid 傳)在 404 時由 `toEnvelopeErrorWithMidHint` 附加提示句。

**Tech Stack:** TypeScript (ESM, `.js` import specifier)、zod、vitest。gateway 走既有 `GatewayClient.get`。

## Global Constraints

- **每個新增/改動的 zod schema 用 raw shape 物件**(`const inputShape = { ... }`),直接餵 `server.registerTool` 的 `inputSchema`(見 `src/server/app.ts:198-232`)。**全 repo 無 `.refine()` 用例、SDK `inputSchema` 不接 `ZodObject`**,故 spec §5.2 的「zod `.refine()` 擋兩陣列皆空」**落地改為 handler 開頭手動驗證**(回 400 系列 envelope error),與 spec §5.1 productPlans 的手動驗證一致。此為 plan 對 spec 的唯一落地偏差,理由如上。
- **ESM import 一律帶 `.js` 副檔名**(如 `from './envelope.js'`),即使原始檔是 `.ts`。
- **canonical oid 才進 `read_oids` / scope-gate**,不使用原始輸入(維持既有 spec §6.2 scope-binding 一致性)。
- **mid 解析失敗走 per-item 局部失敗,不整批拋出**(對齊 `find_products` 既有「Per-oid failures are reported in `errors` without failing the batch」保證)。單一 ID 工具(`get_product_plans`)無批次概念,解析失敗直接轉成該工具唯一 error。
- **兩者都給且不一致 → 明確報錯,不悄悄擇一**(不猜測精神)。
- **cache 無 TTL / 無失效**(mid↔oid 一旦建立不變,程序生命週期內全域快取即可)。
- **憑證/token 永不 log、永不進 fixture**(CLAUDE.md 鐵則)。
- 每個 Task 結束跑 `npm run ci`(= `typecheck` + `test`)必須全綠。

---

## File Structure

**新檔:**
- `src/gateway/prodOidResolver.ts` — `resolveProdOid` / `resolveProdOids` + 全域 `midToOidCache`。單一職責:mid→oid 解析。
- `tests/prodOidResolver.test.ts` — resolver 單元測試(mock gateway)。
- `tests/envelope.test.ts` — `makeEnvelope` resolved_ids + `toEnvelopeErrorWithMidHint` 單元測試(目前無此測試檔)。

**改動:**
- `src/tools/envelope.ts` — `Envelope.resolved_ids` 選填欄位 + `makeEnvelope` 第四參數 + 新增 `toEnvelopeErrorWithMidHint` helper。
- `src/tools/productPlans.ts` — 單一 ID schema(`prod_mid?`/`prod_oid?` 擇一)+ handler(解析 + 一致性驗證)。
- `src/tools/findProducts.ts` — 陣列必填 schema(`prod_mids?`/`prod_oids?`)+ handler + `toEnvelopeErrorWithMidHint` 套用。
- `src/tools/appTools.ts` — `appGetBatchViewTool`、`appGetAnnouncementViewTool` 陣列必填 schema + handler。
- `src/tools/openBatchWizard.ts`、`src/tools/openAnnouncementWizard.ts`、`src/tools/openWorkbench.ts` — 陣列選填 prefill schema + handler(不加「至少一項」驗證,允許開空白面板)。

**不改動:** `src/tools/batchView.ts`(純 library function,無 schema)、`src/tools/inventorySettings.ts`(吃 item_oid,無關)、`src/core/changeset/tools.ts` 與各 module `itemSchema`(spec §7.5 範圍排除)。

---

## Task 1: Envelope 擴充(resolved_ids + toEnvelopeErrorWithMidHint)

**Files:**
- Modify: `src/tools/envelope.ts`
- Test: `tests/envelope.test.ts`(Create)

**Interfaces:**
- Consumes: 既有 `EnvelopeError`、`toEnvelopeError`、`UNTRUSTED_NOTE`。
- Produces:
  - `interface Envelope` 新增 `resolved_ids?: Array<{ mid: string; oid: string }>`。
  - `makeEnvelope(items, errors?, readOids?, resolvedIds?)` — 第四參數 `resolvedIds?: Array<{ mid: string; oid: string }>`;僅當非空時才寫入 `resolved_ids`(向後相容,既有以 `toEqual` 比整個 envelope 的測試不會多出欄位)。
  - `toEnvelopeErrorWithMidHint(key: string, e: unknown): EnvelopeError` — `status === 404` 時在 message 後附提示句,否則行為等同 `toEnvelopeError`。

- [ ] **Step 1: 寫失敗測試**

Create `tests/envelope.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeEnvelope, toEnvelopeError, toEnvelopeErrorWithMidHint } from '../src/tools/envelope.js'

describe('makeEnvelope resolved_ids', () => {
  it('resolvedIds 非空時帶出 resolved_ids', () => {
    const env = makeEnvelope([], [], [], [{ mid: '10759', oid: '38352' }])
    expect(env.resolved_ids).toEqual([{ mid: '10759', oid: '38352' }])
  })
  it('未給或空陣列時不帶 resolved_ids 欄位(向後相容)', () => {
    expect('resolved_ids' in makeEnvelope([])).toBe(false)
    expect('resolved_ids' in makeEnvelope([], [], [], [])).toBe(false)
  })
})

describe('toEnvelopeErrorWithMidHint', () => {
  it('404 附加 mid 提示句', () => {
    const e = Object.assign(new Error('GET .../switch -> 404: not_found'), { status: 404 })
    const out = toEnvelopeErrorWithMidHint('546965', e)
    expect(out.status).toBe(404)
    expect(out.message).toContain('prod_mid')
    expect(out.message).toContain('not_found')
  })
  it('非 404 行為等同 toEnvelopeError', () => {
    const e = Object.assign(new Error('boom'), { status: 500, code: 'X' })
    expect(toEnvelopeErrorWithMidHint('k', e)).toEqual(toEnvelopeError('k', e))
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/envelope.test.ts`
Expected: FAIL — `toEnvelopeErrorWithMidHint` is not exported / `resolved_ids` undefined。

- [ ] **Step 3: 實作**

Edit `src/tools/envelope.ts` — `Envelope` 介面加欄位:

```ts
export interface Envelope {
  data_origin: 'be2_content'
  untrusted_note: string
  items: unknown[]
  errors: EnvelopeError[]
  read_oids: string[]
  resolved_ids?: Array<{ mid: string; oid: string }>
}
```

`makeEnvelope` 改簽名:

```ts
export function makeEnvelope(
  items: unknown[], errors: EnvelopeError[] = [], readOids: string[] = [],
  resolvedIds?: Array<{ mid: string; oid: string }>,
): Envelope {
  const env: Envelope = { data_origin: 'be2_content', untrusted_note: UNTRUSTED_NOTE, items, errors, read_oids: readOids }
  if (resolvedIds && resolvedIds.length) env.resolved_ids = resolvedIds
  return env
}
```

檔尾新增(`toEnvelopeError` 之後):

```ts
const MID_HINT =
  ' (若這個數字是從 be2-web 網址複製的,它可能其實是 prod_mid 而非 prod_oid — 請改用 prod_mid 欄位查詢。)'

export function toEnvelopeErrorWithMidHint(key: string, e: unknown): EnvelopeError {
  const base = toEnvelopeError(key, e)
  if (base.status === 404) return { ...base, message: base.message + MID_HINT }
  return base
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/envelope.test.ts`
Expected: PASS(4 tests)。

- [ ] **Step 5: 回歸 + commit**

Run: `npm run ci`
Expected: 全綠(既有測試不受影響——`resolved_ids` 選填、`makeEnvelope` 第四參數選填)。

```bash
git add src/tools/envelope.ts tests/envelope.test.ts
git commit -m "feat(envelope): add resolved_ids + toEnvelopeErrorWithMidHint for mid resolver"
```

---

## Task 2: prodOidResolver(核心解析器)

**Files:**
- Create: `src/gateway/prodOidResolver.ts`
- Test: `tests/prodOidResolver.test.ts`

**Interfaces:**
- Consumes: `GatewayClient.get(path, accessToken)`(`src/gateway/client.ts`,對非 2xx 直接 throw `GatewayError`)、`GatewayError`(`src/errors.ts`,`new GatewayError(code, message, status)`)、`toEnvelopeError` / `EnvelopeError`(`src/tools/envelope.ts`)。
- Produces:
  - `resolveProdOid(mid: string, gateway: GatewayClient, accessToken: string): Promise<string>` — 回 canonical oid;cache hit 不打 API;失敗 throw 帶提示的 `GatewayError`。
  - `resolveProdOids(mids: string[], oids: string[], gateway, accessToken): Promise<{ resolved: string[]; resolutions: Array<{ mid: string; oid: string }>; errors: EnvelopeError[] }>` — per-mid 局部失敗;`resolved` = `[...oids, ...成功解析的 oid]`。

- [ ] **Step 1: 寫失敗測試**

Create `tests/prodOidResolver.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resolveProdOid, resolveProdOids, __clearMidCache } from '../src/gateway/prodOidResolver.js'
import { GatewayError } from '../src/errors.js'

// mock gateway:依 path 回傳或拋出;記錄呼叫次數。
function mkGateway(handler: (path: string) => unknown) {
  let calls = 0
  return {
    calls: () => calls,
    gw: { get: async (path: string) => { calls++; const r = handler(path); if (r instanceof Error) throw r; return r } } as never,
  }
}

beforeEach(() => __clearMidCache())

describe('resolveProdOid', () => {
  it('cache miss 打 API 一次,cache hit 不再打', async () => {
    const { gw, calls } = mkGateway(() => ({ prod_oid: 38352 }))
    expect(await resolveProdOid('10759', gw, 't')).toBe('38352')
    expect(await resolveProdOid('10759', gw, 't')).toBe('38352')
    expect(calls()).toBe(1)
  })

  it('mid 解析失敗(gateway throw 404)→ 重拋帶提示的 MID_RESOLVE_FAILED,保留 status', async () => {
    const { gw } = mkGateway(() => new GatewayError('HTTP_404', 'GET .../mid-999/info -> 404: not_found', 404))
    await expect(resolveProdOid('999', gw, 't')).rejects.toMatchObject({ code: 'MID_RESOLVE_FAILED', status: 404 })
  })

  it('非 404 錯誤(如 403 無權)原樣 rethrow,不改寫成 MID_RESOLVE_FAILED(codex Issue 3)', async () => {
    const { gw } = mkGateway(() => new GatewayError('AU9403', 'GET .../mid-1/info -> 403: no permission', 403))
    // 保留 be2 原始 code/status,不誤報成「填錯欄位」。
    await expect(resolveProdOid('1', gw, 't')).rejects.toMatchObject({ code: 'AU9403', status: 403 })
  })

  it('成功回傳但缺 prod_oid 欄位 → MID_RESOLVE_FAILED(500)', async () => {
    const { gw } = mkGateway(() => ({ something_else: 1 }))
    await expect(resolveProdOid('123', gw, 't')).rejects.toMatchObject({ code: 'MID_RESOLVE_FAILED', status: 500 })
  })
})

describe('resolveProdOids', () => {
  it('mids 與 oids 合併為 resolved,resolutions 對應正確', async () => {
    const { gw } = mkGateway((p) => p.includes('mid-10759') ? { prod_oid: 38352 } : { prod_oid: 35992 })
    const out = await resolveProdOids(['10759', '2247'], ['100'], gw, 't')
    expect(out.resolved.sort()).toEqual(['100', '35992', '38352'])
    expect(out.resolutions).toEqual([{ mid: '10759', oid: '38352' }, { mid: '2247', oid: '35992' }])
    expect(out.errors).toEqual([])
  })

  it('部分 mid 失敗 → 成功者進 resolved/resolutions,失敗者進 errors(不整批拋出)', async () => {
    const { gw } = mkGateway((p) => p.includes('mid-10759') ? { prod_oid: 38352 } : new GatewayError('HTTP_404', 'not_found', 404))
    const out = await resolveProdOids(['10759', '999'], [], gw, 't')
    expect(out.resolved).toEqual(['38352'])
    expect(out.resolutions).toEqual([{ mid: '10759', oid: '38352' }])
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].key).toBe('999')
  })

  it('dedup:重複 mid 只打一次 API;resolved 與 oids 重疊時去重', async () => {
    const { gw, calls } = mkGateway(() => ({ prod_oid: '38352' }))
    const out = await resolveProdOids(['10759', '10759'], ['38352'], gw, 't')
    expect(calls()).toBe(1)                                  // 重複 mid 不 stampede
    expect(out.resolutions).toEqual([{ mid: '10759', oid: '38352' }])
    expect(out.resolved).toEqual(['38352'])                 // oids 與解出 oid 重疊 → 去重
  })

  it('分批:mid 解析階段並發不超過 5(對齊 find_products gateway burst 控制,codex Issue 5)', async () => {
    let inFlight = 0, peak = 0
    const gw = { get: async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--; return { prod_oid: '1' }
    } } as never
    await resolveProdOids(Array.from({ length: 12 }, (_, i) => String(i)), [], gw, 't')
    expect(peak).toBeLessThanOrEqual(5)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/prodOidResolver.test.ts`
Expected: FAIL — module `../src/gateway/prodOidResolver.js` not found。

- [ ] **Step 3: 實作**

Create `src/gateway/prodOidResolver.ts`:

```ts
import type { GatewayClient } from './client.js'
import { GatewayError } from '../errors.js'
import { toEnvelopeError, type EnvelopeError } from '../tools/envelope.js'

// mid → prod_oid 是商品目錄的靜態事實(不是 session 行為記錄),全域共用、不分 session。
// mid↔oid 一旦建立即不變(oid 自增主鍵、mid 獨立序列,皆不重新指派),故無 TTL / 失效機制。
// 全域(不分 user)是刻意決策(spec §7.3 + §4 codex 註記):cache 只存「mid↔oid 編號對照」非機密靜態
// 事實,不存商品內容;真正商品讀取(packages/info/switch 等)仍走各 user 自己 token 的 per-user gate,
// 授權邊界不因 cache 失守。若日後 mid-info 端點被賦予 per-user 機密語義,再改 per-user cache。
const midToOidCache = new Map<string, string>()

// 僅供測試重置 cache;正式碼不呼叫。
export function __clearMidCache(): void { midToOidCache.clear() }

export async function resolveProdOid(mid: string, gateway: GatewayClient, accessToken: string): Promise<string> {
  const cached = midToOidCache.get(mid)
  if (cached) return cached
  let info: unknown
  try {
    info = await gateway.get(`/product/api/v1/drafts/products/mid-${encodeURIComponent(mid)}/info`, accessToken)
  } catch (e) {
    // gateway.get 對非 2xx 一律 throw GatewayError(見 client.ts#unwrap,已保留 be2 原始 code/status)。
    // 只有 404「找不到商品」才是 mid 混淆的徵兆 → 改寫成 MID_RESOLVE_FAILED + 提示;其餘(403 無權、
    // 500/502 gateway 故障、network)原樣 rethrow,保留原始 code/status,不誤報成「填錯欄位」(codex Issue 3)。
    const status = (e as { status?: number })?.status
    if (status !== 404) throw e
    throw new GatewayError(
      'MID_RESOLVE_FAILED',
      `mid ${mid} 找不到對應商品。若你是從 be2-web 網址複製這個數字,它可能其實是 prod_oid 而非 prod_mid,請改用 prod_oid 欄位。`,
      404,
    )
  }
  const oid = String((info as Record<string, unknown>)?.prod_oid ?? '')
  if (!oid) {
    throw new GatewayError('MID_RESOLVE_FAILED', `mid ${mid} 的商品資訊缺少 prod_oid 欄位,請確認 mid 正確或聯絡開發`, 500)
  }
  midToOidCache.set(mid, oid)
  return oid
}

export async function resolveProdOids(
  mids: string[], oids: string[], gateway: GatewayClient, accessToken: string,
): Promise<{ resolved: string[]; resolutions: Array<{ mid: string; oid: string }>; errors: EnvelopeError[] }> {
  // dedup mids:同批傳入的重複 mid 在 cache 寫入前一起發出,會 stampede 同一支 mid-info API;去重後
  // 每個唯一 mid 只解析一次(resolutions 亦為每個唯一 mid 一筆)。
  const uniqMids = [...new Set(mids)]
  const resolutions: Array<{ mid: string; oid: string }> = []
  const errors: EnvelopeError[] = []
  // 分批(每批 ≤5)對齊 find_products 既有 gateway burst 控制(5-oid 一批、峰值 ≤10 GET),避免最多 20 個
  // unique mid 瞬間打 20 個 mid-info GET 再進商品查詢的 regression(codex Issue 5)。
  for (let i = 0; i < uniqMids.length; i += 5) {
    const batch = uniqMids.slice(i, i + 5)
    const settled = await Promise.allSettled(batch.map(mid => resolveProdOid(mid, gateway, accessToken)))
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') resolutions.push({ mid: batch[j], oid: s.value })
      else errors.push(toEnvelopeError(batch[j], s.reason))
    })
  }
  // dedup resolved:oids 與 mid 解出的 oid 若重疊(同一商品同時以 mid 與 oid 傳入,或兩 mid 指同一 oid),
  // 去重避免下游(find_products / buildBatchView)重複 fetch 與回傳同一 record。保留首次出現順序。
  return { resolved: [...new Set([...oids, ...resolutions.map(r => r.oid)])], resolutions, errors }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/prodOidResolver.test.ts`
Expected: PASS(5 tests)。

- [ ] **Step 5: commit**

Run: `npm run ci`
Expected: 全綠。

```bash
git add src/gateway/prodOidResolver.ts tests/prodOidResolver.test.ts
git commit -m "feat(gateway): add prodOidResolver (mid->oid, global cache, per-item failure)"
```

---

## Task 3: get_product_plans 接單一 ID 解析

**Files:**
- Modify: `src/tools/productPlans.ts`
- Test: `tests/productPlans.test.ts`

**Interfaces:**
- Consumes: `resolveProdOid`(Task 2)、`makeEnvelope` 第四參數 + `toEnvelopeError` / `toEnvelopeErrorWithMidHint`(Task 1)。
- Produces: `productPlansTool.inputShape` 改為 `{ prod_mid?, prod_oid? }`;handler 解析 `prod_mid` → canonical oid,`resolved_ids` 帶出。

- [ ] **Step 1: 寫失敗測試**(擴充既有 `tests/productPlans.test.ts` 的 `describe('be2_get_product_plans')`)

在既有 describe 內新增 4 個 it(沿用檔案既有 `ctxWith` helper 與 `pkgs` fixture):

```ts
it('只給 prod_mid → 呼叫 resolver、底層打 canonical oid、resolved_ids 帶出', async () => {
  const env = await productPlansTool.handler({ prod_mid: '10759' } as never,
    ctxWith({ 'mid-10759/info': { prod_oid: 38352 }, '/packages': pkgs, '/package-configs': { config_data: { k1: { is_active: true } } } }))
  expect(env.items).toEqual([{ pkg_oid: 'k1', item_oid: 'i1', name: '標準方案', is_active: true }])
  expect(env.resolved_ids).toEqual([{ mid: '10759', oid: '38352' }])
  expect(env.read_oids).toContain('38352')
})

it('只給 prod_oid → 不呼叫 resolver、無 resolved_ids', async () => {
  const env = await productPlansTool.handler({ prod_oid: 'p1' } as never,
    ctxWith({ '/packages': pkgs, '/package-configs': { config_data: { k1: { is_active: true } } } }))
  expect('resolved_ids' in env).toBe(false)
  expect(env.read_oids).toContain('p1')
})

it('兩者皆空 → MISSING_ID error,不打任何 API', async () => {
  const env = await productPlansTool.handler({} as never, ctxWith({}))
  expect(env.items).toEqual([])
  expect(env.errors[0].code).toBe('MISSING_ID')
})

it('兩者都給且解析結果不一致 → MID_OID_MISMATCH,不悄悄擇一', async () => {
  const env = await productPlansTool.handler({ prod_mid: '10759', prod_oid: '999' } as never,
    ctxWith({ 'mid-10759/info': { prod_oid: 38352 } }))
  expect(env.errors[0].code).toBe('MID_OID_MISMATCH')
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/productPlans.test.ts`
Expected: FAIL — handler 尚未支援 `prod_mid`。

- [ ] **Step 3: 實作**

Edit `src/tools/productPlans.ts`:

import 行加 resolver 與 hint helper:

```ts
import { makeEnvelope, toEnvelopeError, toEnvelopeErrorWithMidHint } from './envelope.js'
import { resolveProdOid } from '../gateway/prodOidResolver.js'
```

`inputShape` 改為:

```ts
const inputShape = {
  prod_mid: z.string().min(1).optional()
    .describe('be2-web URL product number (mid). Provide this OR prod_oid — pick whichever you have.'),
  prod_oid: z.string().min(1).optional()
    .describe('be2 product internal oid whose plans (packages) to list.'),
}
```

handler 開頭(取代 `const oid = encodeURIComponent(args.prod_oid)`):

```ts
async handler(args, ctx) {
  if (!args.prod_mid && !args.prod_oid) {
    return makeEnvelope([], [{ key: 'input', code: 'MISSING_ID', message: 'Provide prod_mid or prod_oid.' }])
  }
  let canonical = args.prod_oid
  let resolvedIds: Array<{ mid: string; oid: string }> | undefined
  if (args.prod_mid) {
    try {
      const r = await resolveProdOid(args.prod_mid, ctx.gateway, ctx.accessToken)
      // 兩者都給時驗證一致,不悄悄以其中一個為準。
      if (canonical && canonical !== r) {
        return makeEnvelope([], [{ key: 'input', code: 'MID_OID_MISMATCH',
          message: `prod_mid ${args.prod_mid} resolves to oid ${r}, which conflicts with prod_oid ${canonical}.` }])
      }
      canonical = r
      resolvedIds = [{ mid: args.prod_mid, oid: r }]
    } catch (e) {
      return makeEnvelope([], [toEnvelopeError(args.prod_mid, e)])
    }
  }
  // 僅在使用者確實用 prod_oid 欄位查詢(非 mid)時,對商品查詢 404 附「你可能誤用 mid」提示。
  const fatalErr = (args.prod_oid && !args.prod_mid) ? toEnvelopeErrorWithMidHint : toEnvelopeError
  const oid = encodeURIComponent(canonical!)
  const [pkgsResult, cfgResult] = await Promise.allSettled([
    ctx.gateway.get(`/product/api/v1/drafts/products/${oid}/packages`, ctx.accessToken),
    ctx.gateway.get(`/product/api/v1/products/${oid}/package-configs`, ctx.accessToken),
  ])
  if (pkgsResult.status === 'rejected') {
    return makeEnvelope([], [fatalErr(canonical!, pkgsResult.reason)])
  }
  const cfg = cfgResult.status === 'fulfilled' ? normalizePackageConfigs(cfgResult.value) : new Map()
  const items = extractPackages(pkgsResult.value).map(p => ({
    pkg_oid: p.pkg_oid, item_oid: p.item_oid, name: p.name,
    is_active: cfg.get(p.pkg_oid)?.is_active,
  }))
  const readOids = [canonical!, ...items.flatMap(i => [i.pkg_oid, i.item_oid].filter((x): x is string => !!x))]
  const errors = cfgResult.status === 'rejected' ? [toEnvelopeError(canonical!, cfgResult.reason)] : []
  return makeEnvelope(items, errors, readOids, resolvedIds)
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/productPlans.test.ts`
Expected: PASS(既有 5 + 新增 4)。既有測試傳 `{ prod_oid: 'p1' }` 走 prod_oid 路徑,`read_oids` 首項仍是 `'p1'`(canonical === 原 oid),行為不變。

- [ ] **Step 5: commit**

Run: `npm run ci`
Expected: 全綠。

```bash
git add src/tools/productPlans.ts tests/productPlans.test.ts
git commit -m "feat(productPlans): accept prod_mid, resolve to canonical oid with consistency check"
```

---

## Task 4: find_products 接陣列解析 + 反向 404 提示

**Files:**
- Modify: `src/tools/findProducts.ts`
- Test: `tests/findProducts.test.ts`

**Interfaces:**
- Consumes: `resolveProdOids`(Task 2)、`makeEnvelope` 第四參數 + `toEnvelopeError` / `toEnvelopeErrorWithMidHint`(Task 1)。
- Produces: `inputShape` 改 `{ prod_mids?, prod_oids? }`(兩者皆 optional,handler 手動驗證至少一項);handler 合併解析、`resolved_ids` 帶出、原始 oid 查詢 404 附提示。
- `lookupOne` 簽名加第三參數 `fromMid: boolean`,決定 error 用 hint 版與否。

- [ ] **Step 1: 寫失敗測試**(擴充 `tests/findProducts.test.ts`;檔案既有 `ctxWith`(第 7 行)mock gateway,沿用之)

**先替換既有 schema 斷言**(第 26-31 行的 `it('schema rejects >20 oids and empty list', ...)`)——`prod_oids` 移除 `.min(1)` 後空陣列在 schema 層變合法,原 `safeParse({ prod_oids: [] }).success).toBe(false)` 會翻成 `true`、CI red。整段替換為:

```ts
it('schema rejects >20 oids/mids; empty arrays now allowed at schema level (handler enforces ≥1)', () => {
  const schema = z.object(findProductsTool.inputShape)
  expect(schema.safeParse({ prod_oids: [] }).success).toBe(true)   // 空陣列 schema 層合法(optional);≥1 由 handler 擋
  expect(schema.safeParse({}).success).toBe(true)                   // 皆省略亦合法
  expect(schema.safeParse({ prod_oids: Array.from({ length: 21 }, (_, i) => `p${i}`) }).success).toBe(false)
  expect(schema.safeParse({ prod_mids: Array.from({ length: 21 }, (_, i) => `m${i}`) }).success).toBe(false)
  expect(schema.safeParse({ prod_oids: ['p1'] }).success).toBe(true)
})
```

「兩陣列皆空 → MISSING_ID」改由下方 handler 測試涵蓋。**再新增** handler 測試:

```ts
it('prod_mids 與 prod_oids 合併,resolved_ids 帶出', async () => {
  const env = await findProductsTool.handler({ prod_mids: ['10759'], prod_oids: ['p1'] } as never,
    ctxWith({ 'mid-10759/info': { prod_oid: '38352' }, '/info': { name: 'X' }, '/switch': { is_active: true } }))
  expect(env.resolved_ids).toEqual([{ mid: '10759', oid: '38352' }])
  expect(env.read_oids.sort()).toEqual(['38352', 'p1'])
})

it('其中一個 mid 解析失敗 → 該筆進 errors,其餘商品仍正常回傳(不拖垮整批)', async () => {
  const env = await findProductsTool.handler({ prod_mids: ['10759', '999'], prod_oids: [] } as never,
    ctxWith({
      'mid-10759/info': { prod_oid: '38352' },
      'mid-999/info': Object.assign(new Error('404'), { status: 404 }),
      '/info': { name: 'X' }, '/switch': { is_active: true },
    }))
  expect(env.items).toHaveLength(1)
  expect(env.errors.some(e => e.key === '999')).toBe(true)
})

it('兩陣列皆空 → MISSING_ID', async () => {
  const env = await findProductsTool.handler({ prod_mids: [], prod_oids: [] } as never, ctxWith({}))
  expect(env.errors[0].code).toBe('MISSING_ID')
})

it('直接用 prod_oid 查詢卻 404 → 錯誤訊息含 mid 提示', async () => {
  const boom = Object.assign(new Error('GET .../info -> 404: not_found'), { status: 404 })
  const env = await findProductsTool.handler({ prod_oids: ['546965'] } as never,
    ctxWith({ '/info': boom, '/switch': boom }))
  expect(env.errors[0].message).toContain('prod_mid')
})
```

> 註:`ctxWith` 若 findProducts.test.ts 尚無等價 helper,依 productPlans.test.ts 的 `ctxWith`(mock `gateway.get` 依 path 片段回傳/拋出)在本檔頂部補一份。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/findProducts.test.ts`
Expected: FAIL — handler 尚未支援 `prod_mids`。

- [ ] **Step 3: 實作**

Edit `src/tools/findProducts.ts`:

import 行:

```ts
import { makeEnvelope, toEnvelopeError, toEnvelopeErrorWithMidHint, type EnvelopeError } from './envelope.js'
import { resolveProdOids } from '../gateway/prodOidResolver.js'
```

`inputShape`:

```ts
const inputShape = {
  prod_mids: z.array(z.string().min(1)).max(20).optional()
    .describe('be2-web URL product numbers (mid). Resolved to canonical oid and merged with prod_oids.'),
  prod_oids: z.array(z.string().min(1)).max(20).optional()
    .describe('be2 product internal oids to look up (exact match). Provide prod_mids and/or prod_oids, ≥1 total.'),
}
```

`lookupOne` 加 `fromMid` 參數,error 分流:

```ts
async function lookupOne(oid: string, ctx: ToolContext, fromMid: boolean): Promise<{ item?: unknown; error?: EnvelopeError }> {
  const [info, sw] = await Promise.allSettled([
    ctx.gateway.get(`/product/api/v1/drafts/products/${encodeURIComponent(oid)}/info`, ctx.accessToken),
    ctx.gateway.get(`/product/api/v1/product-configs/${encodeURIComponent(oid)}/switch`, ctx.accessToken),
  ])
  if (info.status === 'rejected' && sw.status === 'rejected') {
    // 原始 prod_oid 輸入的 404 → 附 mid 提示;mid 解析出的 oid → 普通錯誤(使用者本來就用 mid 欄位)。
    const errFn = fromMid ? toEnvelopeError : toEnvelopeErrorWithMidHint
    return { error: errFn(oid, info.reason) }
  }
  const base = info.status === 'fulfilled' ? extractProductInfo(info.value) : {}
  const swVal = sw.status === 'fulfilled' ? (sw.value as Record<string, unknown>) : {}
  return {
    item: {
      prod_oid: oid, name: base.name, workflow_status: base.workflow_status,
      is_active: swVal.is_active, is_locked_for_active: swVal.is_locked_for_active,
    },
  }
}
```

handler:

```ts
async handler(args, ctx) {
  const { resolved, resolutions, errors: resolveErrors } =
    await resolveProdOids(args.prod_mids ?? [], args.prod_oids ?? [], ctx.gateway, ctx.accessToken)
  if (resolved.length === 0 && resolveErrors.length === 0) {
    return makeEnvelope([], [{ key: 'input', code: 'MISSING_ID', message: 'Provide prod_mids or prod_oids (≥1 total).' }])
  }
  const midOids = new Set(resolutions.map(r => r.oid))
  // Max 5 oids in flight (2 requests each) — never burst the gateway with 40 concurrent GETs.
  const results: Array<{ item?: unknown; error?: EnvelopeError }> = []
  for (let i = 0; i < resolved.length; i += 5) {
    results.push(...await Promise.all(resolved.slice(i, i + 5).map(oid => lookupOne(oid, ctx, midOids.has(oid)))))
  }
  return makeEnvelope(
    results.filter(r => r.item).map(r => r.item),
    [...resolveErrors, ...results.filter(r => r.error).map(r => r.error!)],
    results.filter(r => r.item).map(r => (r.item as { prod_oid: string }).prod_oid),
    resolutions,
  )
}
```

同步更新 tool `description` 末句(反映 mid 支援):在既有 description 後補 `' Accepts prod_mids (be2-web URL numbers) and/or prod_oids.'`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/findProducts.test.ts`
Expected: PASS。既有測試若以 `{ prod_oids: [...] }` 呼叫,走 oids-only 路徑(resolveProdOids 對空 mids 不打 API),行為不變。

> ⚠️ 若既有測試以 `prod_oids` 為必填前提斷言(如 `min(1)` 的 zod reject 測試),該斷言需改寫:min(1) 已移除,「空陣列」改由 handler 回 `MISSING_ID`。在 Step 1 一併調整。

- [ ] **Step 5: commit**

Run: `npm run ci`
Expected: 全綠。

```bash
git add src/tools/findProducts.ts tests/findProducts.test.ts
git commit -m "feat(findProducts): accept prod_mids, merge to canonical oids, reverse 404 mid hint"
```

---

## Task 5: app_get_batch_view / app_get_announcement_view 接陣列解析

**Files:**
- Modify: `src/tools/appTools.ts`(`appGetBatchViewTool`、`appGetAnnouncementViewTool`)
- Test: `tests/appTools.test.ts`

**Interfaces:**
- Consumes: `resolveProdOids`(Task 2)、`makeEnvelope` 第四參數(Task 1)、既有 `buildBatchView`。
- Produces: 兩工具 `inputShape` 的 `prod_oids` 改 optional + 新增 `prod_mids?`;handler 先解析再走原邏輯,canonical oid 進 `buildBatchView` / 公告迴圈與 `read_oids`。

- [ ] **Step 1: 寫失敗測試**(擴充 `tests/appTools.test.ts`)

**先擴充檔頂 `ctx(over)` helper**(第 6-20 行)。既有 helper 只給 changeSets/nonces——既有測試從沒呼叫過 `appGetBatchViewTool.handler`(只測其 zod),但新測試會呼叫 handler,handler 開頭立即 `ctx.rateBudget.consume(ctx.userLabel, ctx.sessionId)` 並用 `ctx.gateway` / `ctx.scheduleTz`,缺這些會 `TypeError: Cannot read properties of undefined`。在 `return { ... }` 內、`changeSets:` 之前補預設:

```ts
function ctx(over: Partial<any> = {}) {
  return {
    userLabel: 'alice', baseUrl: 'http://127.0.0.1:8787', sessionId: 's1',
    accessToken: 'fake-jwt',
    scheduleTz: 'Asia/Taipei',
    rateBudget: { consume: () => {} },   // 新測試呼叫 handler 需要;既有 zod-only 測試不受影響
    changeSets: { /* ...既有不動... */ },
    nonces: new ApprovalNonceStore(),
    ...over,   // gateway 由各測試自帶 mock 路由 override
  } as any
}
```

同時檔頂 import 補 `appGetAnnouncementViewTool`(既有只 import 了 `appGetBatchViewTool`):

```ts
import { appGetChangesetViewTool, appGetConfirmLinkTool, appGetBatchViewTool, appGetAnnouncementViewTool } from '../src/tools/appTools.js'
```

**再新增** handler 測試(每個測試 `ctx({ gateway: {...} })` 帶自己的 mock 路由):

```ts
it('app_get_batch_view: prod_mids 解析成 canonical oid 後進 buildBatchView,resolved_ids 帶出', async () => {
  const env = await appGetBatchViewTool.handler(
    { action_type: 'shelf_schedule', prod_mids: ['10759'], prod_oids: [] } as never,
    ctx({ gateway: { get: async (p: string) =>
      p.includes('mid-10759') ? { prod_oid: '38352' } : { /* buildBatchView 下游最小回應 */ } } }))
  expect(env.resolved_ids).toEqual([{ mid: '10759', oid: '38352' }])
  expect(env.read_oids).toContain('38352')
})

it('app_get_batch_view: 兩陣列皆空 → MISSING_ID', async () => {
  const env = await appGetBatchViewTool.handler(
    { action_type: 'shelf_schedule', prod_mids: [], prod_oids: [] } as never, ctx({}))
  expect(env.errors[0].code).toBe('MISSING_ID')
})

it('app_get_announcement_view: prod_mids 解析後迴圈用 canonical oid,resolved_ids 帶出', async () => {
  const env = await appGetAnnouncementViewTool.handler(
    { prod_mids: ['2247'], prod_oids: [] } as never,
    ctx({ gateway: { get: async (p: string) =>
      p.includes('mid-2247') ? { prod_oid: '35992' } : { name: 'X' } } }))
  expect(env.resolved_ids).toEqual([{ mid: '2247', oid: '35992' }])
  expect(env.read_oids).toContain('35992')
})
```

> 註:`buildBatchView` 對每個 action_type 的下游讀取形狀不同;測試以「解析出的 oid 是否出現在 read_oids / resolved_ids」為斷言重點,mock gateway 回最小可用形狀即可(可參照 appTools.test.ts 既有 batch view 測試的 mock)。若既有檔無 batch view 測試 mock 範本,先讀 `src/tools/batchView.ts` 的 `buildBatchView` 下游 path 再擬 mock。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/appTools.test.ts`
Expected: FAIL — handler 尚未支援 `prod_mids`。

- [ ] **Step 3: 實作**

Edit `src/tools/appTools.ts`:

import 行加:

```ts
import { resolveProdOids } from '../gateway/prodOidResolver.js'
```

`appGetBatchViewTool.inputShape`:

```ts
inputShape: {
  action_type: z.enum(['inventory_platform', 'shelf_schedule', 'inventory_setting', 'shelf_toggle_product', 'shelf_toggle_plan', 'shelf_toggle_bundle']),
  prod_mids: z.array(z.string().min(1)).max(10).optional(),
  prod_oids: z.array(z.string().min(1)).max(10).optional(),
} as never,
```

`appGetBatchViewTool.handler`:

```ts
async handler(args, ctx: AppToolContext) {
  ctx.rateBudget.consume(ctx.userLabel, ctx.sessionId)
  const { resolved, resolutions, errors: resolveErrors } =
    await resolveProdOids(args.prod_mids ?? [], args.prod_oids ?? [], ctx.gateway, ctx.accessToken)
  if (resolved.length === 0 && resolveErrors.length === 0) {
    return makeEnvelope([], [{ key: 'input', code: 'MISSING_ID', message: 'Provide prod_mids or prod_oids.' }])
  }
  const { products, errors, read_oids } = await buildBatchView(
    ctx.gateway, ctx.accessToken, args.action_type as BatchViewActionType, resolved,
  )
  return makeEnvelope([{ products, schedule_tz: ctx.scheduleTz }], [...resolveErrors, ...errors], read_oids, resolutions)
}
```

`appGetAnnouncementViewTool.inputShape`:

```ts
inputShape: {
  prod_mids: z.array(z.string().min(1)).max(10).optional(),
  prod_oids: z.array(z.string().min(1)).max(10).optional(),
} as never,
```

`appGetAnnouncementViewTool.handler` 開頭(取代 `const prodOids = args.prod_oids as string[]`):

```ts
async handler(args, ctx: AppToolContext) {
  ctx.rateBudget.consume(ctx.userLabel, ctx.sessionId)
  const { resolved: prodOids, resolutions, errors: resolveErrors } =
    await resolveProdOids(args.prod_mids ?? [], args.prod_oids ?? [], ctx.gateway, ctx.accessToken)
  if (prodOids.length === 0 && resolveErrors.length === 0) {
    return makeEnvelope([], [{ key: 'input', code: 'MISSING_ID', message: 'Provide prod_mids or prod_oids.' }])
  }
  const errors: EnvelopeError[] = [...resolveErrors]
  // ... 以下既有邏輯不變(client / counts / for-of prodOids 迴圈)...
  // 迴圈與 counts 皆改用上面解出的 prodOids(canonical);既有 push error 續用 errors 陣列。
  return makeEnvelope([{ products }], errors, prodOids, resolutions)
}
```

> 實作註:`appGetAnnouncementViewTool` 中段的 `client` / `counts` / `for (const oid of prodOids)` 區塊維持原樣,只是 `prodOids` 來源從 `args.prod_oids` 換成解析結果、`errors` 初值改為 `[...resolveErrors]`、最末 `makeEnvelope` 加第四參數 `resolutions`。
>
> **既有債不擴大處理(codex Issue 4,spec §7.7)**:此工具中段迴圈即使某 oid 的 `info` GET 失敗(push 進 `errors`),仍把該 oid 放進 `products` 並列入 `read_oids`——「解析成功但實際讀取 403/404」的 canonical oid 因此仍可能通過 change-set 的 `SCOPE_NOT_READ` gate。這是**本次改動前就存在的行為**,本 task 維持原樣(把 `prod_oids` 換成 canonical oid,不改變登記時機)。§5.2「canonical oid 才進 scope-gate」指「進 gate 的是解析後的 oid,非原始 mid」,不宣稱「只有讀取成功的 oid 才進 gate」。要收緊另開 issue。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/appTools.test.ts`
Expected: PASS。既有 batch/announcement view 測試若以 `prod_oids: [...]` 呼叫,走 oids-only 路徑,行為不變。

> 經實查 `tests/appTools.test.ts` 無 `appGetAnnouncementViewTool` / `appGetBatchViewTool` 的 `min(1)` 或空陣列 reject 斷言;現有 schema 測試只驗合法 `prod_oids: ['1']` 可接受,因此 Step 1 無需替換既有斷言。

- [ ] **Step 5: commit**

Run: `npm run ci`
Expected: 全綠。

```bash
git add src/tools/appTools.ts tests/appTools.test.ts
git commit -m "feat(appTools): batch/announcement view accept prod_mids, canonical oid into scope-gate"
```

---

## Task 6: `open_workbench` 接 prefill 解析(唯一 model-visible 開面板工具)

> **codex review 收斂(2026-08-31)**:原稿改三支開面板工具,但 `src/server/app.ts` 的 model-visible `TOOLS` **只註冊 `openWorkbenchTool`**;`open_batch_wizard`/`open_announcement_wizard` 未註冊(`tests/serverTools.test.ts` 斷言二者不在 `TOOLS`),是 dead tool,改了 agent 也呼叫不到。**本 task 只改 `openWorkbench.ts`。** 另注意(spec §5.3 已知限制):`workbench` 面板 UI 不消費本工具回的 prefill payload、輸入框只送 `prod_oids`——故本改動的生效面是「agent 帶 `prod_mids` 直接呼叫 `be2_open_workbench`」時 tool result 帶出 canonical oid + `resolved_ids`;**面板手動貼 mid 的 UI 支援是 follow-up(spec §7.6),不在本 task**。

**Files:**
- Modify: `src/tools/openWorkbench.ts`
- Test: `tests/openWorkbench.test.ts`(既有檔,擴充)
- **不改動(dead tool)**:`src/tools/openBatchWizard.ts`、`src/tools/openAnnouncementWizard.ts` 及其既有測試(`tests/openBatchWizard.test.ts`、`tests/announcement/openAnnouncementWizard.test.ts`)——維持原樣仍綠。

**Interfaces:**
- Consumes: `resolveProdOids`(Task 2)、`makeEnvelope` 第四參數(Task 1)。
- Produces: `openWorkbenchTool.inputShape` 新增 `prod_mids?`;handler 從無 ctx 改為吃 `ctx`,僅在有輸入時解析,**兩者皆空仍開空白面板**(不加「至少一項」驗證)。

- [ ] **Step 1: 寫失敗測試**(擴充 `tests/openWorkbench.test.ts`)

在既有 `describe('be2_open_workbench')` 內新增(既有測試不動——它們用 `{} as never` ctx、走 oids-only/空白路徑,不觸發 resolver):

```ts
it('給 prod_mids → 解析成 canonical oid prefill、resolved_ids 帶出', async () => {
  const gw = { get: async (p: string) => p.includes('mid-10759') ? { prod_oid: '38352' } : {} }
  const env = await openWorkbenchTool.handler(
    { feature: 'inventory', prod_mids: ['10759'] } as never, { gateway: gw, accessToken: 't' } as never)
  expect(env.items).toEqual([{ feature: 'inventory', prod_oids: ['38352'] }])
  expect(env.resolved_ids).toEqual([{ mid: '10759', oid: '38352' }])
})

it('兩者皆空 → 仍開空白面板(不呼叫 resolver、無 error)', async () => {
  const env = await openWorkbenchTool.handler({} as never, {} as never)
  expect(env.items).toEqual([{ feature: null, prod_oids: [] }])
  expect(env.errors).toEqual([])
})

it('input schema 接受 prod_mids', () => {
  const schema = z.object(openWorkbenchTool.inputShape)
  expect(schema.safeParse({ feature: 'inventory', prod_mids: ['10759'] }).success).toBe(true)
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/openWorkbench.test.ts`
Expected: FAIL — schema 無 `prod_mids` / handler 不解析。

- [ ] **Step 3: 實作**

`src/tools/openWorkbench.ts` — import 加 `import { resolveProdOids } from '../gateway/prodOidResolver.js'`;`inputShape` 加 `prod_mids`(上限維持 20):

```ts
const inputShape = {
  feature: z.enum(['shelf', 'inventory', 'announce']).optional(),
  prod_mids: z.array(z.string().min(1)).max(20).optional(),
  prod_oids: z.array(z.string().min(1)).max(20).optional(),
}
```

handler(從 `async handler(args)` 改為吃 `ctx`):

```ts
async handler(args, ctx) {
  const mids = args.prod_mids ?? []
  const oids = args.prod_oids ?? []
  if (mids.length === 0 && oids.length === 0) return makeEnvelope([{ feature: args.feature ?? null, prod_oids: [] }])
  const { resolved, resolutions, errors } = await resolveProdOids(mids, oids, ctx.gateway, ctx.accessToken)
  return makeEnvelope([{ feature: args.feature ?? null, prod_oids: resolved }], errors, [], resolutions)
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/openWorkbench.test.ts`
Expected: PASS。既有測試(給 `prod_oids: ['34133']` 或空 args)走 oids-only / 空白路徑,不需 gateway,行為不變。

- [ ] **Step 5: commit**

Run: `npm run ci`
Expected: 全綠(dead tool 的既有測試不受影響,未改動)。

```bash
git add src/tools/openWorkbench.ts tests/openWorkbench.test.ts
git commit -m "feat(openWorkbench): accept prod_mids prefill (only live open-panel tool)"
```

---

## Task 7: 整合驗證 + fixture 文件 + 全鏈路回歸

**Files:**
- Create/Modify: `docs/be2-mcp/sit-write-contracts.md`(補「mid→oid resolver」節,記錄 SIT 舊商品 fixture pair)
- Test: 既有 fixture-gated 整合測試慣例(對 SIT be2-220,`describe.skipIf` 守門)

**Interfaces:** 無新程式介面;本 task 驗證真實環境行為並固化 fixture。

- [ ] **Step 1: 找 `prod_oid ≠ prod_mid` 的舊商品**

在 SIT be2-220(或 stage)以 Playwright / 已知登入 flow 打 `GET /product/api/v1/drafts/products/mid-{mid}/info`,找一個 `prod_oid ≠ prod_mid` 的**舊商品**,記錄其 `(mid, oid)` pair。**用近期新建商品無效**——`oid == mid` 時 resolver 沒接上也會碰巧通過(spec §8 驗收陷阱)。spec §2.3 已知候選:`mid-10759 → oid 38352`、`mid-2247 → oid 35992`。

- [ ] **Step 2: 寫整合測試**(fixture-gated,對真實 SIT;沿用 repo 既有 live e2e 慣例,`describe.skipIf(!process.env.<LIVE_GATE>)`)

```ts
// 整合 11:用 prod_mid 呼叫 get_product_plans,底層確實查 canonical oid
it('live: prod_mid 解析後查到 canonical oid 的方案資料', async () => {
  const env = await productPlansTool.handler({ prod_mid: '<舊商品 mid>' } as never, liveCtx())
  expect(env.resolved_ids?.[0]).toMatchObject({ mid: '<舊商品 mid>', oid: '<舊商品 oid>' })
  expect(env.read_oids).toContain('<舊商品 oid>')
})

// 整合 12:把 mid 誤當 prod_oid 丟給 find_products → errors 含對稱提示
it('live: mid 誤當 prod_oid → 404 提示', async () => {
  const env = await findProductsTool.handler({ prod_oids: ['<舊商品 mid>'] } as never, liveCtx())
  expect(env.errors.some(e => (e.message ?? '').includes('prod_mid'))).toBe(true)
})
```

> 註:`liveCtx()` = 用真實 bearer 建 `ToolContext`(gateway 指 be2-220),沿用 Phase 1a live 驗收既有做法。無 live gate 時整段 skip,不算失敗。

- [ ] **Step 3: 記錄 fixture 到文件**

在 `docs/be2-mcp/sit-write-contracts.md` 新增一節「## mid→oid resolver fixture」,記錄:
- 選用的舊商品 `(mid, oid)` pair 與環境(be2-220 / stage)。
- `mid-{mid}/info` 端點回傳中 `prod_oid` 欄位的實際位置(頂層 or 巢狀)——若非頂層,回報並在 Task 2 的 `resolveProdOid` 取值處補 fallback(視為 bugfix,補測試)。
- 巧合相等案例(如 `mid=oid=2358`)標註為「不可作為驗收 fixture」。

- [ ] **Step 4: 全鏈路回歸**

Run: `npm run ci`
Expected: 全綠(所有既有受影響工具測試 + 新增測試)。

Run(可選,有 live gate 時): 整合測試對 be2-220 綠;`change-set` 相關測試不受影響(spec §7.5 範圍排除)。

- [ ] **Step 5: commit**

```bash
git add docs/be2-mcp/sit-write-contracts.md tests/
git commit -m "test(resolver): live SIT integration + record prod_oid≠prod_mid fixture"
```

---

## Self-Review(對照 spec 逐項)

**Spec coverage:**
- §4 resolver(cache / per-item 失敗 / MID_RESOLVE_FAILED)→ Task 2 ✓
- §4 反向 404 對稱提示(`toEnvelopeErrorWithMidHint`)→ Task 1 定義、Task 3/4 套用 ✓;§4 明載「app_get_batch_view/announcement_view 暫不套用 hint」→ Task 5 不套 hint(只接 resolver)✓
- §5.1 單一 ID 工具 + 一致性驗證 → Task 3 ✓
- §5.2 陣列必填(find_products / batch_view / announcement_view)+ canonical oid 進 scope-gate → Task 4/5 ✓
- §5.3 三支選填 prefill 工具、允許空白面板 → Task 6 ✓
- §6 Envelope.resolved_ids + makeEnvelope 第四參數 → Task 1 ✓
- §7 非目標(item/pkg/supplier、change-set、batchView.ts、inventorySettings.ts 不碰)→ File Structure「不改動」列明 ✓
- §8 測試計畫(fixture 陷阱、單元、per-tool、整合、回歸)→ Task 2/3/4/5/6/7 對應 ✓

**落地偏差(已標註,供 agy review):**
- spec §5.2「zod `.refine()` 擋兩陣列皆空」→ 因 codebase inputShape 為 raw shape、SDK `inputSchema` 不接 `ZodObject`(全 repo 零 refine 用例),落地改為 handler 開頭手動驗證回 `MISSING_ID`。功能等價(皆擋「兩陣列皆空」),與 §5.1 手動驗證一致。見 Global Constraints。

**codex cross-model review 修正(2026-08-31,已落地本 plan + spec):**
- **Issue 1(scope 收斂)**:`open_batch_wizard`/`open_announcement_wizard` 未註冊為 model-visible(dead tool)→ Task 6 只改 `open_workbench`;`workbench` 面板 UI 不消費 prefill、手動貼 mid 不生效 → resolver 生效面收斂為「agent 對話直呼工具」,面板 UI mid 列 follow-up(spec §5.3 已知限制 + §7.6)。
- **Issue 3**:resolver catch 只在 `status===404` 改寫 `MID_RESOLVE_FAILED`,其餘 status 原樣 rethrow → Task 2 handler + 新增 403-rethrow 測試。
- **Issue 5**:`resolveProdOids` 內部分批(每批 ≤5)+ Set dedup 對齊 `find_products` 既有 burst 控制 → Task 2。
- **Issue 2**:全域 cache 不分 session 經評估維持(oid 非機密、下游 per-user gate),trade-off 留痕 → Task 2 cache 註解 + spec §4/§7.3。
- **Issue 4**:`app_get_announcement_view` 既有 read-oid 登記破口(讀取失敗仍登記)為既有債,本次不擴大處理 → spec §7.7 follow-up + Task 5 註記。
- **Issue 6**:`mid-info` 的 `prod_oid` 頂層取值未經 repo 實證 → Task 7 Step 3 live 驗證 + 非頂層時補 fallback。

**Placeholder scan:** 無 TBD / 「add error handling」等;每個 code step 附完整程式碼。

**Type consistency:**
- `resolveProdOid(mid, gateway, accessToken)` / `resolveProdOids(mids, oids, gateway, accessToken)` 回傳型別在 Task 2 定義,Task 3-6 消費一致。
- `makeEnvelope` 第四參數 `resolvedIds?: Array<{ mid: string; oid: string }>` 在 Task 1 定義,Task 3-6 傳入的 `resolutions` / `resolvedIds` 同型。
- `toEnvelopeErrorWithMidHint(key, e)` 簽名一致(Task 1 定義,Task 3/4 使用)。
- `lookupOne(oid, ctx, fromMid)` 三參數在 Task 4 內自洽。

---

## Execution Handoff

Plan 完成,存於 `docs/superpowers/plans/2026-08-31-be2-mcp-mid-oid-resolver.md`。**下一步照 CLAUDE.md 主管線:先過 `agy-peer-review` 交叉審到 APPROVED,再進 subagent-driven-development + TDD。**

<!-- agy-peer-reviewed: 2026-09-02T02:55:28Z rounds=3 verdict=approved -->
