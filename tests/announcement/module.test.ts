import { describe, it, expect } from 'vitest'
import { announcementCreateModule as m } from '../../src/modules/announcement/create/module.js'
import type { AnnouncementCreateItem, AnnouncementDiffItem } from '../../src/core/changeset/types.js'

const item: AnnouncementCreateItem = {
  prod_oids: ['7781'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}
const diff: AnnouncementDiffItem = {
  prod_oids: ['7781'], product_names: ['A'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: null, langs: ['zh-tw'],
  contents: [{ lang: 'zh-tw', content: 'hi' }], existing_count: 0, noop: false,
}

describe('announcementCreateModule', () => {
  it('has action_type announcement + announcement action code', () => {
    expect(m.actionType).toBe('announcement')
    expect(m.authz.codes).toContain('product.announcement.update')
  })
  it('itemSchema accepts a valid item, rejects missing name', () => {
    expect(m.itemSchema.safeParse(item).success).toBe(true)
    expect(m.itemSchema.safeParse({ ...item, name: undefined }).success).toBe(false)
  })
  it('isItem type guard', () => {
    expect(m.isItem(item)).toBe(true)
    expect(m.isItem({ item_oid: '1' })).toBe(false)
  })
  it('scopeOids = prod_oids', () => { expect(m.scopeOids(item)).toEqual(['7781']) })
  it('itemKey (item and diff) agree', () => { expect(m.itemKey(item)).toBe(m.itemKey(diff as any)) })
  it('diffVersion stable + sensitive to name and content', () => {
    const v1 = m.diffVersion([diff])
    expect(v1).toBe(m.diffVersion([{ ...diff, existing_count: 99 }])) // existing_count NOT in hash
    expect(v1).not.toBe(m.diffVersion([{ ...diff, name: '別的' }]))
    expect(v1).not.toBe(m.diffVersion([{ ...diff, contents: [{ lang: 'zh-tw', content: 'changed' }] }]))
  })
})
