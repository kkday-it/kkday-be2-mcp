import { describe, it, expect } from 'vitest'
import { computeShelfDiff, diffVersionHash, DiffError } from '../src/changeset/diff.js'
import type { ToolContext } from '../src/tools/types.js'

function ctx(routes: Record<string, unknown>): ToolContext {
  return { accessToken: 'fake', userLabel: 'u', gateway: { get: async (p: string) => {
    for (const [frag, v] of Object.entries(routes)) if (p.includes(frag)) { if (v instanceof Error) throw v; return v }
    throw new Error(`unexpected ${p}`)
  } } as never }
}
const info = { name: 'Prod A', workflow_status: 'PUBLISHED' }
const sw = { is_active: true, is_locked_for_active: false }

describe('computeShelfDiff', () => {
  it('product: marks no_op when current==target, else a real change', async () => {
    const d = await computeShelfDiff('shelf_toggle_product',
      [{ prod_oid: 'p1', target_is_active: true }, { prod_oid: 'p1', target_is_active: false }],
      ctx({ '/info': info, '/switch': sw }))
    // note: two items same oid different target — test both branches via two separate calls in practice;
    expect(d[0]).toMatchObject({ prod_oid: 'p1', name: 'Prod A', current_is_active: true, target_is_active: true, no_op: true })
    expect(d[1]).toMatchObject({ prod_oid: 'p1', target_is_active: false, no_op: false })
  })
  it('plan: reads per-pkg current is_active from productPlansTool', async () => {
    const d = await computeShelfDiff('shelf_toggle_plan',
      [{ prod_oid: 'p1', pkg_oid: 'k1', target_is_active: false }],
      ctx({ '/packages': [{ pkg_oid: 'k1', item_oid: 'i1', pkg_name: 'Plan 1' }], '/package-configs': { config_data: { k1: { is_active: true } } } }))
    expect(d[0]).toMatchObject({ prod_oid: 'p1', pkg_oid: 'k1', name: 'Plan 1', current_is_active: true, target_is_active: false, no_op: false })
  })
  it('diffVersionHash is stable regardless of item order and changes when current state changes', () => {
    const a = [{ prod_oid: '1', target_is_active: false, no_op: false, current_is_active: true }]
    const b = [{ prod_oid: '2', target_is_active: true, no_op: false, current_is_active: false }]
    expect(diffVersionHash([...a, ...b])).toBe(diffVersionHash([...b, ...a]))
    expect(diffVersionHash(a)).not.toBe(diffVersionHash([{ ...a[0], current_is_active: false }]))
  })
  it('throws DiffError when a product read returns an error (never silently undefined)', async () => {
    const boom = Object.assign(new Error('403'), { code: 'FORBIDDEN', status: 403 })
    const c = ctx({ '/products/bad/info': boom, '/product-configs/bad/switch': boom })
    const err = await computeShelfDiff('shelf_toggle_product', [{ prod_oid: 'bad', target_is_active: false }], c).catch(e => e)
    expect(err).toBeInstanceOf(DiffError)
    // Minor fix: DiffError carries a machine-readable code so toEnvelopeError surfaces it
    // (previously `code` was undefined on the envelope error).
    expect(err.code).toBe('DIFF_READ_FAILED')
  })
})
