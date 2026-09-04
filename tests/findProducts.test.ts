import { describe, it, expect } from 'vitest'
import { findProductsTool } from '../src/tools/findProducts.js'
import type { ToolContext } from '../src/tools/types.js'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

function ctxWith(routes: Record<string, unknown | Error>): ToolContext {
  return {
    accessToken: 'fake-jwt', userLabel: 'pilot@kkday.com', traceId: 't'.repeat(32),
    gateway: {
      get: async (path: string) => {
        for (const [frag, v] of Object.entries(routes)) if (path.includes(frag)) {
          if (v instanceof Error) throw v
          return v
        }
        throw new Error(`unexpected path ${path}`)
      },
    } as never,
  }
}

const info = { description_module: { 'zh-tw': { name: '東京鐵塔門票' } }, master_lang: 'zh-tw', workflow_status: 'PUBLISHED' }
const sw = { is_active: true, is_locked_for_active: false }

describe('be2_find_products', () => {
  it('schema rejects >20 oids/mids; empty arrays now allowed at schema level (handler enforces ≥1)', () => {
    const schema = z.object(findProductsTool.inputShape)
    expect(schema.safeParse({ prod_oids: [] }).success).toBe(true)   // 空陣列 schema 層合法(optional);≥1 由 handler 擋
    expect(schema.safeParse({}).success).toBe(true)                   // 皆省略亦合法
    expect(schema.safeParse({ prod_oids: Array.from({ length: 21 }, (_, i) => `p${i}`) }).success).toBe(false)
    expect(schema.safeParse({ prod_mids: Array.from({ length: 21 }, (_, i) => `m${i}`) }).success).toBe(false)
    expect(schema.safeParse({ prod_oids: ['p1'] }).success).toBe(true)
  })
  it('merges info + switch into trimmed items with untrusted envelope', async () => {
    const env = await findProductsTool.handler({ prod_oids: ['p1'] }, ctxWith({ '/info': info, '/switch': sw }))
    expect(env.data_origin).toBe('be2_content')
    expect(env.untrusted_note).toMatch(/untrusted/i)
    expect(env.items).toEqual([{ prod_oid: 'p1', name: '東京鐵塔門票', workflow_status: 'PUBLISHED', is_active: true, is_locked_for_active: false }])
    expect(env.errors).toEqual([])
    expect(env.read_oids).toEqual(['p1'])
  })
  it('caps concurrency at 5 oids in flight', async () => {
    let inFlight = 0, peak = 0
    const gateway = { get: async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--; return info
    } }
    const ctx = { accessToken: 'fake-jwt', userLabel: 'u', traceId: 't'.repeat(32), gateway: gateway as never }
    await findProductsTool.handler({ prod_oids: Array.from({ length: 20 }, (_, i) => `p${i}`) }, ctx)
    expect(peak).toBeLessThanOrEqual(10) // 5 oids x 2 requests each
  })
  it('isolates per-oid failures into errors, other oids still succeed', async () => {
    const boom = Object.assign(new Error('GET x -> 403: no permission'), { code: 'FORBIDDEN', status: 403 })
    const env = await findProductsTool.handler({ prod_oids: ['bad', 'p1'] },
      ctxWith({ '/products/bad/info': boom, '/product-configs/bad/switch': boom, '/info': info, '/switch': sw }))
    expect(env.items).toHaveLength(1)
    expect(env.errors[0]).toMatchObject({ key: 'bad', status: 403 })
    expect(env.read_oids).toEqual(['p1']) // failed oid is NOT recorded as read
  })
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

  it('合併總量 > 20 → TOO_MANY_IDS(在打 gateway 前擋下,避免 20→40 oid 破壞 burst 假設)', async () => {
    // ctxWith({}) 對任何 gateway.get 都 throw;若未在 resolve 前擋下,會回 gateway 錯誤而非 TOO_MANY_IDS。
    const env = await findProductsTool.handler(
      { prod_mids: Array.from({ length: 11 }, (_, i) => `m${i}`),
        prod_oids: Array.from({ length: 10 }, (_, i) => `o${i}`) } as never,
      ctxWith({}))
    expect(env.errors[0].code).toBe('TOO_MANY_IDS')
    expect(env.items).toEqual([])
  })
  it('直接用 prod_oid 查詢卻 404 → 錯誤訊息含 mid 提示', async () => {
    const boom = Object.assign(new Error('GET .../info -> 404: not_found'), { status: 404 })
    const env = await findProductsTool.handler({ prod_oids: ['546965'] } as never,
      ctxWith({ '/info': boom, '/switch': boom }))
    expect(env.errors[0].message).toContain('prod_mid')
  })
})

describe.skipIf(!existsSync('tests/fixtures/product-info.json'))('fixture: real SIT shape', () => {
  it('extracts a non-empty name and workflow_status from the captured fixture', async () => {
    const fx = JSON.parse(readFileSync('tests/fixtures/product-info.json', 'utf8'))
    const fxSwitch = JSON.parse(readFileSync('tests/fixtures/product-switch.json', 'utf8'))
    const env = await findProductsTool.handler({ prod_oids: ['fx'] }, ctxWith({ '/info': fx, '/switch': fxSwitch }))
    const item = env.items[0] as Record<string, unknown>
    expect(typeof item.name).toBe('string')
    expect((item.name as string).length).toBeGreaterThan(0)
    expect(item.workflow_status).toBeDefined()
  })
})
