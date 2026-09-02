import { describe, it, expect } from 'vitest'
import { productPlansTool, normalizePackageConfigs } from '../src/tools/productPlans.js'
import type { ToolContext } from '../src/tools/types.js'
import { existsSync, readFileSync } from 'node:fs'

function ctxWith(routes: Record<string, unknown | Error>): ToolContext {
  return {
    accessToken: 'fake-jwt', userLabel: 'p@kkday.com',
    gateway: { get: async (path: string) => {
      for (const [frag, v] of Object.entries(routes)) if (path.includes(frag)) {
        if (v instanceof Error) throw v
        return v
      }
      throw new Error(`unexpected ${path}`)
    } } as never,
  }
}

// Real SIT shape: the packages list uses `pkg_name`, not `name` (Finding B).
const pkgs = [{ pkg_oid: 'k1', item_oid: 'i1', pkg_name: '標準方案', supplier_oid_list: [0] }]

describe('normalizePackageConfigs', () => {
  it('handles config_data object form', () => {
    const m = normalizePackageConfigs({ config_data: { k1: { is_active: true } } })
    expect(m.get('k1')).toEqual({ is_active: true })
  })
  it('handles array form', () => {
    const m = normalizePackageConfigs([{ pkg_oid: 'k1', is_active: false }])
    expect(m.get('k1')).toEqual({ is_active: false })
  })
})

describe('be2_get_product_plans', () => {
  it('merges package list with per-package is_active', async () => {
    const env = await productPlansTool.handler({ prod_oid: 'p1' },
      ctxWith({ '/packages': pkgs, '/package-configs': { config_data: { k1: { is_active: true } } } }))
    expect(env.items).toEqual([{ pkg_oid: 'k1', item_oid: 'i1', name: '標準方案', is_active: true }])
    expect(env.data_origin).toBe('be2_content')
    expect(env.read_oids.sort()).toEqual(['i1', 'k1', 'p1'])
  })
  it('missing config for a pkg -> is_active undefined, still listed', async () => {
    const env = await productPlansTool.handler({ prod_oid: 'p1' },
      ctxWith({ '/packages': pkgs, '/package-configs': { config_data: {} } }))
    expect((env.items[0] as { is_active?: boolean }).is_active).toBeUndefined()
  })
  it('packages succeed but package-configs rejects -> items still returned with is_active undefined, non-fatal error recorded', async () => {
    const boom = Object.assign(new Error('GET package-configs -> 500'), { status: 500 })
    const env = await productPlansTool.handler({ prod_oid: 'p1' },
      ctxWith({ '/packages': pkgs, '/package-configs': boom }))
    expect(env.items).toEqual([{ pkg_oid: 'k1', item_oid: 'i1', name: '標準方案', is_active: undefined }])
    expect(env.errors).toHaveLength(1)
    expect(env.errors[0]).toMatchObject({ key: 'p1', status: 500 })
    expect(env.read_oids.sort()).toEqual(['i1', 'k1', 'p1'])
  })
  it('packages rejects -> fatal, empty items, one error keyed by prod_oid', async () => {
    const boom = Object.assign(new Error('GET packages -> 500'), { status: 500 })
    const env = await productPlansTool.handler({ prod_oid: 'p1' },
      ctxWith({ '/packages': boom, '/package-configs': { config_data: { k1: { is_active: true } } } }))
    expect(env.items).toEqual([])
    expect(env.errors).toHaveLength(1)
    expect(env.errors[0]).toMatchObject({ key: 'p1', status: 500 })
  })

  it('只給 prod_mid → 呼叫 resolver、底層打 canonical oid、resolved_ids 帶出', async () => {
    const env = await productPlansTool.handler({ prod_mid: '10759' } as never,
      ctxWith({ 'mid-10759/info': { prod_oid: 38352 }, '/packages': pkgs, '/package-configs': { config_data: { k1: { is_active: true } } } }))
    expect(env.items).toEqual([{ pkg_oid: 'k1', item_oid: 'i1', name: '標準方案', is_active: true }])
    expect(env.resolved_ids).toEqual([{ mid: '10759', oid: '38352' }])
    expect(env.read_oids).toContain('38352')
  })

  it('只給 prod_oid → 不呼叫 resolver、無 resolved_ids', async () => {
    const env = await productPlansTool.handler({ prod_oid: 'p1' },
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
})

describe.skipIf(!existsSync('tests/fixtures/packages.json'))('fixture: real SIT shape', () => {
  it('produces items with pkg_oid + name from captured fixtures', async () => {
    const env = await productPlansTool.handler({ prod_oid: 'fx' }, ctxWith({
      '/packages': JSON.parse(readFileSync('tests/fixtures/packages.json', 'utf8')),
      '/package-configs': JSON.parse(readFileSync('tests/fixtures/package-configs.json', 'utf8')),
    }))
    expect(env.items.length).toBeGreaterThan(0)
    expect((env.items[0] as Record<string, unknown>).pkg_oid).toBeDefined()
  })
})
