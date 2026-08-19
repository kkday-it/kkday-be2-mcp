import { describe, it, expect } from 'vitest'
import { computeBundleDiff } from '../src/modules/product/shelfToggleBundle/diff.js'
import { DiffError } from '../src/core/changeset/diff.js'
import type { BundleItem } from '../src/modules/product/shelfToggleBundle/types.js'

function gatewayWith(rowsByProd: Record<string, unknown>) {
  return {
    calls: [] as string[],
    async get(path: string) {
      this.calls.push(path)
      const m = /\/products\/([^/]+)\/bundle-package-configs$/.exec(path)
      return rowsByProd[m ? m[1] : ''] ?? []
    },
    async put() { throw new Error('diff must never write') },
  }
}

const ctxOf = (gw: unknown) => ({ gateway: gw as never, accessToken: 'at', userLabel: 'u' } as any)
const item = (o: Partial<BundleItem> = {}): BundleItem =>
  ({ prod_oid: 'p1', bundle_pkg_oid: 'b1', target_is_active: false, ...o })

describe('computeBundleDiff', () => {
  it('current is_active same as target -> no_op:true', async () => {
    const gw = gatewayWith({
      p1: [{ bundle_pkg_oid: 'b1', name: 'Bundle 1', is_active: false }]
    })
    const [d] = await computeBundleDiff([item({ target_is_active: false })], ctxOf(gw))
    expect(d.no_op).toBe(true)
    expect(d.current_is_active).toBe(false)
    expect(d.target_is_active).toBe(false)
    expect(d.name).toBe('Bundle 1')
    expect(d.prod_oid).toBe('p1')
    expect(d.bundle_pkg_oid).toBe('b1')
  })

  it('current is_active different from target -> no_op:false', async () => {
    const gw = gatewayWith({
      p1: [{ bundle_pkg_oid: 'b1', name: 'Bundle 1', is_active: true }]
    })
    const [d] = await computeBundleDiff([item({ target_is_active: false })], ctxOf(gw))
    expect(d.no_op).toBe(false)
    expect(d.current_is_active).toBe(true)
    expect(d.target_is_active).toBe(false)
  })

  it('missing bundle -> DiffError', async () => {
    const gw = gatewayWith({ p1: [] })
    await expect(computeBundleDiff([item()], ctxOf(gw))).rejects.toBeInstanceOf(DiffError)
  })

  it('missing is_active -> DiffError', async () => {
    const gw = gatewayWith({
      p1: [{ bundle_pkg_oid: 'b1', name: 'Bundle 1' }]
    })
    await expect(computeBundleDiff([item()], ctxOf(gw))).rejects.toBeInstanceOf(DiffError)
  })

  it('multiple bundle_pkg_oid on same prod_oid groups GET', async () => {
    const gw = gatewayWith({
      p1: [
        { bundle_pkg_oid: 'b1', name: 'B1', is_active: true },
        { bundle_pkg_oid: 'b2', name: 'B2', is_active: false }
      ]
    })
    const diffs = await computeBundleDiff([
      item({ bundle_pkg_oid: 'b1', target_is_active: false }),
      item({ bundle_pkg_oid: 'b2', target_is_active: true })
    ], ctxOf(gw))
    
    expect(diffs).toHaveLength(2)
    expect(gw.calls).toEqual(['/product/api/v1/products/p1/bundle-package-configs'])
  })

  it('supports config_data shape', async () => {
    const gw = gatewayWith({
      p1: {
        config_data: {
          'b1': { name: 'Bundle 1', is_active: true }
        }
      }
    })
    const [d] = await computeBundleDiff([item({ target_is_active: false })], ctxOf(gw))
    expect(d.no_op).toBe(false)
    expect(d.name).toBe('Bundle 1')
  })
})
