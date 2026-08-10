import { describe, it, expect } from 'vitest'
import { execInventory } from '../src/changeset/executorInventory.js'
import type { InventoryItem } from '../src/changeset/types.js'

// Fake gateway: month GETs served from a mutable per-date store; PUT applies setRowQty-shaped
// bodies back into the store so the post-write re-read sees the result. Status endpoint scripted.
function fakeGw(opts: { qty: Record<string, number>; processing?: boolean[] }) {
  const processing = opts.processing ?? [false]
  let statusCall = 0
  const calls: Array<{ m: string; path: string; body?: unknown }> = []
  return {
    calls,
    qty: opts.qty,
    async get(path: string, _at: string, query?: Record<string, string>) {
      calls.push({ m: 'GET', path: `${path}${query ? `?ym=${query.year_month}` : ''}` })
      if (path.endsWith('/inventories/status')) {
        const v = processing[Math.min(statusCall, processing.length - 1)]; statusCall++
        return { is_processing: v }
      }
      const ym = query!.year_month
      return { itemInventory: Object.entries(opts.qty).filter(([d]) => d.startsWith(ym)).map(([date, quantity]) => ({ date, quantity })) }
    },
    async put(path: string, _at: string, body: unknown) {
      calls.push({ m: 'PUT', path, body })
      for (const row of ((body as Record<string, unknown>).itemInventory as Array<{ date: string; quantity: number }>)) {
        opts.qty[row.date] = row.quantity
      }
    },
  }
}
const item = (o: Partial<InventoryItem> = {}): InventoryItem =>
  ({ item_oid: 'i1', supplier_oid: 's1', op: 'adjust', quantity: 50, dates: ['2026-08-15'], ...o })
const deps = (gw: unknown) => ({ gateway: gw as never, sleep: async () => {}, poll: { retries: 2, delayMs: 0 } })

describe('execInventory', () => {
  it('adjust: applies delta to live base, re-reads after, records before/after + done', async () => {
    const gw = fakeGw({ qty: { '2026-08-15': 10 } })
    const r = await execInventory(deps(gw), 'at', 'MU', item(), 't1')
    expect(r).toMatchObject({ item_key: 'i1:s1', status: 'done', before: { '2026-08-15': 10 } })
    expect((r.after as { quantities: Record<string, number> }).quantities['2026-08-15']).toBe(60)
    const put = gw.calls.find(c => c.m === 'PUT')!
    expect(put.path).toBe('/product/api/v1/items/i1/inventories')
    expect((put.body as { modify_user: string }).modify_user).toBe('MU')
  })
  it('read-merge-write: PUT echoes the FULL month rows, only target dates changed', async () => {
    const gw = fakeGw({ qty: { '2026-08-15': 10, '2026-08-16': 7 } })
    await execInventory(deps(gw), 'at', 'MU', item(), 't1')
    const rows = (gw.calls.find(c => c.m === 'PUT')!.body as { itemInventory: Array<{ date: string; quantity: number }> }).itemInventory
    expect(rows).toContainEqual({ date: '2026-08-16', quantity: 7 })   // unmentioned date preserved verbatim
    expect(rows).toContainEqual({ date: '2026-08-15', quantity: 60 })
  })
  it('set no-op date: skipped, no PUT at all when every date is no-op', async () => {
    const gw = fakeGw({ qty: { '2026-08-15': 100 } })
    const r = await execInventory(deps(gw), 'at', 'MU', item({ op: 'set', quantity: 100 }), 't1')
    expect(r.status).toBe('skipped_noop')
    expect(gw.calls.some(c => c.m === 'PUT')).toBe(false)
  })
  it('would_go_negative date fails, sibling date succeeds => item partial (NEVER failed)', async () => {
    const gw = fakeGw({ qty: { '2026-08-15': 10, '2026-08-16': 100 } })
    const r = await execInventory(deps(gw), 'at', 'MU', item({ quantity: -20, dates: ['2026-08-15', '2026-08-16'] }), 't1')
    expect(r.status).toBe('partial')
    const ds = (r.after as { date_status: Record<string, string> }).date_status
    expect(ds['2026-08-15']).toBe('failed')
    expect(ds['2026-08-16']).toBe('done')
    expect(r.error_code).toBe('WOULD_GO_NEGATIVE')
  })
  it('cross-month: one full GET+PUT cycle per month; month-2 PUT failure => partial with month-1 kept', async () => {
    const gw = fakeGw({ qty: { '2026-08-31': 1, '2026-09-01': 2 } })
    const origPut = gw.put.bind(gw)
    let puts = 0
    gw.put = async (p: string, a: string, b: unknown) => { puts++; if (puts === 2) throw Object.assign(new Error('boom'), { code: 'GW_500' }); return origPut(p, a, b) }
    const r = await execInventory(deps(gw), 'at', 'MU', item({ dates: ['2026-08-31', '2026-09-01'] }), 't1')
    expect(r.status).toBe('partial')
    const ds = (r.after as { date_status: Record<string, string> }).date_status
    expect(ds['2026-08-31']).toBe('done')
    expect(ds['2026-09-01']).toBe('failed')
  })
  it('bare-array GET shape: PUT body is an OBJECT with rows wrapped + modify_user surviving stringify', async () => {
    const calls: Array<{ m: string; body?: unknown }> = []
    const gw = {
      calls,
      async get(path: string) {
        calls.push({ m: 'GET' })
        if (path.endsWith('/inventories/status')) return { is_processing: false }
        return [{ date: '2026-08-15', quantity: 10 }]          // bare array response
      },
      async put(_p: string, _a: string, body: unknown) { calls.push({ m: 'PUT', body }) },
    }
    const r = await execInventory(deps(gw), 'at', 'MU', item(), 't1')
    const putBody = calls.find(c => c.m === 'PUT')!.body as Record<string, unknown>
    expect(Array.isArray(putBody)).toBe(false)
    expect(JSON.parse(JSON.stringify(putBody)).modify_user).toBe('MU')   // survives serialization
    expect((putBody.itemInventory as Array<{ quantity: number }>)[0].quantity).toBe(60)
    expect(r.status).toBe('done')
  })
  it('set on a date with NO existing live row: injects a new row into the PUT payload', async () => {
    const gw = fakeGw({ qty: { '2026-08-16': 7 } })   // 08-15 has no row
    const r = await execInventory(deps(gw), 'at', 'MU', item({ op: 'set', quantity: 5, dates: ['2026-08-15'] }), 't1')
    const rows = (gw.calls.find(c => c.m === 'PUT')!.body as { itemInventory: Array<{ date: string; quantity: number }> }).itemInventory
    expect(rows).toContainEqual({ date: '2026-08-15', quantity: 5 })   // injected, not dropped
    expect(rows).toContainEqual({ date: '2026-08-16', quantity: 7 })   // existing row preserved
    expect(r.status).toBe('done')
  })
  it('PUT succeeds but after-re-read fails: dates stay done (NEVER failed — no double-apply bait)', async () => {
    const gw = fakeGw({ qty: { '2026-08-15': 10 } })
    const origGet = gw.get.bind(gw)
    let qtyGets = 0
    gw.get = async (p: string, a: string, q?: Record<string, string>) => {
      if (!p.includes('/status') && ++qtyGets === 2) throw Object.assign(new Error('blip'), { code: 'GW_TIMEOUT' })
      return origGet(p, a, q)
    }
    const r = await execInventory(deps(gw), 'at', 'MU', item(), 't1')
    expect(r.status).toBe('done')
    expect((r.after as { date_status: Record<string, string> }).date_status['2026-08-15']).toBe('done')
    expect(r.error_code).toBe('AFTER_READ_FAILED')
    expect((r.after as { quantities: Record<string, number> }).quantities['2026-08-15']).toBeUndefined()
  })
  it('busy guard: is_processing stays true past poll budget => INVENTORY_BUSY, zero reads/writes of quantities', async () => {
    const gw = fakeGw({ qty: { '2026-08-15': 10 }, processing: [true, true, true] })
    const r = await execInventory(deps(gw), 'at', 'MU', item(), 't1')
    expect(r).toMatchObject({ status: 'failed', error_code: 'INVENTORY_BUSY' })
    expect(gw.calls.filter(c => c.m === 'GET' && !c.path.includes('/status'))).toHaveLength(0)
    expect(gw.calls.some(c => c.m === 'PUT')).toBe(false)
  })
  it('busy guard: processing clears within budget => proceeds', async () => {
    const gw = fakeGw({ qty: { '2026-08-15': 10 }, processing: [true, false] })
    const r = await execInventory(deps(gw), 'at', 'MU', item(), 't1')
    expect(r.status).toBe('done')
  })
})
