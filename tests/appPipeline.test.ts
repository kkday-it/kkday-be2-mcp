import { describe, it, expect } from 'vitest'
import { AppRateBudget } from '../src/limits/appRateBudget.js'
import { RateError } from '../src/errors.js'
import { wrapAppTool, type AppPipelineDeps } from '../src/server/appPipeline.js'
import { ApprovalNonceStore } from '../src/changeset/approvalNonce.js'
import { requestContext } from '../src/server/requestContext.js'
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
