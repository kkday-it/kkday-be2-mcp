import { describe, it, expect } from 'vitest'
import { announcementUpdateModule as m } from '../../../src/modules/announcement/update/module.js'
import type { AnnouncementUpdateItem, AnnouncementUpdateDiffItem } from '../../../src/core/changeset/types.js'

const item: AnnouncementUpdateItem = {
  announcementOid: 3084, prod_oids: ['765928'], name: '公告(新)', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}
const diff: AnnouncementUpdateDiffItem = {
  announcementOid: 3084, prod_oids: ['765928'], product_names: ['A'], name: '公告(新)', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: null, langs: ['zh-tw'],
  contents: [{ lang: 'zh-tw', content: 'hi' }],
  current: {
    name: '公告(舊)', is_enabled: true, prod_oids: ['765928'], start_time: '2026-08-28 00:00:00',
    end_time: null, langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'old' }],
  },
  noop: false,
}

describe('announcementUpdateModule', () => {
  it('has action_type announcement_update + announcement.update action code', () => {
    expect(m.actionType).toBe('announcement_update')
    expect(m.authz.codes).toContain('product.announcement.update')
  })
  it('itemSchema accepts a valid item, rejects missing name / missing announcementOid', () => {
    expect(m.itemSchema.safeParse(item).success).toBe(true)
    expect(m.itemSchema.safeParse({ ...item, name: undefined }).success).toBe(false)
    expect(m.itemSchema.safeParse({ ...item, announcementOid: undefined }).success).toBe(false)
  })
  it('rejects a create-shape item (no announcementOid)', () => {
    const { announcementOid: _drop, ...createShape } = item
    expect(m.itemSchema.safeParse(createShape).success).toBe(false)
    expect(m.isItem(createShape)).toBe(false)
  })
  it('isItem type guard', () => {
    expect(m.isItem(item)).toBe(true)
    expect(m.isItem({ item_oid: '1' })).toBe(false)
  })
  it('scopeOids = prod_oids', () => { expect(m.scopeOids(item)).toEqual(['765928']) })
  it('itemKey (item and diff) agree', () => { expect(m.itemKey(item)).toBe(m.itemKey(diff as any)) })
  it('diffVersion stable + sensitive to target name/content and to live current', () => {
    const v1 = m.diffVersion([diff])
    expect(v1).toBe(m.diffVersion([{ ...diff }]))
    expect(v1).not.toBe(m.diffVersion([{ ...diff, name: '別的' }]))
    expect(v1).not.toBe(m.diffVersion([{ ...diff, contents: [{ lang: 'zh-tw', content: 'changed' }] }]))
    expect(v1).not.toBe(m.diffVersion([{ ...diff, current: { ...diff.current!, name: '被別人改過的名字' } }]))
    expect(v1).not.toBe(m.diffVersion([{ ...diff, current: null }]))
  })
})
