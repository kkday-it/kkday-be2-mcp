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
