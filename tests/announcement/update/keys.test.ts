import { describe, it, expect } from 'vitest'
import { itemKey } from '../../../src/modules/announcement/update/keys.js'
import type { AnnouncementUpdateItem } from '../../../src/core/changeset/types.js'

const base: AnnouncementUpdateItem = {
  announcementOid: 3084, prod_oids: ['7781', '16384'], name: '颱風公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'x' }],
}

describe('announcement_update itemKey', () => {
  it('is stable and order-independent on prod_oids', () => {
    const k1 = itemKey(base)
    const k2 = itemKey({ ...base, prod_oids: ['16384', '7781'] })
    expect(k1).toBe('announce_update:3084:颱風公告:16384,7781:2026-09-01 00:00:00')
    expect(k2).toBe(k1)
  })
  it('does not mutate the input prod_oids array', () => {
    const item = { ...base, prod_oids: ['b', 'a'] }
    itemKey(item)
    expect(item.prod_oids).toEqual(['b', 'a'])
  })
  it('differentiates same name/prod_oids/start_time by announcementOid', () => {
    const k1 = itemKey(base)
    const k2 = itemKey({ ...base, announcementOid: 9999 })
    expect(k1).not.toBe(k2)
  })
})
