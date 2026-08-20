import { describe, it, expect } from 'vitest'
import { itemKey } from '../../src/modules/announcement/create/keys.js'
import type { AnnouncementCreateItem } from '../../src/core/changeset/types.js'

const base: AnnouncementCreateItem = {
  prod_oids: ['7781', '16384'], name: '颱風公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'x' }],
}

describe('announcement itemKey', () => {
  it('is stable and order-independent on prod_oids', () => {
    const k1 = itemKey(base)
    const k2 = itemKey({ ...base, prod_oids: ['16384', '7781'] })
    expect(k1).toBe('announce:颱風公告:16384,7781:2026-09-01 00:00:00')
    expect(k2).toBe(k1)
  })
  it('does not mutate the input prod_oids array', () => {
    const item = { ...base, prod_oids: ['b', 'a'] }
    itemKey(item)
    expect(item.prod_oids).toEqual(['b', 'a'])
  })
})
