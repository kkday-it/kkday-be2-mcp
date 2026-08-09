import { describe, it, expect } from 'vitest'
import { findProductsTool } from '../src/tools/findProducts.js'
import type { ToolContext } from '../src/tools/types.js'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

function ctxWith(routes: Record<string, unknown | Error>): ToolContext {
  return {
    accessToken: 'fake-jwt', userLabel: 'pilot@kkday.com',
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
  it('schema rejects >20 oids and empty list', () => {
    const schema = z.object(findProductsTool.inputShape)
    expect(schema.safeParse({ prod_oids: [] }).success).toBe(false)
    expect(schema.safeParse({ prod_oids: Array.from({ length: 21 }, (_, i) => `p${i}`) }).success).toBe(false)
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
    const ctx = { accessToken: 'fake-jwt', userLabel: 'u', gateway: gateway as never }
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
