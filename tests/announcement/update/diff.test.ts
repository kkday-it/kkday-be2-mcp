import { describe, it, expect, vi } from 'vitest'
import { computeAnnouncementUpdateDiff, parseCurrentProdOids } from '../../../src/modules/announcement/update/diff.js'
import type { AnnouncementUpdateItem } from '../../../src/core/changeset/types.js'

const item: AnnouncementUpdateItem = {
  announcementOid: 3084, prod_oids: ['765928'], name: '公告(新)', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'new' }],
}

function ctxWith(getImpl: (path: string) => Promise<unknown>) {
  return { gateway: { get: vi.fn(getImpl) }, accessToken: 'tok', userLabel: 'u' } as any
}

describe('parseCurrentProdOids (§6.3 read/write prodOids type asymmetry)', () => {
  it('parses the GET-shape JSON string', () => {
    expect(parseCurrentProdOids('[268051,285981]')).toEqual(['268051', '285981'])
  })
  it('accepts an already-array value defensively', () => {
    expect(parseCurrentProdOids([765928])).toEqual(['765928'])
  })
  it('degrades to [] on malformed input', () => {
    expect(parseCurrentProdOids('not json')).toEqual([])
    expect(parseCurrentProdOids(undefined)).toEqual([])
  })
})

describe('computeAnnouncementUpdateDiff', () => {
  it('reads product names + binds live current (before->after) via client.getDetail', async () => {
    const ctx = ctxWith(async () => ({ name: '商品A' }))
    const client = {
      getDetail: vi.fn().mockResolvedValue({
        name: '公告(舊)', isEnabled: true, prodOids: '[765928]', startTime: '2026-08-28 00:00:00', endTime: null,
        langs: [{ langCode: 'zh-tw', content: 'old' }],
      }),
    } as any
    const [d] = await computeAnnouncementUpdateDiff([item], ctx, client)
    expect(d.product_names).toEqual(['商品A'])
    expect(d.name).toBe('公告(新)')
    expect(d.current).not.toBeNull()
    expect(d.current?.name).toBe('公告(舊)')
    expect(d.current?.prod_oids).toEqual(['765928'])
    expect(d.current?.contents).toEqual([{ lang: 'zh-tw', content: 'old' }])
    expect(d.noop).toBe(false)
  })

  it('noop = true when current already matches target', async () => {
    const ctx = ctxWith(async () => ({ name: '商品A' }))
    const client = {
      getDetail: vi.fn().mockResolvedValue({
        name: item.name, isEnabled: item.is_enabled, prodOids: JSON.stringify(item.prod_oids.map(Number)),
        startTime: item.start_time, endTime: null, langs: item.contents.map(c => ({ langCode: c.lang, content: c.content })),
      }),
    } as any
    const [d] = await computeAnnouncementUpdateDiff([item], ctx, client)
    expect(d.noop).toBe(true)
  })

  it('degrades (does not throw) when current read fails; current=null', async () => {
    const ctx = ctxWith(async () => { throw new Error('boom') })
    const client = { getDetail: vi.fn().mockRejectedValue(new Error('403')) } as any
    const [d] = await computeAnnouncementUpdateDiff([item], ctx, client)
    expect(d.product_names).toEqual([])
    expect(d.current).toBeNull()
    expect(d.noop).toBe(false)  // current 未知時一律非 noop（保守）
  })

  it('degrades when client is undefined (no SIT_ANNOUNCE_API_KEY)', async () => {
    const ctx = ctxWith(async () => ({ name: '商品A' }))
    const [d] = await computeAnnouncementUpdateDiff([item], ctx, undefined)
    expect(d.current).toBeNull()
    expect(d.noop).toBe(false)
  })
})
