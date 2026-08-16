import { describe, it, expect } from 'vitest'
import { computeScheduleDiff } from '../src/modules/product/shelfSchedule/diff.js'
import { computeChangesetDiff, DiffError } from '../src/modules/product/shelfToggle/diff.js'
import { shelfScheduleModule } from '../src/modules/product/shelfSchedule/module.js'
const diffVersionHash = shelfScheduleModule.diffVersion as (d: unknown[]) => string
import type { ShelfScheduleItem, ShelfScheduleDiffItem } from '../src/core/changeset/types.js'

// Task 4 定案 (docs/superpowers/specs/2026-08-14-be2-mcp-baa-wizard-design.md §4.1/§4.2):
// GET /product/api/v1/products/{prodOid}/package-configs -> array, elements carry
// pkg_oid,name,is_bundle,reserve_queue[] (queue entries carry server fields created_at/created_by
// that must be stripped via sanitizeQueue before comparing).
function gatewayWith(rowsByProd: Record<string, unknown[]>) {
  return {
    calls: [] as string[],
    async get(path: string) {
      this.calls.push(path)
      const m = /\/products\/([^/]+)\/package-configs$/.exec(path)
      return rowsByProd[m ? m[1] : ''] ?? []
    },
    async put() { throw new Error('diff must never write') },
  }
}
const ctxOf = (gw: unknown) => ({ gateway: gw as never, accessToken: 'at', userLabel: 'u' })
const item = (o: Partial<ShelfScheduleItem> = {}): ShelfScheduleItem =>
  ({ prod_oid: 'p1', pkg_oid: 'k1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }], ...o })

describe('computeScheduleDiff', () => {
  it('current queue (out-of-order, w/ server fields) equal to target content -> noop:true', async () => {
    const gw = gatewayWith({
      p1: [{
        pkg_oid: 'k1', name: 'Plan A', is_bundle: false,
        reserve_queue: [
          { reserve_date: '2027-02-01 00:00:00', reserve_status: false, created_at: 't1', created_by: 'u1' },
          { reserve_date: '2027-01-01 00:00:00', reserve_status: true, created_at: 't2', created_by: 'u2' },
        ],
      }],
    })
    const [d] = await computeScheduleDiff([item({
      queue: [
        { reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true },
        { reserve_date_utc: '2027-02-01 00:00:00', reserve_status: false },
      ],
    })], ctxOf(gw))
    expect(d.noop).toBe(true)
    expect(d.pkg_name).toBe('Plan A')
  })

  it('is_bundle:true package -> DiffError, never diffed', async () => {
    const gw = gatewayWith({ p1: [{ pkg_oid: 'k1', name: 'Bundle X', is_bundle: true, reserve_queue: [] }] })
    await expect(computeScheduleDiff([item()], ctxOf(gw))).rejects.toBeInstanceOf(DiffError)
  })

  it('pkg_oid not present under the product -> DiffError', async () => {
    const gw = gatewayWith({ p1: [{ pkg_oid: 'k-other', name: 'X', is_bundle: false, reserve_queue: [] }] })
    await expect(computeScheduleDiff([item()], ctxOf(gw))).rejects.toBeInstanceOf(DiffError)
  })

  it('different content -> noop:false, sanitized current_queue + sorted new_queue carried on the diff item', async () => {
    const gw = gatewayWith({ p1: [{ pkg_oid: 'k1', name: 'Plan A', is_bundle: false, reserve_queue: [] }] })
    const [d] = await computeScheduleDiff([item()], ctxOf(gw))
    expect(d.noop).toBe(false)
    expect(d.current_queue).toEqual([])
    expect(d.new_queue).toEqual([{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }])
  })

  it('empty target queue (clear schedule) against a non-empty current -> noop:false, new_queue: []', async () => {
    const gw = gatewayWith({
      p1: [{ pkg_oid: 'k1', name: 'Plan A', is_bundle: false, reserve_queue: [{ reserve_date: '2027-01-01 00:00:00', reserve_status: true }] }],
    })
    const [d] = await computeScheduleDiff([item({ queue: [] })], ctxOf(gw))
    expect(d.noop).toBe(false)
    expect(d.new_queue).toEqual([])
  })

  it('multiple items on the same prod_oid issue exactly one GET (grouped read)', async () => {
    const gw = gatewayWith({
      p1: [
        { pkg_oid: 'k1', name: 'Plan A', is_bundle: false, reserve_queue: [] },
        { pkg_oid: 'k2', name: 'Plan B', is_bundle: false, reserve_queue: [] },
      ],
    })
    const diff = await computeScheduleDiff([item({ pkg_oid: 'k1' }), item({ pkg_oid: 'k2' })], ctxOf(gw))
    expect(diff).toHaveLength(2)
    expect(gw.calls).toEqual(['/product/api/v1/products/p1/package-configs'])
  })
})

describe('computeChangesetDiff dispatcher routes shelf_schedule', () => {
  it('routes shelf_schedule to computeScheduleDiff (no longer the Task-3 stub DiffError)', async () => {
    const gw = gatewayWith({ p1: [{ pkg_oid: 'k1', name: 'Plan A', is_bundle: false, reserve_queue: [] }] })
    const diff = await computeChangesetDiff('shelf_schedule', [item()], ctxOf(gw))
    expect((diff[0] as ShelfScheduleDiffItem).pkg_oid).toBe('k1')
  })
})

describe('diffVersionHash — ShelfScheduleDiffItem explicit branch (Task 4)', () => {
  const mk = (queue: Array<{ reserve_date_utc: string; reserve_status: boolean }>): ShelfScheduleDiffItem[] => ([{
    prod_oid: 'p1', pkg_oid: 'k1', pkg_name: 'Plan A', current_queue: queue, new_queue: [], noop: queue.length === 0,
  }])

  it('computes without throwing (does not crash reading .dates/.target off a schedule diff item)', () => {
    expect(() => diffVersionHash(mk([]))).not.toThrow()
  })

  it('same current-queue content, different order -> same hash', () => {
    const a = mk([
      { reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true },
      { reserve_date_utc: '2027-02-01 00:00:00', reserve_status: false },
    ])
    const b = mk([
      { reserve_date_utc: '2027-02-01 00:00:00', reserve_status: false },
      { reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true },
    ])
    expect(diffVersionHash(a)).toBe(diffVersionHash(b))
  })

  it('current-queue content change -> hash MUST change (guards the fallback constant-hash bug)', () => {
    const a = mk([{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }])
    const b = mk([{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: false }])
    expect(diffVersionHash(a)).not.toBe(diffVersionHash(b))
  })
})
