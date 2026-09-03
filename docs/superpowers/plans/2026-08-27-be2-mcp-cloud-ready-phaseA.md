# be2-mcp cloud-ready Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 be2-mcp 能以單副本容器化部署到 stage EKS：修掉 3 個硬阻斷（loopback bind、Host 白名單、OAuth URL 硬編 127.0.0.1）+ 補上線工程（build/Dockerfile、/readyz、SIGTERM graceful）。

**Architecture:** 全部落在「新增 config env → 注入既有接線點」+「新增 build/容器 artifact」，不動 change-set 狀態機、store schema、OAuth 核心。狀態仍是單檔 SQLite（HA/Postgres/Redis 明確排除，留 Phase C）。

**Tech Stack:** Node 22 LTS、TypeScript(NodeNext ESM)、Express 5、better-sqlite3、vitest、esbuild(UI)、Docker multi-stage。

**來源 spec：** `docs/superpowers/specs/2026-08-27-be2-mcp-cloud-ready-phaseA-design.md`（agy rounds=3 approved）。

## Global Constraints

- **Node 22 LTS**（`.nvmrc` + `engines: {"node": ">=22 <23"}`；Docker base `node:22-bookworm-slim`，glibc 對齊 `better-sqlite3@^13` prebuild）。
- **憑證永不 commit / 永不印出**；config 錯誤只印 key 名不印值（既有 `config.ts:62-63` 不可回退）。
- **不動治理核心**：change-set 狀態機、`audit_log` append-only trigger、redirect_uri client loopback allowlist（`redirectUri.ts`）、Host guard 對非白名單一律 403。
- **不引入** Postgres / Redis / 多副本 / k8s manifests / app 層 token 加密（皆非本波，見 spec §16）。
- **TDD**：每個 code task 先寫失敗測試 → 最小實作 → 綠 → commit。測試 harness 沿用既有：config 直呼 `loadConfig(env)`；server 測試 `openDb(':memory:')` + `buildApp({config, db})` + `node:http` `createServer` + `listen(0)` + `fetch`。
- **每個 task 結束 `npm run ci` 必須綠**（`build:ui && typecheck && test`）。

---

## File Structure

- `src/config.ts`（改）：`EnvSchema` + `Config` 加 `bindHost`、`publicBaseUrl`；`loadConfig` 填值。
- `src/server/app.ts`（改）：`baseUrl`（:142）與 discovery（:255）改用 `config.publicBaseUrl`；`/healthz` 之後、`buildHostGuard()` 之前新增 `GET /readyz`。
- `src/otel.ts`（改）：module-level `sdk`，匯出 `async shutdownOtel()`，移除自帶 SIGTERM listener。
- `src/core/schedule/scheduler.ts`（改）：`start()` 回傳型別改 `() => Promise<void>`（stopper 等 in-flight tick）。
- `src/server/shutdown.ts`（新）：`makeShutdown(deps)` — 可注入、可測的關機協調者。
- `src/index.ts`（改）：bind `config.bindHost`；hoist `db`；接 `makeShutdown` + `shutdownOtel` + scheduler stopper。
- `tsconfig.build.json`（新）：build 專用（include src+scripts，排除 eval/tests）。
- `package.json`（改）：`build`、`start` script。
- `Dockerfile`（新）、`.nvmrc`（新）、`package.json` `engines`（改）。
- `docs/be2-mcp/deploy-architecture.md` / 新 `docs/be2-mcp/cloud-ready-phaseA-runbook.md`（改/新）：容器化怎麼跑 + DevOps env 契約。
- 測試：`tests/config.test.ts`（擴）、`tests/oauthDiscovery.test.ts`（擴）、`tests/readyz.test.ts`（新）、`tests/otelShutdown.test.ts`（新）、`tests/schedulerGracefulStop.test.ts`（新）、`tests/serverShutdown.test.ts`（新）、+ 13 個既有 Config-literal 測試補兩欄。

---

## Task 1: Config 新增 bindHost + publicBaseUrl

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`
- Modify（補兩欄的 Config literal，見 Step 6）：`tests/serverIntegration.test.ts`, `tests/scheduleCancel.test.ts`, `tests/oauthDiscovery.test.ts`, `tests/devPanelRoutes.test.ts`, `tests/oauthAuthorize.test.ts`, `tests/confirmConnections.test.ts`, `tests/capabilityGate.test.ts`, `tests/oauthRegister.test.ts`, `tests/toolAnnotations.test.ts`, `tests/phase2bSecurity.test.ts`, `tests/oauthRevoke.test.ts`, `tests/dnsRebinding.test.ts`, `tests/oauthToken.test.ts`

**Interfaces:**
- Produces: `Config.bindHost: string`、`Config.publicBaseUrl: string`（皆必填，`loadConfig` 一律填值）。後續 Task 2/6 消費。

- [ ] **Step 1: 寫失敗測試（config.test.ts 追加）**

```ts
  it('defaults bindHost to 127.0.0.1 and allows override', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).bindHost).toBe('127.0.0.1')
    expect(loadConfig({ ...base, APP_BIND_HOST: '0.0.0.0' } as NodeJS.ProcessEnv).bindHost).toBe('0.0.0.0')
  })

  it('publicBaseUrl falls back to loopback when unset, honours override and strips trailing slash', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).publicBaseUrl).toBe('http://127.0.0.1:8787')
    expect(loadConfig({ ...base, APP_PORT: '9000' } as NodeJS.ProcessEnv).publicBaseUrl).toBe('http://127.0.0.1:9000')
    expect(loadConfig({ ...base, APP_BASE_URL: 'https://mcp.stage.kkday.com/' } as NodeJS.ProcessEnv).publicBaseUrl)
      .toBe('https://mcp.stage.kkday.com')
  })

  it('rejects a non-URL publicBaseUrl without echoing its value', () => {
    expect(() => loadConfig({ ...base, APP_BASE_URL: 'not-a-url' } as NodeJS.ProcessEnv))
      .toThrowError(/APP_BASE_URL/)
  })
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL（`bindHost`/`publicBaseUrl` 不存在於 Config；新案例紅）

- [ ] **Step 3: 改 `src/config.ts`**

`EnvSchema`（`config.ts:28-37`）加兩行：
```ts
  APP_BIND_HOST: z.string().default('127.0.0.1'),
  APP_BASE_URL: z.string().url().optional(),
```
`Config` interface（`config.ts:39-47`）加兩欄：
```ts
  bindHost: string
  publicBaseUrl: string
```
`loadConfig` return（`config.ts:78-86`）前計算並補回傳：
```ts
  const publicBaseUrl = (e.APP_BASE_URL ?? `http://127.0.0.1:${e.APP_PORT}`).replace(/\/$/, '')
  return {
    authsvcUrl: e.AUTHSVC_URL.replace(/\/$/, ''),
    gatewayUrl: e.GATEWAY_URL.replace(/\/$/, ''),
    serviceKey,
    port: e.APP_PORT,
    dbPath,
    otelMode: e.OTEL_MODE,
    scheduleTz: e.APP_TZ,
    bindHost: e.APP_BIND_HOST,
    publicBaseUrl,
  }
```
> **注意**：欄位鍵是 `e.OTEL_MODE`（大寫，EnvSchema 定義的鍵），沿用原 `config.ts:84` 的 `otelMode: e.OTEL_MODE`，勿誤打小寫（會變 `undefined` → tsc 型別不符）。此 return 只是在原本欄位後追加 `bindHost`/`publicBaseUrl` 兩行，其餘欄位維持原樣。
> 注意：`z.string().url()` 對 `not-a-url` 會讓 `safeParse` 失敗，錯誤路徑含 `APP_BASE_URL`，走既有「只印 key 名」分支（`config.ts:60-64`），值不外洩。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: 跑 typecheck 找出所有缺欄的 Config literal**

Run: `npx tsc --noEmit`
Expected: FAIL —— 13 個測試檔的 Config literal 缺 `bindHost`/`publicBaseUrl`（TS2739）。逐一列出。

- [ ] **Step 6: 為 13 個 Config literal 補兩欄**

在上列每個檔案的 Config 物件字面值（辨識特徵：含 `otelMode: 'off'` 與 `scheduleTz:`）補：
```ts
    bindHost: '127.0.0.1', publicBaseUrl: `http://127.0.0.1:${/* 該 literal 既有的 port，通常 0 或 8787 */''}`,
```
實作準則：該 literal 的 `port` 是多少，`publicBaseUrl` 就寫 `http://127.0.0.1:<那個 port>`（多數是 `port: 0` → 寫 `'http://127.0.0.1:0'`；固定字串即可，這些測試不真的依賴 URL 內容，除 `oauthDiscovery.test.ts` 於 Task 2 另外精確設值）。

- [ ] **Step 7: 跑 typecheck + 全測試確認綠**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS（全綠）

- [ ] **Step 8: Commit**

```bash
git add src/config.ts tests/
git commit -m "feat(config): add bindHost + publicBaseUrl env (cloud-ready Phase A)"
```

---

## Task 2: 阻斷 #3 — public base URL 注入 app.ts

**Files:**
- Modify: `src/server/app.ts:142`, `src/server/app.ts:255`
- Test: `tests/oauthDiscovery.test.ts`

**Interfaces:**
- Consumes: `config.publicBaseUrl`（Task 1）。
- Produces: discovery / confirm_url / WWW-Authenticate 全部輸出 `config.publicBaseUrl`。

- [ ] **Step 1: 改 oauthDiscovery.test.ts —— 用具體 publicBaseUrl 精確斷言**

把 `beforeAll` 的 config literal 改為帶固定 public base（取代 Task 1 補的佔位）：
```ts
  const config: Config = {
    authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
    serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off', scheduleTz: 'Asia/Taipei',
    bindHost: '127.0.0.1', publicBaseUrl: 'https://mcp.stage.example',
  }
```
新增/改寫斷言：
```ts
    expect(body.issuer).toBe('https://mcp.stage.example')
    expect(body.authorization_endpoint).toBe('https://mcp.stage.example/oauth/authorize')
    expect(body.token_endpoint).toBe('https://mcp.stage.example/oauth/token')
    expect(body.registration_endpoint).toBe('https://mcp.stage.example/oauth/register')
    expect(body.revocation_endpoint).toBe('https://mcp.stage.example/oauth/revoke')
```
protected-resource 測試改：`expect(body.resource).toBe('https://mcp.stage.example')` 與 `authorization_servers` 同。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/oauthDiscovery.test.ts`
Expected: FAIL（現在 issuer 仍是硬編 `http://127.0.0.1:0`，非 `https://mcp.stage.example`）

- [ ] **Step 3: 改 `src/server/app.ts`**

- `app.ts:142`：`const baseUrl = \`http://127.0.0.1:${config.port}\`` → `const baseUrl = config.publicBaseUrl`
- `app.ts:255`：`buildDiscoveryRouter({ baseUrl: \`http://127.0.0.1:${config.port}\` })` → `buildDiscoveryRouter({ baseUrl: config.publicBaseUrl })`

（下游 `l2Context`/`appPipeline`/`toolPipeline`/`ssoRoutes baseOrigin`/`discoveryRoutes` 皆吃傳入的 `baseUrl`，無需改。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/oauthDiscovery.test.ts`
Expected: PASS

- [ ] **Step 5: 全測試回歸**

Run: `npx vitest run`
Expected: PASS（serverIntegration 等既有測試不依賴具體 baseUrl 內容；若有斷言 loopback 的，改成讀 config.publicBaseUrl——實作時若紅再修）

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts tests/oauthDiscovery.test.ts
git commit -m "feat(oauth): drive discovery/base URL from config.publicBaseUrl (blocker #3)"
```

---

## Task 3: /readyz readiness 探針

**Files:**
- Modify: `src/server/app.ts`（`/healthz` 之後、`buildHostGuard()` 之前，約 `app.ts:251`）
- Test: `tests/readyz.test.ts`（新）

**Interfaces:**
- Consumes: `buildApp` scope 內的 `db`。
- Produces: `GET /readyz` → 200 `{status:'ready'}` / 503 `{status:'not-ready'}`；豁免 Host guard（掛在 guard 之前）。

- [ ] **Step 1: 寫失敗測試 `tests/readyz.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openDb } from '../src/store/db.js'
import type { Config } from '../src/config.js'
import type Database from 'better-sqlite3'

const config: Config = {
  authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
  serviceKey: 'sk', port: 0, dbPath: ':memory:', otelMode: 'off', scheduleTz: 'Asia/Taipei',
  bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
}
let http: Server, base: string, db: Database.Database
beforeAll(async () => {
  db = openDb(':memory:')
  http = createServer(buildApp({ config, db }))
  await new Promise<void>(r => http.listen(0, () => r()))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterAll(() => { http.close() })   // db 由 503 測試關掉

describe('GET /readyz', () => {
  it('returns 200 ready when the DB is open', async () => {
    const r = await fetch(`${base}/readyz`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ status: 'ready' })
  })
  it('is exempt from the Host guard (arbitrary Host still 200)', async () => {
    const r = await fetch(`${base}/readyz`, { headers: { Host: 'evil.example' } })
    expect(r.status).toBe(200)
  })
  it('returns 503 not-ready when the DB is closed', async () => {
    db.close()
    const r = await fetch(`${base}/readyz`)
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ status: 'not-ready' })
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/readyz.test.ts`
Expected: FAIL（`/readyz` 未定義 → 404）

- [ ] **Step 3: 改 `src/server/app.ts`**

在 `app.get('/healthz', …)`（`app.ts:251`）之後、`app.use(buildHostGuard())`（`app.ts:252`）之前插入：
```ts
  app.get('/readyz', (_req, res) => {
    try {
      db.prepare('SELECT 1').get()
      res.status(200).json({ status: 'ready' })
    } catch {
      res.status(503).json({ status: 'not-ready' })
    }
  })
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/readyz.test.ts`
Expected: PASS（3 案例綠）

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts tests/readyz.test.ts
git commit -m "feat(server): add /readyz DB-check readiness probe"
```

---

## Task 4: otel.ts — 匯出 shutdownOtel，移除自帶 SIGTERM listener

**Files:**
- Modify: `src/otel.ts`
- Test: `tests/otelShutdown.test.ts`（新）

**Interfaces:**
- Produces: `export async function shutdownOtel(): Promise<void>`（Task 6 消費）。

- [ ] **Step 1: 寫失敗測試 `tests/otelShutdown.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { initOtel, shutdownOtel } from '../src/otel.js'

describe('otel shutdown', () => {
  it('shutdownOtel resolves without error in off mode (no SDK started)', async () => {
    initOtel('off')
    await expect(shutdownOtel()).resolves.toBeUndefined()
  })
  it('shutdownOtel resolves after starting the SDK in console mode', async () => {
    initOtel('console')
    await expect(shutdownOtel()).resolves.toBeUndefined()
  })
})
```
> 不 spy `sdk.shutdown()` 內部（NodeSDK 私有）；驗「off 無 SDK 不炸、console 起了也能乾淨 shutdown」即涵蓋回歸。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/otelShutdown.test.ts`
Expected: FAIL（`shutdownOtel` 未匯出）

- [ ] **Step 3: 改 `src/otel.ts`**

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

let sdk: NodeSDK | undefined

export function initOtel(mode: 'console' | 'otlp' | 'off'): void {
  if (mode === 'off') return
  sdk = new NodeSDK({
    serviceName: 'be2-mcp',
    traceExporter: mode === 'otlp' ? new OTLPTraceExporter() : new ConsoleSpanExporter(),
  })
  sdk.start()
  // 關機協調統一由 index.ts 的 makeShutdown 主導（await shutdownOtel），此處不再自掛 SIGTERM。
}

export async function shutdownOtel(): Promise<void> {
  await sdk?.shutdown()
}
```
（移除原 `process.on('SIGTERM', …)` 行。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/otelShutdown.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/otel.ts tests/otelShutdown.test.ts
git commit -m "feat(otel): export async shutdownOtel, drop self-registered SIGTERM"
```

---

## Task 5: scheduler.ts — stopper 可 await in-flight tick

**Files:**
- Modify: `src/core/schedule/scheduler.ts:116-129`
- Test: `tests/schedulerGracefulStop.test.ts`（新）

**Interfaces:**
- Produces: `makeScheduler(...).start(): () => Promise<void>`（stopper 回 Promise，resolve 時代表 in-flight tick 已 settle）。Task 6 消費。

- [ ] **Step 1: 寫失敗測試 `tests/schedulerGracefulStop.test.ts`**

用 fake deps 讓一輪 tick 卡在一個可控 deferred（`listDueScheduled` 回一個 id、`tokenManager.getFreshByIdentityId` 回卡住的 promise），斷言 `stop()` 的 promise 在 deferred resolve 前不 settle：
```ts
import { describe, it, expect } from 'vitest'
import { makeScheduler } from '../src/core/schedule/scheduler.js'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('scheduler graceful stop', () => {
  it('stop() awaits the in-flight tick before resolving', async () => {
    const gate = deferred<{ accessToken: string }>()
    let tickTouchedDbAfterGate = false
    const rec = { schedule: { executeAtUtc: 0 }, executorRef: { identityId: 'i', userLabel: 'u', modifyUser: 'm', sessionId: 's' } }
    const changeSets = {
      listStrandedApproved: () => [],
      listDueScheduled: () => ['c1'],
      listScheduledIdentityIds: () => [],
      get: () => rec,
      claimScheduled: () => true,
      casStatus: () => { tickTouchedDbAfterGate = true; return true },
      releaseClaim: () => true,
      listExecutingScheduled: () => [],
    }
    const deps: any = {
      changeSets, gateway: {}, audit: { record() {} }, now: () => 0,
      tokenManager: { getFreshByIdentityId: () => gate.promise, keepAlive: async () => ({ refreshed: [], failed: [] }) },
    }
    // executeChangeSet 在 c1 上會呼叫 casStatus（見 executor）——用它當「tick 動到 db」的探針
    const scheduler = makeScheduler(deps, { tickMs: 60_000, graceMs: 1_000_000 })
    const stop = scheduler.start()
    await new Promise(r => setTimeout(r, 10))         // 讓 tick 跑到卡在 gate
    let stopped = false
    const stopP = stop().then(() => { stopped = true })
    await new Promise(r => setTimeout(r, 10))
    expect(stopped).toBe(false)                        // gate 未放行前 stop 不 settle
    gate.resolve({ accessToken: 'a' })                 // 放行 → tick 完成
    await stopP
    expect(stopped).toBe(true)
  })
})
```
> 若 `executeChangeSet` 對 fake `gateway` 拋錯，tick 的 `.catch` 會吞掉、`.finally` 仍跑 → `current` 照樣 settle，stopper 仍正確 await。斷言重點是「gate 放行前 stopP 不 settle、放行後才 settle」。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/schedulerGracefulStop.test.ts`
Expected: FAIL（現行 `start()` 回 `() => void`；`stop()` 回 undefined → `stop().then` 直接炸 `TypeError: Cannot read properties of undefined (reading 'then')`）

- [ ] **Step 3: 改 `src/core/schedule/scheduler.ts` 的 `start()`（`:116-129`）**

```ts
  function start(): () => Promise<void> {
    auditStranded()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: Promise<void> | undefined
    const loop = () => {
      current = tick().catch(err => console.error('scheduler tick error:', (err as Error).message))
        .finally(() => { if (!stopped) timer = setTimeout(loop, p.tickMs) })
    }
    loop()
    return async () => { stopped = true; if (timer) clearTimeout(timer); await current }
  }
```
（只多 `current` 追蹤 + stopper 改 async 並 `await current`；tick 業務邏輯與註解不動。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/schedulerGracefulStop.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck 回歸（app.ts:355 指派、index.ts:11 舊 cast）**

Run: `npx tsc --noEmit`
Expected: PASS —— `app.locals.startScheduler = scheduler.start` 型別自動變窄；`index.ts:11` 舊的 `as () => () => void` 斷言仍可編（Task 6 會改寫它）。若紅，只可能是既有 scheduler 測試斷言了 stopper 為 void——實作時若遇再改成 `await`。

- [ ] **Step 6: Commit**

```bash
git add src/core/schedule/scheduler.ts tests/schedulerGracefulStop.test.ts
git commit -m "feat(scheduler): make stop() await in-flight tick for graceful shutdown"
```

---

## Task 6: 關機協調者 + index.ts 接線（bind + hoist db + graceful）

**Files:**
- Create: `src/server/shutdown.ts`
- Modify: `src/index.ts`
- Test: `tests/serverShutdown.test.ts`（新）

**Interfaces:**
- Consumes: `Config.bindHost`（Task 1）、`shutdownOtel`（Task 4）、scheduler stopper `() => Promise<void>`（Task 5）。
- Produces: `makeShutdown(deps): () => Promise<void>`。

- [ ] **Step 1: 寫失敗測試 `tests/serverShutdown.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeShutdown } from '../src/server/shutdown.js'

describe('makeShutdown', () => {
  it('runs stopScheduler → server.close → shutdownOtel → db.close → exit, in order', async () => {
    const order: string[] = []
    const server = { close: (cb: () => void) => { order.push('server.close'); cb() } }
    const db = { close: () => { order.push('db.close') } }
    const stopScheduler = vi.fn(async () => { order.push('stopScheduler') })
    const shutdownOtel = vi.fn(async () => { order.push('shutdownOtel') })
    const exit = vi.fn((_: number) => { order.push('exit') })
    const shutdown = makeShutdown({ server: server as any, db: db as any, stopScheduler, shutdownOtel, graceMs: 25_000, exit })
    await shutdown()          // promisified：await 回來時全序已跑完
    expect(order).toEqual(['stopScheduler', 'server.close', 'shutdownOtel', 'db.close', 'exit'])
  })

  it('is idempotent (second call is a no-op)', async () => {
    const server = { close: (cb: () => void) => cb() }
    const db = { close: vi.fn() }
    const exit = vi.fn()
    const shutdown = makeShutdown({ server: server as any, db: db as any, shutdownOtel: async () => {}, graceMs: 25_000, exit })
    await shutdown()
    await shutdown()
    expect(db.close).toHaveBeenCalledTimes(1)
  })

  it('closes db AFTER stopScheduler settles (no write-after-close race)', async () => {
    const order: string[] = []
    let schedulerDone = false
    const stopScheduler = async () => { await new Promise(r => setTimeout(r, 20)); schedulerDone = true; order.push('stopScheduler') }
    const server = { close: (cb: () => void) => cb() }
    const db = { close: () => { expect(schedulerDone).toBe(true); order.push('db.close') } }
    const shutdown = makeShutdown({ server: server as any, db: db as any, stopScheduler, shutdownOtel: async () => {}, graceMs: 25_000, exit: () => {} })
    await shutdown()
    expect(order).toEqual(['stopScheduler', 'db.close'])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/serverShutdown.test.ts`
Expected: FAIL（`src/server/shutdown.ts` 不存在）

- [ ] **Step 3: 建 `src/server/shutdown.ts`**

```ts
import type { Server } from 'node:http'

export interface ShutdownDeps {
  server: Pick<Server, 'close'>
  db: { close: () => void }
  stopScheduler?: () => Promise<void>
  shutdownOtel: () => Promise<void>
  graceMs: number
  exit?: (code: number) => void
}

// 單一關機協調者：SIGTERM/SIGINT → 停排程(等 in-flight tick) → 排空 HTTP → flush trace → 關 db → exit。
// db.close 一定在 stopScheduler settle 之後，避免 in-flight tick 對已關閉 db 寫入（"database is closed"）。
// 全序 await 到底：`await shutdown()` 真的等到 drain+flush+close 完成才 exit（非丟一個 async callback）。
export function makeShutdown(deps: ShutdownDeps): () => Promise<void> {
  const exit = deps.exit ?? ((c: number) => process.exit(c))
  let shuttingDown = false
  return async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    // 硬逾時保險：只在收到訊號後 arm（絕不放模組頂層——頂層會開機即計時，且 HTTP server 讓
    // event loop 活著、.unref() 無效 → 開機 graceMs 後保證 hard-exit）。
    const timer = setTimeout(() => exit(0), deps.graceMs); timer.unref()
    await deps.stopScheduler?.()
    // server.close 的 callback 必須同步（Node 會丟棄回傳的 promise）——用 Promise 包起來自己 await drain。
    await new Promise<void>(resolve => deps.server.close(() => resolve()))
    await deps.shutdownOtel()
    deps.db.close()
    clearTimeout(timer)
    exit(0)
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/serverShutdown.test.ts`
Expected: PASS（3 案例綠）

- [ ] **Step 5: 改 `src/index.ts`（bind + hoist db + 接關機）**

> **要點**：現行 `startScheduler` 在 `listen` callback 內被呼叫（`index.ts:11`），其回傳的 stopper **目前被丟棄**。要讓 shutdown 能停排程，需在 callback 內把 stopper 捕獲到外層變數，再交給 `makeShutdown`。完整取代 `src/index.ts`（**含所有 import**）：
```ts
import { loadConfig } from './config.js'
import { initOtel, shutdownOtel } from './otel.js'
import { openDb } from './store/db.js'
import { buildApp } from './server/app.js'
import { makeShutdown } from './server/shutdown.js'

const config = loadConfig()
initOtel(config.otelMode)
const db = openDb(config.dbPath)
const app = buildApp({ config, db })

let stopScheduler: (() => Promise<void>) | undefined
const server = app.listen(config.port, config.bindHost, () => {
  console.log(`be2-mcp listening on ${config.publicBaseUrl}/mcp (bind ${config.bindHost}:${config.port}, env: ${config.gatewayUrl})`)
  stopScheduler = (app.locals.startScheduler as (() => () => Promise<void>) | undefined)?.()
})

const shutdown = makeShutdown({
  server, db,
  stopScheduler: () => stopScheduler?.() ?? Promise.resolve(),
  shutdownOtel,
  graceMs: 25_000,   // < k8s terminationGracePeriodSeconds（DevOps 設 ≥30s）
})
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

- [ ] **Step 6: typecheck + 全測試**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS（全綠）

- [ ] **Step 7: 手動冒煙——啟動 + SIGTERM 乾淨退出**

Run:
```bash
APP_ENV=sit-220 APP_BIND_HOST=0.0.0.0 tsx src/index.ts &
PID=$!; sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz    # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/readyz     # 200
kill -TERM $PID; wait $PID 2>/dev/null; echo "exit=$?"                     # 乾淨退出、無 uncaught
```
Expected: healthz/readyz 皆 200；SIGTERM 後 process 在數秒內退出、無「database is closed」。（需 `.env` 有 `API_AUTH_SERVICE_KEY`；純啟動不打下游，缺 key 只影響 tool 呼叫。）

- [ ] **Step 8: Commit**

```bash
git add src/server/shutdown.ts src/index.ts tests/serverShutdown.test.ts
git commit -m "feat(server): 0.0.0.0 bind + graceful SIGTERM shutdown coordinator (blocker #1)"
```

---

## Task 7: build 產物路徑（tsconfig.build.json + scripts）

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run build` → `dist/src/index.js`、`dist/scripts/oauth-purge.js`、`dist/ui/*.html`（`dist/eval`、`dist/tests` 不存在）；`npm start` → `node dist/src/index.js`。

- [ ] **Step 1: 建 `tsconfig.build.json`**

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false },
  "include": ["src", "scripts"]
}
```
> 排除 `eval`/`tests`（避免編進 dist、避免把 test-only import 帶進 image）。rootDir 仍推為 src+scripts 共同祖先 `.` → 產物落 `dist/src`、`dist/scripts`。

- [ ] **Step 2: 改 `package.json` scripts**

```json
    "build": "tsc -p tsconfig.build.json && npm run build:ui",
    "start": "node dist/src/index.js",
```
（`ci`、`typecheck`、`dev`、`build:ui` 不動。）

- [ ] **Step 3: 跑 build，驗產物路徑**

Run:
```bash
rm -rf dist && npm run build
test -f dist/src/index.js && echo OK-index
test -f dist/scripts/oauth-purge.js && echo OK-purge
ls dist/ui/*.html >/dev/null && echo OK-ui
test ! -d dist/eval && test ! -d dist/tests && echo OK-no-eval-tests
```
Expected: 印出 `OK-index` / `OK-purge` / `OK-ui` / `OK-no-eval-tests`（四個都要出現）

- [ ] **Step 4: 驗 build 產物可啟動**

Run:
```bash
APP_ENV=sit-220 APP_BIND_HOST=0.0.0.0 node dist/src/index.js &
PID=$!; sleep 2; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz; kill -TERM $PID; wait $PID 2>/dev/null
```
Expected: `200`（`node dist/src/index.js` 能起、healthz 綠）

- [ ] **Step 5: `npm run ci` 回歸**

Run: `npm run ci`
Expected: PASS（build:ui + typecheck + test 全綠）

- [ ] **Step 6: Commit**

```bash
git add tsconfig.build.json package.json
git commit -m "build: production tsc build (dist/src/index.js) + start script"
```

---

## Task 8: 容器化（Dockerfile + Node 釘版）

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `.nvmrc`
- Modify: `package.json`（`engines`）

**Interfaces:**
- Produces: 可 build 的 image；`docker run` 起容器、healthz/readyz 綠、discovery 帶注入的 public base URL、SIGTERM 乾淨退出。

- [ ] **Step 1: 建 `.nvmrc`**

```
22
```

- [ ] **Step 2: `package.json` 加 `engines`**

```json
  "engines": { "node": ">=22 <23" },
```

- [ ] **Step 3: 建 `.dockerignore`**

```
node_modules
dist
.git
data
*.sqlite
*.sqlite-*
.env
```

- [ ] **Step 4: 建 `Dockerfile`**

```dockerfile
# --- builder ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime ---
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "dist/src/index.js"]
```

- [ ] **Step 5: 建 image + 冒煙**

Run:
```bash
docker build -t be2-mcp:phaseA .
docker run --rm -d --name be2mcp-smoke -p 18787:8787 \
  -e APP_ENV=stage -e API_AUTH_SERVICE_KEY=dummy \
  -e APP_BIND_HOST=0.0.0.0 -e APP_BASE_URL=https://mcp.stage.example \
  -e APP_ALLOWED_HOSTS=example -e APP_DB_PATH=/tmp/be2.sqlite \
  be2-mcp:phaseA
sleep 3
curl -s -o /dev/null -w 'healthz=%{http_code}\n' http://127.0.0.1:18787/healthz
curl -s -o /dev/null -w 'readyz=%{http_code}\n'  http://127.0.0.1:18787/readyz
curl -s -H 'Host: example' http://127.0.0.1:18787/.well-known/oauth-authorization-server | grep -o 'https://mcp.stage.example/oauth/authorize'
curl -s -o /dev/null -w 'evilhost=%{http_code}\n' -H 'Host: evil' http://127.0.0.1:18787/mcp
docker stop be2mcp-smoke   # 送 SIGTERM
```
Expected: `healthz=200`、`readyz=200`、印出 `https://mcp.stage.example/oauth/authorize`、`evilhost=403`；`docker stop` 在 grace 內乾淨退出（`docker logs be2mcp-smoke` 無 uncaught / 無「database is closed」）。
> **若本機無 Docker daemon**：本步標記 SKIP 並在 commit message / runbook 註明「容器冒煙待有 Docker 的環境或 CI 跑」（非阻擋 code 正確性；Task 1-7 的 ci 已綠）。

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore .nvmrc package.json
git commit -m "build: multi-stage Dockerfile + pin Node 22 (cloud-ready Phase A)"
```

---

## Task 9: runbook / DevOps env 契約文件

**Files:**
- Create: `docs/be2-mcp/cloud-ready-phaseA-runbook.md`
- Modify: `docs/be2-mcp/deploy-architecture.md`（在 §9 申請清單標注「Phase A 已落地：Dockerfile/build/bind/public-url/readyz/graceful 完成，見 runbook」）

**Interfaces:** 無 code；供 DevOps 部署與 pilot 參考。

- [ ] **Step 1: 寫 `cloud-ready-phaseA-runbook.md`**

內容至少涵蓋（散文，繁中）：
- **必設 env**：`APP_ENV=stage`、`API_AUTH_SERVICE_KEY`(Secret)、`APP_BIND_HOST=0.0.0.0`、`APP_BASE_URL=https://<域名>`、`APP_ALLOWED_HOSTS=<域名>`、`APP_DB_PATH=<PVC 掛載點>`；**建議** `OTEL_MODE=otlp`+`OTEL_EXPORTER_OTLP_ENDPOINT`；**務必不設** `APP_DEV_PANEL`。
- **build/run**：`npm run build` → `node dist/src/index.js`；Docker `docker build` + `docker run`（含上面冒煙指令）。
- **k8s（交 DevOps）契約**：replicas=1；PVC 需 **RWO block volume（非 NFS，WAL 安全）**、加密 storage class（承載明文 token）、備份 audit_log；probe liveness=`/healthz`、readiness=`/readyz`；`terminationGracePeriodSeconds ≥ 30`（app 內硬逾時 25s）；egress 放行 stage auth-service / api-gateway / OTLP collector；CronJob `node dist/scripts/oauth-purge.js` 每日。
- **邊界**：單副本硬前提；HA（Postgres/Redis）是 Phase C；live stage e2e PENDING（依 DevOps 部署 + STAGE service key + 寫入權限）。

- [ ] **Step 2: 更新 `deploy-architecture.md` §9** 標注 Phase A 落地狀態 + 指向 runbook。

- [ ] **Step 3: Commit**

```bash
git add docs/be2-mcp/cloud-ready-phaseA-runbook.md docs/be2-mcp/deploy-architecture.md
git commit -m "docs: cloud-ready Phase A runbook + DevOps env contract"
```

---

## 收尾驗收（對齊 spec §14）

- [ ] `npm run ci` 綠（含全部新測試）。
- [ ] `npm run build` 產出 `dist/src/index.js`、`dist/scripts/oauth-purge.js`、`dist/ui/*.html`；`dist/eval`/`dist/tests` 不存在；`node dist/src/index.js` 能起。
- [ ] `docker build` + `docker run` 冒煙全綠（或標 SKIP 註明待 Docker 環境）：healthz/readyz 200、discovery 帶注入 public base URL、evil Host 403、SIGTERM 乾淨退出。
- [ ] **live stage EKS e2e = PENDING**（依 DevOps 部署 + `API_AUTH_SERVICE_KEY` + stage 寫入權限，沿用前面 phase 慣例）。

<!-- agy-peer-reviewed: 2026-08-27T07:00:05Z rounds=2 verdict=approved -->
