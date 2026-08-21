import { describe, it, expect, vi } from 'vitest'
import { computeAnnouncementDiff } from '../../src/modules/announcement/create/diff.js'
import type { AnnouncementCreateItem } from '../../src/core/changeset/types.js'

const item: AnnouncementCreateItem = {
  prod_oids: ['7781', '16384'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}

function ctxWith(getImpl: (path: string) => Promise<unknown>) {
  return { gateway: { get: vi.fn(getImpl) }, accessToken: 'tok', userLabel: 'u' } as any
}

describe('computeAnnouncementDiff', () => {
  it('reads product names + existing announcement count', async () => {
    const ctx = ctxWith(async (p) => p.includes('7781') ? { name: '商品A' } : { name: '商品B' })
    const client = { listByProdOids: vi.fn().mockResolvedValue([{ productAnnouncementOid: 1 }, { productAnnouncementOid: 2 }]) } as any
    const [d] = await computeAnnouncementDiff([item], ctx, client)
    expect(d.product_names).toEqual(['商品A', '商品B'])
    expect(d.existing_count).toBe(2)
    expect(d.noop).toBe(false)
    expect(d.name).toBe('公告')
  })
  it('degrades (does not throw) when reads fail', async () => {
    const ctx = ctxWith(async () => { throw new Error('boom') })
    const client = { listByProdOids: vi.fn().mockRejectedValue(new Error('403')) } as any
    const [d] = await computeAnnouncementDiff([item], ctx, client)
    expect(d.product_names).toEqual([])
    expect(d.existing_count).toBeNull()  // null = 讀不到（顯示層呈現「未知」）
  })
})
