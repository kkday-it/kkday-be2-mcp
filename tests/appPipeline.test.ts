import { describe, it, expect } from 'vitest'
import { AppRateBudget } from '../src/limits/appRateBudget.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { RateError } from '../src/errors.js'
import { wrapAppTool, type AppPipelineDeps, type AppToolDef } from '../src/server/appPipeline.js'
import { ApprovalNonceStore } from '../src/changeset/approvalNonce.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { openDb } from '../src/store/db.js'
import { requestContext } from '../src/server/requestContext.js'
import { makeEnvelope } from '../src/tools/envelope.js'
import { appGetChangesetViewTool } from '../src/tools/appTools.js'

describe('AppRateBudget', () => {
  it('同一 session 超過 perMinute 丟 RateError', () => {
    let t = 0
    const b = new AppRateBudget({ perMinute: 3, now: () => t })
    b.consume('s1'); b.consume('s1'); b.consume('s1')
    expect(() => b.consume('s1')).toThrow(RateError)
  })
  it('滑動窗：60s 後舊呼叫過期，可再消耗', () => {
    let t = 0
    const b = new AppRateBudget({ perMinute: 2, now: () => t })
    b.consume('s1'); b.consume('s1')
    t = 61_000
    expect(() => b.consume('s1')).not.toThrow()
  })
  it('不同 session 各自計數', () => {
    let t = 0
    const b = new AppRateBudget({ perMinute: 1, now: () => t })
    b.consume('s1')
    expect(() => b.consume('s2')).not.toThrow()
  })
  it('release 清掉該 session 計數，之後可視為全新起算', () => {
    let t = 0
    const b = new AppRateBudget({ perMinute: 1, now: () => t })
    b.consume('s1')
    expect(() => b.consume('s1')).toThrow(RateError)
    b.release('s1')
    expect(() => b.consume('s1')).not.toThrow()
  })
})

// Task 8 carry-forward from Task 7 review: wrapAppTool had no runtime test — it was only ever
// exercised indirectly (its collaborators individually). Now that a real app tool exists
// (appGetChangesetViewTool), drive wrapAppTool through it end to end for the three branches
// that mirror wrapTool's runWrapped (see tests/structuredContent.test.ts for the pattern).
function fakeAppDeps(over: Partial<AppPipelineDeps> = {}): AppPipelineDeps {
  return {
    tokenManager: { getFreshAccessToken: async () => ({ accessToken: 'AT', userLabel: 'alice', businessList: [] }) } as never,
    appRateBudget: new AppRateBudget(),
    // Task 5: stub readOids/rateBudget for the three pre-existing app tools (none of them
    // populate envelope.read_oids or call ctx.rateBudget themselves) — real instances are
    // exercised separately below in the "app tool 依賴接線" suite.
    readOids: { record() {}, has: () => false, list: () => [] } as never,
    rateBudget: { consume() {}, consumeChangeset() {} } as never,
    audit: { record() {} } as never,
    gateway: {} as never,
    changeSets: {
      get: (id: string) => id === 'cs1'
        ? { id: 'cs1', creatorLabel: 'alice', status: 'pending_approval', actionType: 'shelf_toggle_product', note: undefined, diff: [{ a: 1 }], diffVersion: 'v1' }
        : undefined,
      getResults: () => [],
    } as never,
    nonces: new ApprovalNonceStore(),
    now: Date.now,
    genId: () => 'id1',
    baseUrl: 'http://127.0.0.1:8787',
    // Task 11: required by AppPipelineDeps (feeds the approveAndExecute closure); unused by the
    // read-only tools this suite drives (appGetChangesetViewTool), but must satisfy the type.
    modifyUserFrom: (at: string) => 'MU:' + at,
    ...over,
  }
}

describe('wrapAppTool（runtime，透過真實 app tool 驅動三條分支）', () => {
  it('無 requestContext -> NO_AUTH_CONTEXT（面板 call 缺身分脈絡即擋）', async () => {
    const wrapped = wrapAppTool(appGetChangesetViewTool, fakeAppDeps())
    const out = await wrapped({ changeset_id: 'cs1' }) // 刻意不包 requestContext.run
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('NO_AUTH_CONTEXT')
  })

  it('appRateBudget 超額 -> denied_rate（RATE_APP），不動 changeSets', async () => {
    const deps = fakeAppDeps({ appRateBudget: new AppRateBudget({ perMinute: 1 }) })
    const wrapped = wrapAppTool(appGetChangesetViewTool, deps)
    const call = () => requestContext.run({ bearer: 'b', sessionId: 's1', clientInfo: 'test' }, () => wrapped({ changeset_id: 'cs1' }))
    const first = await call()
    expect(first.isError).toBeUndefined()
    const second = await call()
    expect(second.isError).toBe(true)
    expect(second.content[0].text).toContain('RATE_APP')
  })

  it('成功路徑：雙軌 result（text 同源於 structuredContent）+ audit.record 記 app/ 前綴的 tool 名', async () => {
    const records: Array<Record<string, unknown>> = []
    const deps = fakeAppDeps({ audit: { record: (e: Record<string, unknown>) => { records.push(e) } } as never })
    const wrapped = wrapAppTool(appGetChangesetViewTool, deps)
    const out = await requestContext.run(
      { bearer: 'b', sessionId: 's1', clientInfo: 'test' },
      () => wrapped({ changeset_id: 'cs1' }),
    )
    expect(out.isError).toBeUndefined()
    expect(out.structuredContent).toBeDefined()
    expect(JSON.stringify(out.structuredContent)).toBe(out.content[0].text)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tool: 'app/app_get_changeset_view', userLabel: 'alice', status: 'ok', sessionId: 's1' })
  })

  // Finding 1（whole-branch review）：app_confirm_changeset 的 input 帶一次性批准 nonce；
  // wrapAppTool 稽核整包 args 會讓這個 secret（即使已消耗）明文落進 audit_log。驗證：稽核
  // 副本要 redact，但 handler 實際收到的 args 仍是原始值（不影響工具實際運作）。
  it('args 含 nonce 時，audit.record 收到的 params 是 redacted 副本；handler 仍拿到真實 nonce', async () => {
    const records: Array<Record<string, unknown>> = []
    let handlerSawNonce: unknown
    const spyTool = {
      ...appGetChangesetViewTool,
      handler: async (args: any, ctx: never) => {
        handlerSawNonce = args.nonce
        return appGetChangesetViewTool.handler(args, ctx)
      },
    }
    const deps = fakeAppDeps({ audit: { record: (e: Record<string, unknown>) => { records.push(e) } } as never })
    const wrapped = wrapAppTool(spyTool, deps)
    const out = await requestContext.run(
      { bearer: 'b', sessionId: 's1', clientInfo: 'test' },
      () => wrapped({ changeset_id: 'cs1', nonce: 'real-secret-nonce' }),
    )
    expect(out.isError).toBeUndefined()
    expect(handlerSawNonce).toBe('real-secret-nonce')          // handler 拿到的是真值,不受影響
    expect(records).toHaveLength(1)
    const params = records[0].params as Record<string, unknown>
    expect(params.nonce).toBe('[redacted]')                    // 稽核副本被 redact
    expect(params.changeset_id).toBe('cs1')                    // 其餘欄位不受影響
  })
})

// Task 5 前置整備：AppToolContext 過去沒有 readOidStore/RateBudget（L2 依賴），app_get_batch_view
// 需要兩者都能透過 wrapAppTool 真正打到底層 store/counter，而非只是型別上存在。這裡用真實
// ReadOidStore/RateBudget（真 :memory: db，同 tests/toolPipeline.test.ts 的驗法）驅動一個
// dummy app tool，證明（a）ctx.readOids/ctx.rateBudget 是可用的真實實例、（b）wrapAppTool 比照
// wrapTool/wrapL2Tool 泛用地把 envelope.read_oids 寫回同一個 store。
describe('app tool 依賴接線（Task 5 前置整備：readOidStore + 全域 RateBudget）', () => {
  function realDeps(over: Partial<AppPipelineDeps> = {}) {
    const db = openDb(':memory:')
    const readOids = new ReadOidStore(db)
    const rateBudget = new RateBudget(db, { perSession: 2, perUserDay: 100 })
    const deps = fakeAppDeps({ readOids, rateBudget, ...over })
    return { db, readOids, rateBudget, deps }
  }

  it('ctx.readOids / ctx.rateBudget 是真實可用的實例（非硬 cast 出的 L2ToolContext）', async () => {
    const { readOids, rateBudget, deps } = realDeps()
    let sawHasBeforeRecord: boolean | undefined
    let consumeThrew = false
    const dummyTool: AppToolDef = {
      name: 'dummy_probe', description: 'probe', inputShape: {},
      async handler(_args, ctx) {
        sawHasBeforeRecord = ctx.readOids.has(ctx.sessionId, 'probe-oid')
        try { ctx.rateBudget.consume(ctx.userLabel, ctx.sessionId) } catch { consumeThrew = true }
        return makeEnvelope([{ ok: true }], [], ['probe-oid'])
      },
    }
    const wrapped = wrapAppTool(dummyTool, deps)
    const out = await requestContext.run({ bearer: 'b', sessionId: 's-wire', clientInfo: 'test' }, () => wrapped({}))
    expect(out.isError).toBeUndefined()
    expect(sawHasBeforeRecord).toBe(false)   // 呼叫當下 store 尚是空的（handler 自己還沒 record）
    expect(consumeThrew).toBe(false)         // 真實 RateBudget，額度內不丟錯
    expect(readOids.has('s-wire', 'probe-oid')).toBe(true) // wrapAppTool 事後泛用 record 生效
  })

  it('全域 RateBudget 與 AppRateBudget 是兩個獨立額度：前者可被 tool 顯式消耗到超額', async () => {
    const { deps } = realDeps({ rateBudget: new RateBudget(openDb(':memory:'), { perSession: 1, perUserDay: 100 }) })
    const dummyTool: AppToolDef = {
      name: 'dummy_probe2', description: 'probe2', inputShape: {},
      async handler(_args, ctx) {
        ctx.rateBudget.consume(ctx.userLabel, ctx.sessionId) // 每次呼叫顯式消耗一次讀取額度
        return makeEnvelope([{ ok: true }])
      },
    }
    const wrapped = wrapAppTool(dummyTool, deps)
    const call = () => requestContext.run({ bearer: 'b', sessionId: 's-budget', clientInfo: 'test' }, () => wrapped({}))
    const first = await call()
    expect(first.isError).toBeUndefined()
    const second = await call() // 第 2 次撞 perSession:1 上限
    expect(second.isError).toBe(true)
    expect(second.content[0].text).toContain('RATE_SESSION')
  })
})
