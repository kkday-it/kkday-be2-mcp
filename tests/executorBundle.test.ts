import { describe, it, expect } from 'vitest'
import { executeBundleToggle } from '../src/modules/product/shelfToggleBundle/executor.js'
import type { BundleItem } from '../src/modules/product/shelfToggleBundle/types.js'
import type { ChangeSetRecord } from '../src/core/changeset/types.js'

function fakeGw(configsByProd: Record<string, unknown>, opts: { putShouldFail?: Set<string> } = {}) {
  const calls: Array<{ m: string; path: string; body?: unknown }> = []
  return {
    calls,
    async get(path: string) {
      calls.push({ m: 'GET', path })
      const m = /\/products\/([^/]+)\/bundle-package-configs$/.exec(path)!
      return configsByProd[m[1]]
    },
    async put(path: string, _at: string, body: unknown) {
      calls.push({ m: 'PUT', path, body })
      const m = /\/products\/([^/]+)\/bundle-package-configs$/.exec(path)!
      if (opts.putShouldFail?.has(m[1])) throw Object.assign(new Error('boom'), { code: 'GW_500' })
    },
  }
}

const ctxOf = (gw: unknown) => ({ gateway: gw as never, accessToken: 'at', modifyUser: 'MU', traceId: 't1', span: async (_: string, fn: Function) => fn('t1') } as any)

function recOf(items: BundleItem[]): ChangeSetRecord {
  return {
    id: 'cs1', creatorLabel: 'u', creatorBearerHash: 'bh', sessionId: 's1', actionType: 'shelf_toggle_bundle',
    items: items as any, diff: [], diffVersion: 'v', status: 'approved', createdAt: 1000,
  }
}

describe('executeBundleToggle', () => {
  it('read-merge-write updates only target is_active and strips readonly fields', async () => {
    const items: BundleItem[] = [{ prod_oid: 'p1', bundle_pkg_oid: 'b1', target_is_active: false }]
    const gw = fakeGw({
      p1: [{ bundle_pkg_oid: 'b1', is_active: true, updated_by: 'x', updated_at: 'y', name: 'B1' }]
    })
    const results = await executeBundleToggle(ctxOf(gw), recOf(items))
    expect(results[0].status).toBe('done')
    const put = gw.calls.find(c => c.m === 'PUT')!
    expect(put.path).toBe('/product/api/v1/products/p1/bundle-package-configs')
    expect(put.body).toEqual({
      modify_user: 'MU',
      config_data: {
        'b1': { is_active: false, name: 'B1' } // updated_by, updated_at and bundle_pkg_oid stripped
      }
    })
  })

  it('no_op skips PUT', async () => {
    const items: BundleItem[] = [{ prod_oid: 'p1', bundle_pkg_oid: 'b1', target_is_active: true }]
    const gw = fakeGw({
      p1: [{ bundle_pkg_oid: 'b1', is_active: true }]
    })
    const results = await executeBundleToggle(ctxOf(gw), recOf(items))
    expect(results[0].status).toBe('skipped_noop')
    expect(gw.calls.some(c => c.m === 'PUT')).toBe(false)
  })

  it('gateway error strands items in error', async () => {
    const items: BundleItem[] = [{ prod_oid: 'p1', bundle_pkg_oid: 'b1', target_is_active: false }]
    const gw = fakeGw({
      p1: [{ bundle_pkg_oid: 'b1', is_active: true }]
    }, { putShouldFail: new Set(['p1']) })
    const results = await executeBundleToggle(ctxOf(gw), recOf(items))
    expect(results[0].status).toBe('failed')
    expect(results[0].error_code).toBe('GW_500')
  })

  it('handles config_data object shape', async () => {
    const items: BundleItem[] = [{ prod_oid: 'p1', bundle_pkg_oid: 'b1', target_is_active: false }]
    const gw = fakeGw({
      p1: { config_data: { 'b1': { is_active: true, name: 'B1' } } }
    })
    const results = await executeBundleToggle(ctxOf(gw), recOf(items))
    expect(results[0].status).toBe('done')
    const put = gw.calls.find(c => c.m === 'PUT')!
    expect(put.body).toEqual({
      modify_user: 'MU',
      config_data: { 'b1': { is_active: false, name: 'B1' } }
    })
  })

  it('multiple items on same prod group PUT and update selectively', async () => {
    const items: BundleItem[] = [
      { prod_oid: 'p1', bundle_pkg_oid: 'b1', target_is_active: false },
      { prod_oid: 'p1', bundle_pkg_oid: 'b2', target_is_active: true }
    ]
    const gw = fakeGw({
      p1: [
        { bundle_pkg_oid: 'b1', is_active: true, name: 'B1' },
        { bundle_pkg_oid: 'b2', is_active: false, name: 'B2' },
        { bundle_pkg_oid: 'b3', is_active: true, name: 'B3' } // untargeted
      ]
    })
    const results = await executeBundleToggle(ctxOf(gw), recOf(items))
    expect(results).toHaveLength(2)
    expect(results.every(r => r.status === 'done')).toBe(true)
    const put = gw.calls.find(c => c.m === 'PUT')!
    expect(put.body).toEqual({
      modify_user: 'MU',
      config_data: {
        'b1': { is_active: false, name: 'B1' },
        'b2': { is_active: true, name: 'B2' },
        'b3': { is_active: true, name: 'B3' }
      }
    })
  })
})
