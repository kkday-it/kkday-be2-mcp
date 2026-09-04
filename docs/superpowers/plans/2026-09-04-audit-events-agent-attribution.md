# 稽核事件模型 + agent 可識別性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **分工鐵則（memory agy-work-allocation）**：實作（寫 code+測試檔）外包 agy（gemini-3.1-pro-high, `--mode accept-edits`）；Claude 只編排、跑測試驗證、commit。agy headless 禁 heredoc/管線/跑測試——測試一律由 Claude 執行。

**Goal:** 落地 audit P0 四項（G6 事件分類欄位、G9 stdout 雙寫、G2 撤銷事件、G3 401 嘗試+throttle）+ #3 agent 可識別性（`request-uuid: <trace_id>` 貫穿到 be2 端）。

**Architecture:** 全部疊加在既有 `AuditLog` 單類上（migration 0003 加兩欄、record() 先 stdout 後 DB）；throttle 為獨立純類 `UnauthThrottle`；trace 貫穿走「pipeline 產恆有值 traceId → context 載體（ToolContext/L2ToolContext/ExecCtx 加欄位）→ `GatewayClient.withTrace()` 綁定實例」——34 個 gateway 呼叫點零改動，binding 在 4 個 context 組裝點完成。

**Tech Stack:** TypeScript + Express 5 + PG（PGlite 測試）+ vitest（既有 stack，零新依賴）。

**Spec:** `docs/superpowers/specs/2026-09-03-audit-events-agent-attribution-design.md`（agy APPROVED rounds=4）。

## Global Constraints

- 分支：從目前分支（`feat/pg-migration`）續作或依使用者指示切新分支；頻繁 commit，訊息中文、conventional prefix。
- token/secret 明文永不落 DB、log、stdout、audit（bearer 只記 hash 前 8 碼；params 沿用既有 JWT redact）。
- runtime 零 DDL：schema 變更只走 `db/migrations/0003_audit_event_type.sql`。
- audit 失敗一律不擋業務請求；stdout 先行且例外吞掉、DB 例外照現行為拋。
- `modify_user` 契約不動（仍 = 使用者 platformId）。
- 每個 task 結束 `npm run ci`（build+typecheck+lint:async+test）必須全綠才 commit。
- spec 事件名為唯一來源：`tool_call`、`approval`、`rejection`、`execution`、`governance.scheduler`、`authn.login`、`security.token_revoked`、`security.reauth_required`、`authn.unauthorized_attempt`。

---

### Task 1: Migration 0003 + AuditEntry 事件欄位（G6 基座）

**Files:**
- Create: `db/migrations/0003_audit_event_type.sql`
- Modify: `src/audit/auditLog.ts`
- Test: `tests/auditLog.test.ts`（追加案例）

**Interfaces:**
- Produces: `AuditEntry` 新增 optional 欄位 `eventType?: string`（存檔預設 `'tool_call'`）、`severity?: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'`（存檔預設 `'INFO'`）；`recent()` 回傳物件含 `eventType: string`、`severity: string`（NULL 舊列 fallback `'tool_call'`/`'INFO'`）。後續所有 task 依賴這兩個欄位名。

- [ ] **Step 1: 寫 migration**

`db/migrations/0003_audit_event_type.sql`：

```sql
-- G6：audit_log 事件分類。舊列 NULL = tool_call / INFO（讀取端 fallback，不 backfill）。
ALTER TABLE audit_log ADD COLUMN event_type TEXT;
ALTER TABLE audit_log ADD COLUMN severity TEXT;
```

- [ ] **Step 2: 寫失敗測試**（追加到 `tests/auditLog.test.ts`）

```ts
  it('records eventType/severity and defaults them for plain entries', async () => {
    const db = await openTestDb()
    const log = new AuditLog(db, () => 123)
    await log.record({ userLabel: 'u', sessionId: 's', clientInfo: 'c', tool: 't',
      params: {}, status: 'ok', traceId: 'tr', durationMs: 1 })
    await log.record({ userLabel: 'u', sessionId: 's', clientInfo: 'c', tool: 'oauth_revoke',
      params: {}, status: 'ok', traceId: 'tr', durationMs: 1,
      eventType: 'security.token_revoked', severity: 'CRITICAL' })
    const rows = await log.recent()
    expect(rows[1]).toMatchObject({ eventType: 'tool_call', severity: 'INFO' })
    expect(rows[0]).toMatchObject({ eventType: 'security.token_revoked', severity: 'CRITICAL' })
    await db.close()
  })
```

- [ ] **Step 3: 跑測試確認 fail**

Run: `npx vitest run tests/auditLog.test.ts`
Expected: FAIL（`eventType` 不在 AuditEntry 型別 / undefined）

- [ ] **Step 4: 實作** — `src/audit/auditLog.ts` 改為：

```ts
import type { Db } from '../store/dbTypes.js'

export type AuditSeverity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'

export interface AuditEntry {
  userLabel: string; sessionId: string; clientInfo: string; tool: string
  params: unknown; status: 'ok' | 'error' | 'denied_rate' | 'denied_auth'
  errorMessage?: string; traceId: string; durationMs: number
  eventType?: string        // 預設 'tool_call'（spec §3.1）
  severity?: AuditSeverity  // 預設 'INFO'
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*)?/g

export class AuditLog {
  constructor(private db: Db, private now: () => number = Date.now) {}

  async record(e: AuditEntry): Promise<void> {
    const paramsJson = JSON.stringify(e.params ?? {}).replace(JWT_RE, '[REDACTED_TOKEN]')
    await this.db.query(`
      INSERT INTO audit_log (ts, user_label, session_id, client_info, tool, params_json, status, error_message, trace_id, duration_ms, event_type, severity)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [this.now(), e.userLabel, e.sessionId, e.clientInfo, e.tool, paramsJson, e.status, e.errorMessage ?? null,
        e.traceId, e.durationMs, e.eventType ?? 'tool_call', e.severity ?? 'INFO'])
  }

  async recent(limit = 50): Promise<Array<AuditEntry & { ts: number }>> {
    const rows = (await this.db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit])).rows as Array<Record<string, unknown>>
    return rows.map(r => ({
      ts: r.ts as number, userLabel: r.user_label as string, sessionId: r.session_id as string,
      clientInfo: r.client_info as string, tool: r.tool as string, params: JSON.parse(r.params_json as string),
      status: r.status as AuditEntry['status'], errorMessage: (r.error_message as string) ?? undefined,
      traceId: r.trace_id as string, durationMs: r.duration_ms as number,
      eventType: (r.event_type as string) ?? 'tool_call',           // migration 前舊列 fallback
      severity: ((r.severity as string) ?? 'INFO') as AuditSeverity,
    }))
  }
}
```

- [ ] **Step 5: 跑測試確認 pass**

Run: `npx vitest run tests/auditLog.test.ts`
Expected: PASS（含既有 2 案例）

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0003_audit_event_type.sql src/audit/auditLog.ts tests/auditLog.test.ts
git commit -m "feat(audit): audit_log 加 event_type/severity 欄位（G6，migration 0003）"
```

---

### Task 2: stdout JSON lines 雙寫（G9）

**Files:**
- Modify: `src/audit/auditLog.ts`
- Modify: `src/config.ts`
- Modify: `src/server/app.ts:118`（AuditLog 建構帶 opts）
- Test: `tests/auditStdout.test.ts`（新檔）

**Interfaces:**
- Consumes: Task 1 的 `AuditEntry`。
- Produces: `AuditLog` 建構簽章變為 `constructor(db: Db, now: () => number = Date.now, opts: { stdout?: boolean; env?: string } = {})`（既有兩參數呼叫點不變）；`Config` 新增 `auditStdout: boolean`、`appEnv?: 'sit' | 'stage' | 'prod'`。

- [ ] **Step 1: 寫失敗測試** — `tests/auditStdout.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { AuditLog } from '../src/audit/auditLog.js'

const ENTRY = { userLabel: 'u@kkday.com', sessionId: 's1', clientInfo: 'c', tool: 'be2_find_products',
  params: { q: 'x' }, status: 'ok' as const, traceId: 'tr123', durationMs: 5 }

describe('AuditLog stdout sink (G9)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('emits one ECS-mapped JSON line when stdout is on', async () => {
    const db = await openTestDb()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s) })
    const log = new AuditLog(db, () => 1725400000000, { stdout: true, env: 'sit' })
    await log.record({ ...ENTRY, eventType: 'approval', severity: 'INFO' })
    expect(lines).toHaveLength(1)
    const j = JSON.parse(lines[0])
    expect(j).toMatchObject({
      'system.service_name': 'be2-mcp', env: 'sit',
      'user.name': 'u@kkday.com', 'event.type': 'approval', 'log.level': 'INFO',
      'trace.id': 'tr123', 'mcp.tool': 'be2_find_products', 'mcp.status': 'ok',
    })
    expect(j['@timestamp']).toBe(new Date(1725400000000).toISOString())
    await db.close()
  })

  it('redacts JWTs in the stdout line too', async () => {
    const db = await openTestDb()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s) })
    const log = new AuditLog(db, Date.now, { stdout: true })
    const jwt = `eyJ${'a'.repeat(30)}.eyJ${'b'.repeat(30)}.sig`
    await log.record({ ...ENTRY, params: { sneaky: jwt } })
    expect(lines[0]).not.toContain('eyJa')
    await db.close()
  })

  it('stdout throw does not affect the DB write', async () => {
    const db = await openTestDb()
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('stdout dead') })
    const log = new AuditLog(db, Date.now, { stdout: true })
    await log.record(ENTRY)                          // 不得 throw
    expect(await log.recent()).toHaveLength(1)       // DB 軌完好
    await db.close()
  })

  it('emits stdout BEFORE the DB write (DB throw must not erase the SIEM trail)', async () => {
    const db = await openTestDb()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s) })
    const brokenDb = { ...db, query: () => { throw new Error('db down') } }
    const log = new AuditLog(brokenDb as never, Date.now, { stdout: true })
    await expect(log.record(ENTRY)).rejects.toThrow('db down')  // DB 例外照拋
    expect(lines).toHaveLength(1)                               // stdout 已先落
    await db.close()
  })

  it('flag off => zero stdout output', async () => {
    const db = await openTestDb()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s) })
    const log = new AuditLog(db)
    await log.record(ENTRY)
    expect(lines).toHaveLength(0)
    await db.close()
  })
})
```

- [ ] **Step 2: 跑測試確認 fail**

Run: `npx vitest run tests/auditStdout.test.ts`
Expected: FAIL（constructor 第三參數不存在 / 無 stdout 輸出）

- [ ] **Step 3: 實作** — `src/audit/auditLog.ts`：

```ts
export class AuditLog {
  constructor(
    private db: Db,
    private now: () => number = Date.now,
    private opts: { stdout?: boolean; env?: string } = {},
  ) {}

  async record(e: AuditEntry): Promise<void> {
    const paramsJson = JSON.stringify(e.params ?? {}).replace(JWT_RE, '[REDACTED_TOKEN]')
    // 先 stdout（獨立 fallback 軌）、後 DB——DB 故障不得滅掉 SIEM 軌跡（spec §3.2）。
    this.emitStdout(e, paramsJson)
    await this.db.query(/* Task 1 的 INSERT，原樣 */)
  }

  // ECS 對映（gap analysis §3.3）。stdout 例外吞掉：導出軌是 best-effort，不影響 DB 真相。
  private emitStdout(e: AuditEntry, paramsJson: string): void {
    if (!this.opts.stdout) return
    try {
      console.log(JSON.stringify({
        '@timestamp': new Date(this.now()).toISOString(),
        'system.service_name': 'be2-mcp',
        env: this.opts.env ?? 'local',
        'user.name': e.userLabel,
        'event.type': e.eventType ?? 'tool_call',
        'log.level': e.severity ?? 'INFO',
        'trace.id': e.traceId,
        'mcp.session_id': e.sessionId,
        'mcp.tool': e.tool,
        'mcp.client_info': e.clientInfo,
        'mcp.status': e.status,
        'mcp.error_message': e.errorMessage,
        'mcp.duration_ms': e.durationMs,
        'mcp.params': paramsJson,
      }))
    } catch { /* swallow */ }
  }
  // recent() 不變
}
```

`src/config.ts`：EnvSchema 加 `APP_AUDIT_STDOUT: z.enum(['true', 'false']).default('false'),`；`Config` interface 加 `auditStdout: boolean` 與 `appEnv?: 'sit' | 'stage' | 'prod'`；`loadConfig` return 加 `auditStdout: e.APP_AUDIT_STDOUT === 'true', appEnv: e.APP_ENV,`。

`src/server/app.ts:118`：`const audit = new AuditLog(db, Date.now, { stdout: config.auditStdout, env: config.appEnv })`。

- [ ] **Step 4: 跑測試確認 pass**

Run: `npx vitest run tests/auditStdout.test.ts tests/auditLog.test.ts tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audit/auditLog.ts src/config.ts src/server/app.ts tests/auditStdout.test.ts
git commit -m "feat(audit): stdout JSON lines 雙寫（G9 近程，APP_AUDIT_STDOUT，stdout 先行防 DB 故障滅軌）"
```

---

### Task 3: 既有 16 個 audit 呼叫點全面分類（G6 收尾）

**Files:**
- Modify: `src/server/toolPipeline.ts:99`、`src/server/appPipeline.ts:163`、`src/core/changeset/confirmService.ts:119,141`、`src/core/changeset/executor.ts:67`、`src/server/confirmRoutes.ts:160,179`、`src/server/ssoRoutes.ts:170`、`src/oauth/revokeRoutes.ts:52`、`src/core/schedule/scheduler.ts:30,50,60,75,79,90,108`
- Test: `tests/auditEventTypeConformance.test.ts`（新檔）＋ `tests/confirmService.test.ts`（追加斷言）

**Interfaces:**
- Consumes: Task 1 的 `eventType`/`severity` 欄位。
- Produces: 全 repo 每個 `audit.record({...})` 都帶明確 `eventType`；conformance 測試保證未來新增呼叫點也不得漏標。

**分類對照表（實作依此逐點加欄位，一行 diff/點）：**

| 呼叫點 | eventType | severity |
|---|---|---|
| `toolPipeline.ts:99`（runWrapped） | `'tool_call'` | `status === 'ok' ? 'INFO' : 'ERROR'` |
| `appPipeline.ts:163`（wrapAppTool） | `'tool_call'` | 同上 |
| `confirmService.ts:119`（scheduled approve）| `'approval'` | `'INFO'` |
| `confirmService.ts:141`（approve） | `'approval'` | `'INFO'` |
| `executor.ts:67`（per-item execute） | `'execution'` | `(r.status === 'done' \|\| r.status === 'skipped_noop') ? 'INFO' : 'ERROR'` |
| `confirmRoutes.ts:160`（cancel） | `'rejection'` | `'INFO'` |
| `confirmRoutes.ts:179`（reject） | `'rejection'` | `'INFO'` |
| `ssoRoutes.ts:170`（revoke-all 連線頁） | `'security.token_revoked'` | `'CRITICAL'` |
| `revokeRoutes.ts:52`（RFC 7009） | `'security.token_revoked'` | `'CRITICAL'` |
| `scheduler.ts` 全部 8 點 | `'governance.scheduler'` | `status==='error' 的點 'ERROR'，其餘 'INFO'` |

- [ ] **Step 1: 寫 conformance 失敗測試** — `tests/auditEventTypeConformance.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// G6 conformance：src/ 下每個 audit.record({...}) 呼叫點都必須明確標 eventType——
// fallback 'tool_call' 只保留給 migration 前的歷史資料列，不給任何存活程式碼路徑（spec §3.1）。
describe('audit eventType conformance', () => {
  it('every audit.record call site declares an explicit eventType', () => {
    const files = execSync("grep -rl 'audit\\.record(' src/ --include='*.ts'", { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    const offenders: string[] = []
    for (const f of files) {
      if (f.endsWith('src/audit/auditLog.ts')) continue // 定義處本身
      const src = readFileSync(f, 'utf8')
      let idx = 0
      while ((idx = src.indexOf('audit.record(', idx)) !== -1) {
        const window = src.slice(idx, idx + 900) // 呼叫點物件字面值都在 900 字內
        if (!window.includes('eventType:')) offenders.push(`${f}@${idx}`)
        idx += 1
      }
    }
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: 跑測試確認 fail**

Run: `npx vitest run tests/auditEventTypeConformance.test.ts`
Expected: FAIL，offenders 列出全部 16 個呼叫點

- [ ] **Step 3: 依對照表逐點補欄位**

範例（`executor.ts:67`，其餘同型）：

```ts
    await deps.audit.record({
      userLabel: who.userLabel, sessionId: who.sessionId, clientInfo: clientInfoFor(who), tool: 'changeset.execute',
      params: { changeset_id: changesetId, item: r.item_key },
      status: (r.status === 'done' || r.status === 'skipped_noop') ? 'ok' : 'error',
      eventType: 'execution',
      severity: (r.status === 'done' || r.status === 'skipped_noop') ? 'INFO' : 'ERROR',
      errorMessage: r.error_message, traceId: r.trace_id, durationMs: 0,
    })
```

- [ ] **Step 4: 追加 runtime 斷言**（`tests/confirmService.test.ts` 既有 approve 成功案例內，audit 查驗處追加）：

```ts
    const approveRow = (await audit.recent()).find(r => r.tool === 'changeset.approve')
    expect(approveRow?.eventType).toBe('approval')
    expect(approveRow?.severity).toBe('INFO')
```

- [ ] **Step 5: 跑測試確認 pass**

Run: `npx vitest run tests/auditEventTypeConformance.test.ts tests/confirmService.test.ts && npm run ci`
Expected: 全 PASS

- [ ] **Step 6: 同步回寫事件名到 gap analysis** — `docs/be2-mcp/audit-logging-gap-analysis.md` §2 表格下方加一段「已定案事件名（2026-09-04 實作）：`tool_call` / `approval` / `rejection` / `execution` / `governance.scheduler` / `authn.login`（Task 4 用）/ `security.token_revoked` / `security.reauth_required` / `authn.unauthorized_attempt`」。

- [ ] **Step 7: Commit**

```bash
git add -A src/ tests/ docs/be2-mcp/audit-logging-gap-analysis.md
git commit -m "feat(audit): 16 個既有 audit 呼叫點全面標註 eventType/severity + conformance 測試（G6 收尾）"
```

---

### Task 4: 撤銷事件（G2）

**Files:**
- Create: `src/auth/reauthAudit.ts`
- Modify: `src/server/app.ts:110-118`（AuditLog 移到 TokenManager 前 + callback 換用 helper）
- Modify: `src/server/ssoRoutes.ts`（SSO 登入點補 `authn.login`——該檔既有換碼成功處）
- Test: `tests/reauthAudit.test.ts`（新檔）

**Interfaces:**
- Consumes: Task 1 欄位；`IdentityStore.get(identityId)`（既有）；`CredentialStore.deleteByIdentity`、`OAuthStore.deleteRefreshByIdentity`（既有，app.ts:113-114 現行 callback 內容）。
- Produces: `buildOnReauthRequired(deps: { credentials: CredentialStore; oauthStore: OAuthStore; identities: IdentityStore; audit: AuditLog }): (identityId: string) => Promise<void>`。

- [ ] **Step 1: 寫失敗測試** — `tests/reauthAudit.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { OAuthStore } from '../src/oauth/oauthStore.js'
import { buildOnReauthRequired } from '../src/auth/reauthAudit.js'

describe('buildOnReauthRequired (G2)', () => {
  it('revokes credentials AND records security.reauth_required with the identity userLabel', async () => {
    const db = await openTestDb()
    const identities = new IdentityStore(db)
    const credentials = new CredentialStore(db)
    const oauthStore = new OAuthStore(db)
    const audit = new AuditLog(db)
    const id = await identities.upsert({ userLabel: 'victim@kkday.com', accessToken: 'a', refreshToken: 'r', businessList: [] })
    const cb = buildOnReauthRequired({ credentials, oauthStore, identities, audit })
    await cb(id)
    const row = (await audit.recent())[0]
    expect(row).toMatchObject({ eventType: 'security.reauth_required', severity: 'WARN', status: 'error', userLabel: 'victim@kkday.com' })
    expect(JSON.stringify(row.params)).not.toMatch(/eyJ|refresh/i)   // 不落 token
    await db.close()
  })

  it('audit failure must not block the revocation itself', async () => {
    const db = await openTestDb()
    const identities = new IdentityStore(db)
    const credentials = new CredentialStore(db)
    const oauthStore = new OAuthStore(db)
    const audit = { record: () => Promise.reject(new Error('audit down')) } as never
    const id = await identities.upsert({ userLabel: 'v@kkday.com', accessToken: 'a', refreshToken: 'r', businessList: [] })
    const cb = buildOnReauthRequired({ credentials, oauthStore, identities, audit })
    await expect(cb(id)).resolves.toBeUndefined()   // 不 throw（撤銷已完成）
    await db.close()
  })
})
```

註：`IdentityStore.upsert` 的實際簽章以 `src/store/identityStore.ts` 為準——若參數形狀不同，照該檔既有測試（`tests/revocationStores.test.ts`）的建立方式改寫此測試的建立段，斷言不變。

- [ ] **Step 2: 跑測試確認 fail**

Run: `npx vitest run tests/reauthAudit.test.ts`
Expected: FAIL（module 不存在）

- [ ] **Step 3: 實作** — `src/auth/reauthAudit.ts`（新檔）：

```ts
import type { CredentialStore } from '../store/credentialStore.js'
import type { OAuthStore } from '../oauth/oauthStore.js'
import type { IdentityStore } from '../store/identityStore.js'
import type { AuditLog } from '../audit/auditLog.js'
import { randomTraceId } from '../otel.js'   // Task 6 之前先放本檔內 local 實作，Task 6 收斂（見下）

// G2（spec §3.3）：identity 的 be2 refresh 死亡（撤權/鎖定/到期）＝重大安全事件。
// 撤銷動作沿用 app.ts 原 callback 內容；audit 只記 identityId + userLabel，
// per-credential 歸因結構上不可能（per-identity single-flight，全家憑證一起失效）。
export function buildOnReauthRequired(deps: {
  credentials: CredentialStore; oauthStore: OAuthStore; identities: IdentityStore; audit: AuditLog
}): (identityId: string) => Promise<void> {
  return async (identityId) => {
    const userLabel = (await deps.identities.get(identityId))?.userLabel ?? 'unknown'
    await deps.credentials.deleteByIdentity(identityId)
    await deps.oauthStore.deleteRefreshByIdentity(identityId)
    try {
      await deps.audit.record({
        userLabel, sessionId: '-', clientInfo: 'token-manager', tool: 'auth.reauth_required',
        params: { identity_id: identityId }, status: 'error',
        errorMessage: 'be2 refresh dead — all credentials of this identity revoked (fail-closed)',
        eventType: 'security.reauth_required', severity: 'WARN',
        traceId: randomTraceId(), durationMs: 0,
      })
    } catch (err) { console.error('reauth audit failed:', err) }   // audit 失敗不擋撤銷
  }
}
```

`randomTraceId`：Task 6 才建 `src/otel.ts` 的版本；本 task 先在 `reauthAudit.ts` 內放 local `const randomTraceId = () => crypto.randomUUID().replace(/-/g, '')`（`import crypto from 'node:crypto'`），Task 6 換成共用 import（該 task 有 checklist 項）。

`src/server/app.ts`：
1. `const audit = new AuditLog(db, Date.now, {...})` **移到** `new TokenManager(...)` 之前（TDZ 防護，spec §3.5-4）。
2. callback 換成：

```ts
  const tokenManager = new TokenManager({ identities, credentials }, authServiceClient, {
    onReauthRequired: buildOnReauthRequired({ credentials, oauthStore, identities, audit }),
  })
```

`src/server/ssoRoutes.ts`：找到換碼成功建 web session 的位置（`exchangeCodeToIdentity` 成功後），補一筆：

```ts
      await deps.audit.record({
        userLabel: who.userLabel, sessionId: '-', clientInfo: 'confirm-sso',
        tool: 'sso.login', params: {}, status: 'ok',
        eventType: 'authn.login', severity: 'INFO', traceId: randomTraceId(), durationMs: 0,
      })
```

（若該處目前拿不到 `deps.audit`，把 `audit` 加進該 router 的 deps——`ssoRoutes.ts` 既有 revoke-all 已用 `deps.audit`，同一個 deps 物件應已存在。）

- [ ] **Step 4: 跑測試確認 pass**

Run: `npx vitest run tests/reauthAudit.test.ts tests/auditEventTypeConformance.test.ts && npm run ci`
Expected: 全 PASS（conformance 測試同時驗證新呼叫點都有 eventType）

- [ ] **Step 5: Commit**

```bash
git add src/auth/reauthAudit.ts src/server/app.ts src/server/ssoRoutes.ts tests/reauthAudit.test.ts
git commit -m "feat(audit): G2 撤銷事件（security.reauth_required/authn.login）+ AuditLog 建構順序修正"
```

---

### Task 5: 401 嘗試稽核 + 雙層 throttle + APP_TRUST_PROXY（G3）

**Files:**
- Create: `src/server/unauthThrottle.ts`
- Modify: `src/server/app.ts`（trust proxy 設定 + 401 gate 分支落 audit）
- Modify: `src/config.ts`（`APP_TRUST_PROXY`）
- Test: `tests/unauthThrottle.test.ts`（新檔）+ `tests/mcpGateAudit.test.ts`（新檔）

**Interfaces:**
- Consumes: Task 1 欄位；`CredentialStore.hash`（既有 static）。
- Produces: `class UnauthThrottle { constructor(opts?: { windowMs?: number; maxIps?: number; globalPerMinute?: number; now?: () => number }); admit(ip: string): { admit: boolean; note?: string } }`；`Config` 新增 `trustProxy?: string`。

- [ ] **Step 1: 寫 throttle 失敗測試** — `tests/unauthThrottle.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { UnauthThrottle } from '../src/server/unauthThrottle.js'

describe('UnauthThrottle (G3 雙層防灌爆)', () => {
  it('L1: same IP admits once per 60s window, then suppresses and reports count', () => {
    let now = 0
    const t = new UnauthThrottle({ now: () => now })
    expect(t.admit('1.1.1.1').admit).toBe(true)
    expect(t.admit('1.1.1.1').admit).toBe(false)
    expect(t.admit('1.1.1.1').admit).toBe(false)
    now = 61_000
    const v = t.admit('1.1.1.1')
    expect(v.admit).toBe(true)
    expect(v.note).toContain('suppressed=2')   // 前一窗被抑制 2 次
  })

  it('L1: map full => new IPs stop getting entries but still pass through to L2', () => {
    let now = 0
    const t = new UnauthThrottle({ maxIps: 2, globalPerMinute: 100, now: () => now })
    t.admit('a'); t.admit('b')                  // 填滿 map
    expect(t.admit('c').admit).toBe(true)       // 新 IP 直走 L2（未超天花板 → 放行）
    expect(t.admit('c').admit).toBe(true)       // 不建立 entry，也不被 L1 抑制
    expect(t.admit('a').admit).toBe(false)      // 既有 entry 照常 L1 抑制
  })

  it('L2: global ceiling bounds writes per minute regardless of IPs', () => {
    let now = 0
    const t = new UnauthThrottle({ globalPerMinute: 3, now: () => now })
    // 全部用不同 IP（模擬偽造 XFF 掃描器）
    expect(t.admit('10.0.0.1').admit).toBe(true)
    expect(t.admit('10.0.0.2').admit).toBe(true)
    expect(t.admit('10.0.0.3').admit).toBe(true)
    expect(t.admit('10.0.0.4').admit).toBe(false)   // 天花板
    expect(t.admit('10.0.0.5').admit).toBe(false)
    now = 61_000
    const v = t.admit('10.0.0.6')
    expect(v.admit).toBe(true)
    expect(v.note).toContain('global_suppressed=2')
  })
})
```

- [ ] **Step 2: 跑測試確認 fail**

Run: `npx vitest run tests/unauthThrottle.test.ts`
Expected: FAIL（module 不存在）

- [ ] **Step 3: 實作 throttle** — `src/server/unauthThrottle.ts`（新檔）：

```ts
// G3 防灌爆（spec §3.4）：401 嘗試的 audit 寫入本身不得成為 DoS 放大面。
// L1 per-IP：分桶粒度（同 IP 60s 窗只落第一筆）。map 滿時停收新 IP（不清空——
// 清空會被偽造 XFF 連續觸發、throttle 形同虛設），新 IP 直接交給 L2。
// L2 全域天花板：與 IP 無關的絕對上界；XFF 不可信時仍成立。
interface IpEntry { windowStart: number; suppressed: number }

export class UnauthThrottle {
  private ips = new Map<string, IpEntry>()
  private minuteStart = 0
  private minuteCount = 0
  private globalSuppressed = 0
  private windowMs: number
  private maxIps: number
  private globalPerMinute: number
  private now: () => number

  constructor(opts: { windowMs?: number; maxIps?: number; globalPerMinute?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? 60_000
    this.maxIps = opts.maxIps ?? 1024
    this.globalPerMinute = opts.globalPerMinute ?? 60
    this.now = opts.now ?? Date.now
  }

  admit(ip: string): { admit: boolean; note?: string } {
    const now = this.now()
    const notes: string[] = []

    // --- L1 per-IP ---
    const entry = this.ips.get(ip)
    if (entry) {
      if (now - entry.windowStart < this.windowMs) { entry.suppressed++; return { admit: false } }
      if (entry.suppressed > 0) notes.push(`suppressed=${entry.suppressed}`)
      entry.windowStart = now; entry.suppressed = 0
    } else if (this.ips.size < this.maxIps) {
      this.ips.set(ip, { windowStart: now, suppressed: 0 })
    }
    // map 滿且是新 IP：無 entry、不建 entry，直接走 L2。

    // --- L2 global ceiling ---
    if (now - this.minuteStart >= 60_000) {
      if (this.globalSuppressed > 0) notes.push(`global_suppressed=${this.globalSuppressed}`)
      this.minuteStart = now; this.minuteCount = 0; this.globalSuppressed = 0
    }
    if (this.minuteCount >= this.globalPerMinute) { this.globalSuppressed++; return { admit: false } }
    this.minuteCount++
    return { admit: true, note: notes.length ? notes.join(' ') : undefined }
  }
}
```

- [ ] **Step 4: 跑 throttle 測試確認 pass**

Run: `npx vitest run tests/unauthThrottle.test.ts`
Expected: PASS

- [ ] **Step 5: 寫 gate 整合失敗測試** — `tests/mcpGateAudit.test.ts`（用既有 app 級測試的建法——參照 `tests/oauthDiscovery.test.ts` 的 buildApp+supertest 樣式建 app）：

```ts
import { describe, it, expect } from 'vitest'
import request from 'supertest'
// buildApp 的建構參數照 tests/oauthDiscovery.test.ts 的既有樣式（openTestDb + 測試 config）
import { buildTestApp } from './support/testApp.js'   // 若無此 helper，直接複製 oauthDiscovery.test.ts 的 app 建構段

describe('/mcp 401 gate audit (G3)', () => {
  it('unknown bearer => 401 AND one authn.unauthorized_attempt row with hash prefix (no token plaintext)', async () => {
    const { app, audit } = await buildTestApp()
    const res = await request(app).post('/mcp').set('authorization', 'Bearer totally-bogus').send({})
    expect(res.status).toBe(401)
    await new Promise(r => setTimeout(r, 20))   // fire-and-forget 落地
    const row = (await audit.recent()).find(r => r.eventType === 'authn.unauthorized_attempt')
    expect(row).toBeDefined()
    expect(row!.severity).toBe('WARN')
    expect(row!.userLabel).toBe('unknown')
    expect(JSON.stringify(row!.params)).not.toContain('totally-bogus')   // 只有 hash 前 8 碼
  })

  it('same IP hammering => only the first attempt lands in the window', async () => {
    const { app, audit } = await buildTestApp()
    for (let i = 0; i < 5; i++) await request(app).post('/mcp').set('authorization', 'Bearer bogus').send({})
    await new Promise(r => setTimeout(r, 20))
    const rows = (await audit.recent()).filter(r => r.eventType === 'authn.unauthorized_attempt')
    expect(rows).toHaveLength(1)
  })
})
```

（若 repo 尚無 `tests/support/testApp.ts`，本 task 建立之：包 `openTestDb()` + 最小 `loadConfig` stub + `buildApp`，並 export `{ app, audit, db }`——`audit` 用與 app 同一個 db 另建 `new AuditLog(db)` 讀取即可。）

- [ ] **Step 6: 實作 gate + trust proxy**

`src/config.ts`：EnvSchema 加 `APP_TRUST_PROXY: z.string().optional(),`；`Config` 加 `trustProxy?: string`；return 加 `trustProxy: e.APP_TRUST_PROXY,`。

`src/server/app.ts`（`const app = express()` 之後）：

```ts
  // spec §3.4：EKS ingress/ALB 後方 req.ip 需取信任邊界外第一 IP。不用 `true`（盲信 XFF 可偽造）。
  if (config.trustProxy !== undefined) {
    app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy)
  }
```

`/mcp` gate（`if (!cred)` 分支開頭，`res.status(401)` 之前）：

```ts
      if (!cred) {
        const verdict = unauthThrottle.admit(req.ip ?? 'unknown')
        if (verdict.admit) {
          // fire-and-forget：audit 失敗不得影響 401 回應（spec §3.4）
          void audit.record({
            userLabel: 'unknown', sessionId: '-', clientInfo: (req.header('user-agent') ?? '-').slice(0, 80),
            tool: 'mcp.gate', params: { ip: req.ip, bearer_hash_prefix: bearer ? CredentialStore.hash(bearer).slice(0, 8) : undefined },
            status: 'denied_auth', errorMessage: verdict.note,
            eventType: 'authn.unauthorized_attempt', severity: 'WARN',
            traceId: randomTraceId(), durationMs: 0,
          }).catch(() => {})
        }
        res.status(401) /* ...既有 WWW-Authenticate 回應原樣... */
        return
      }
```

`unauthThrottle` 在 app.ts 組裝區建一次：`const unauthThrottle = new UnauthThrottle()`。`randomTraceId` 暫 import 自 `../auth/reauthAudit.js`（export 出來）或 local const——Task 6 統一收斂到 `src/otel.ts`。

- [ ] **Step 7: 跑測試確認 pass**

Run: `npx vitest run tests/mcpGateAudit.test.ts tests/unauthThrottle.test.ts && npm run ci`
Expected: 全 PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/unauthThrottle.ts src/server/app.ts src/config.ts tests/unauthThrottle.test.ts tests/mcpGateAudit.test.ts tests/support/testApp.ts
git commit -m "feat(audit): /mcp 401 嘗試稽核 + 雙層 throttle + APP_TRUST_PROXY（G3）"
```

---

### Task 6: traceId 恆有值 + context 載體 + GatewayClient request-uuid（#3）

**Files:**
- Modify: `src/otel.ts`（加 `randomTraceId`/`ensureTraceId`）
- Modify: `src/tools/types.ts`（ToolContext + traceId）、`src/server/l2Context.ts`（L2ToolContext + traceId）、`src/core/changeset/module.ts`（ExecCtx + traceId）
- Modify: `src/server/toolPipeline.ts`、`src/server/appPipeline.ts`（注入 traceId + 綁定 gateway）
- Modify: `src/gateway/client.ts`（`withTrace` + `request-uuid` header）
- Modify: `src/core/changeset/executor.ts`、`src/core/changeset/confirmService.ts`、`src/core/changeset/tools.ts:106`、`src/server/confirmRoutes.ts:72`
- Modify: `src/auth/reauthAudit.ts`（randomTraceId 換 import `../otel.js`）
- Test: `tests/gatewayTrace.test.ts`（新檔）+ `tests/toolPipeline.test.ts`／`tests/confirmService.test.ts`（追加斷言）

**Interfaces:**
- Consumes: Task 4/5 的 local `randomTraceId`（本 task 收斂為單一來源）。
- Produces:
  - `src/otel.ts`：`export function randomTraceId(): string`（32 hex）；`export function ensureTraceId(spanTraceId: string): string`（全零 → randomTraceId）。
  - `ToolContext`/`L2ToolContext`/`ExecCtx` 各加必填 `traceId: string`。
  - `GatewayClient`：`withTrace(traceId: string): GatewayClient`（回綁定實例；34 個既有呼叫點零改動）；`get/put/post` 內部有 trace 值時 headers 帶 `request-uuid`。
  - `ExecutorIdentity` 加 `traceId?: string`；`approveAndExecute` 的 `who` 同。

- [ ] **Step 1: 寫失敗測試** — `tests/gatewayTrace.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { GatewayClient } from '../src/gateway/client.js'
import { ensureTraceId, randomTraceId } from '../src/otel.js'

function captureFetch(): { headers: Record<string, string>[]; fetchImpl: typeof fetch } {
  const headers: Record<string, string>[] = []
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    headers.push({ ...(init?.headers as Record<string, string>) })
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { headers, fetchImpl }
}

describe('request-uuid 貫穿 (#3)', () => {
  it('ensureTraceId replaces the all-zero no-op traceId', () => {
    expect(ensureTraceId('0'.repeat(32))).toMatch(/^[0-9a-f]{32}$/)
    expect(ensureTraceId('0'.repeat(32))).not.toBe('0'.repeat(32))
    expect(ensureTraceId('abc123' + '0'.repeat(26))).toBe('abc123' + '0'.repeat(26))  // 有效值原樣
    expect(randomTraceId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('withTrace-bound client sends request-uuid on get/put/post; unbound sends none', async () => {
    const { headers, fetchImpl } = captureFetch()
    const gw = new GatewayClient({ baseUrl: 'http://gw.test', fetchImpl })
    await gw.get('/x', 'tok')
    expect(headers[0]['request-uuid']).toBeUndefined()          // 未綁定：不帶（probe 相容）
    const bound = gw.withTrace('t'.repeat(32))
    await bound.get('/x', 'tok')
    await bound.put('/x', 'tok', {})
    await bound.post('/x', 'tok', {})
    for (const h of headers.slice(1)) expect(h['request-uuid']).toBe('t'.repeat(32))
    expect(headers[1].authorization).toBe('Bearer tok')          // 既有 header 不受影響
  })
})
```

- [ ] **Step 2: 跑測試確認 fail**

Run: `npx vitest run tests/gatewayTrace.test.ts`
Expected: FAIL（`ensureTraceId`/`withTrace` 不存在）

- [ ] **Step 3: 實作**

`src/otel.ts` 追加：

```ts
import crypto from 'node:crypto'

const ZERO_TRACE = '0'.repeat(32)
export function randomTraceId(): string { return crypto.randomUUID().replace(/-/g, '') }
// OTel off 時 no-op span 的 traceId 是全零——audit 與下游關聯不得依賴 OTEL_MODE（spec §3.5-1）。
export function ensureTraceId(spanTraceId: string): string {
  return spanTraceId === ZERO_TRACE ? randomTraceId() : spanTraceId
}
```

`src/gateway/client.ts`：

```ts
export class GatewayClient {
  // ...既有欄位...
  private traceId?: string

  // 回一個共用連線設定、綁定 request-uuid 的實例——34 個既有呼叫點（modules/tools）拿到
  // 綁定過的 ctx.gateway 即自動帶 header，不必逐點傳參（spec §3.5-3 的收斂實作）。
  withTrace(traceId: string): GatewayClient {
    const bound = Object.create(this) as GatewayClient
    bound.traceId = traceId
    return bound
  }

  private traceHeaders(): Record<string, string> {
    return this.traceId ? { 'request-uuid': this.traceId } : {}
  }
  // get/put/post 三處 headers 各加 ...this.traceHeaders()（與 BE2_HEADERS 並列）
}
```

`src/tools/types.ts`：`ToolContext` 加 `traceId: string`。
`src/server/l2Context.ts`：`L2ToolContext` 加 `traceId: string`。
`src/core/changeset/module.ts`：`ExecCtx` 加 `traceId: string`。

`src/server/toolPipeline.ts`：
- `const traceId = ensureTraceId(span.spanContext().traceId)`（import 自 `../otel.js`）。
- `runWrapped` 的 `buildCtx` 簽章加第三參數 `traceId: string`，呼叫處傳入。
- `wrapTool` ctx：`{ gateway: deps.gateway.withTrace(traceId), accessToken: user.accessToken, userLabel: user.userLabel, traceId }`。
- `wrapL2Tool` ctx：同型加 `gateway: deps.gateway.withTrace(traceId)` 與 `traceId`。
- **span 洩漏修復（spec §4）**：finally 內 `audit.record` 現況在 `span.end()` 之前、throw 會跳過 end。改成：

```ts
      } finally {
        try {
          await deps.audit.record({ /* ...原欄位 + eventType/severity（Task 3 已加）... */ })
        } finally {
          span.end()   // audit throw（DB 例外照拋）也不得洩漏 span
        }
      }
```

（DB 例外仍會從外層 finally 往上傳，符合「audit 失敗語義不變」；span 保證關閉。）

`src/server/appPipeline.ts`：
- `const traceId = ensureTraceId(span.spanContext().traceId)`。
- handler ctx 加 `traceId`、`gateway: deps.gateway.withTrace(traceId)`。
- `approveAndExecute` 閉包的 `who` 加 `traceId`。
- finally 的 span 洩漏修復同 toolPipeline（同型 try/finally 包法）。

`src/core/changeset/confirmService.ts`：
- `who` 型別加 `traceId?: string`；函式開頭 `const traceId = who.traceId ?? randomTraceId()`。
- `computeDiff` ctx（`:76`）改 `{ gateway: deps.gateway.withTrace(traceId), accessToken: who.accessToken, userLabel: rec.creatorLabel, traceId }`。
- 兩筆 `changeset.approve` audit 的 `traceId: 'n/a'` 改 `traceId`（spec：批准事件與 ExecCtx 同值，三方 join）。
- `executeChangeSet(deps, rec.id, { ...現有欄位, traceId })`。
- scheduled 路徑 `setScheduled` 的 executorRef 不變（排程執行時由 executor 自產，見下）。

`src/core/changeset/executor.ts`：
- `ExecutorIdentity` 加 `traceId?: string`。
- `const execTraceId = who.traceId ?? randomTraceId()`；`ctx` 加 `traceId: execTraceId`、`gateway: deps.gateway.withTrace(execTraceId)`。

`src/core/changeset/tools.ts:106`：`mod.computeDiff({ gateway: ctx.gateway, accessToken: ctx.accessToken, userLabel: ctx.userLabel, traceId: ctx.traceId }, items)`（ctx.gateway 已是綁定實例）。

`src/server/confirmRoutes.ts:72`（GET 確認頁 live diff，無 span）：函式頂 `const traceId = randomTraceId()`，ctx 改 `{ gateway: deps.gateway.withTrace(traceId), accessToken, userLabel: rec.creatorLabel, traceId }`。

`src/auth/reauthAudit.ts` 與 Task 5 gate 的 local `randomTraceId`：換成 `import { randomTraceId } from '../otel.js'`（gate 為 `./otel.js` 相對路徑依檔案位置調整）。

- [ ] **Step 4: 追加 pipeline 斷言**（`tests/toolPipeline.test.ts` 既有成功案例處）：

```ts
    // OTel off（測試環境）下 traceId 仍為 32 hex 非全零（spec §3.5-1）
    const row = (await audit.recent())[0]
    expect(row.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(row.traceId).not.toBe('0'.repeat(32))
```

（`tests/confirmService.test.ts` approve 案例追加：`expect(approveRow?.traceId).not.toBe('n/a')`。）

- [ ] **Step 5: 跑全測試確認 pass**

Run: `npx vitest run tests/gatewayTrace.test.ts tests/toolPipeline.test.ts tests/confirmService.test.ts && npm run ci`
Expected: 全 PASS（`tsc` 會把漏改的 ctx 組裝點全揪出來——`traceId` 是必填欄位）

- [ ] **Step 6: Commit**

```bash
git add -A src/ tests/
git commit -m "feat(trace): traceId 恆有值 + context 載體 + GatewayClient request-uuid 貫穿（#3 agent 可識別性）"
```

---

### Task 7: 文件收尾 + 全量驗收

**Files:**
- Modify: `docs/be2-mcp/audit-logging-gap-analysis.md`（P0 四項標「✅ 已落地 2026-09-04」）
- Modify: `docs/be2-mcp/phase0-inventory.md`（「trace_id 需 OTEL_MODE 才有值」未竟項標關閉）
- Modify: `docs/be2-mcp/stage-eks-migration-devops.md`（`APP_AUDIT_STDOUT`／`APP_TRUST_PROXY` env 說明 + Filebeat/index `new-kklog-be2-mcp-*` 需求一段）
- Modify: `.env.example`（兩個新 env 加註解，歸 [APP CONFIG] 區）
- Modify: `CLAUDE.md`（開發指令區若有 env 清單則同步；無則略過）

**Interfaces:**
- Consumes: Task 1–6 全部完成。

- [ ] **Step 1: 更新上述文件**（每份 1–3 行，內容照本 plan Files 欄描述）

- [ ] **Step 2: 全量驗收**

Run: `npm run ci`
Expected: build + typecheck + lint:async + test 全綠

Run（如本機有 docker）: `docker compose -f docker/pg-test.yml up -d && TEST_PG_URL=<依 CLAUDE.md> npm run test:pg; docker compose -f docker/pg-test.yml down`
Expected: migration 0003 對真 PG 套用成功、CAS suite 綠（無 docker 則記 SKIP，非失敗）

Run: `npm run db:migrate && npm run dev`（另終端 `curl -s localhost:8787/healthz`）
Expected: 啟動正常、healthz 200；停掉 dev server

- [ ] **Step 3: Commit**

```bash
git add docs/ .env.example CLAUDE.md
git commit -m "docs: audit P0 + agent 可識別性收尾——gap 表標落地、env 說明、phase0 trace_id 項關閉"
```

---

## Self-Review 紀錄

- **Spec coverage**：G6→Task 1+3、G9→Task 2、G2→Task 4、G3→Task 5、#3→Task 6、spec §6 文件影響→Task 7。spec §3.4 `APP_TRUST_PROXY`→Task 5；§3.5-4 建構順序→Task 4；§4 span 洩漏修復→Task 6 的 pipeline 改動中同步處理（`audit.record` 移入 try/catch 或 `span.end()` 移內層 finally——實作時以「audit throw 後 span.end 仍執行」的測試把關，追加於 `tests/toolPipeline.test.ts`：mock audit.record throw → span processor 收到 end）。
- **Type consistency**：`traceId: string` 必填欄位靠 `tsc` 全量把關（Task 6 Step 5 註記）；`eventType` 靠 conformance 測試（Task 3）。
- **Placeholder scan**：無 TBD/TODO；Task 4 測試對 `IdentityStore.upsert` 簽章有明確的「以實檔為準」修正指引（非 placeholder，是防簽章漂移的護欄）。
