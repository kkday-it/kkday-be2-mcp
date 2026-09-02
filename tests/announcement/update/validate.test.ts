import { describe, it, expect } from 'vitest'
import { validateAnnouncementUpdateItems } from '../../../src/modules/announcement/update/validate.js'
import type { AnnouncementUpdateItem } from '../../../src/core/changeset/types.js'

const ok: AnnouncementUpdateItem = {
  announcementOid: 3084, prod_oids: ['765928'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: '2026-09-02 00:00:00',
  langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}

describe('validateAnnouncementUpdateItems', () => {
  it('passes a well-formed item', () => { expect(validateAnnouncementUpdateItems([ok])).toBeNull() })
  it('rejects missing announcementOid', () => {
    expect(validateAnnouncementUpdateItems([{ ...ok, announcementOid: 0 }])?.message).toMatch(/announcementOid/)
  })
  it('rejects empty name', () => { expect(validateAnnouncementUpdateItems([{ ...ok, name: '' }])?.message).toMatch(/name/) })
  it('rejects name > 254', () => { expect(validateAnnouncementUpdateItems([{ ...ok, name: 'x'.repeat(255) }])?.message).toMatch(/254/) })
  it('rejects empty prod_oids', () => { expect(validateAnnouncementUpdateItems([{ ...ok, prod_oids: [] }])?.message).toMatch(/prod_oids/) })
  it('rejects empty langs', () => { expect(validateAnnouncementUpdateItems([{ ...ok, langs: [] }])?.message).toMatch(/langs/) })
  it('rejects bad start_time format', () => { expect(validateAnnouncementUpdateItems([{ ...ok, start_time: '2026/09/01' }])?.message).toMatch(/start_time/) })
  it('rejects end_time before start_time', () => { expect(validateAnnouncementUpdateItems([{ ...ok, end_time: '2026-08-31 00:00:00' }])?.message).toMatch(/end_time/) })
  it('rejects lang without content', () => { expect(validateAnnouncementUpdateItems([{ ...ok, langs: ['zh-tw', 'ja-jp'] }])?.message).toMatch(/ja-jp/) })
})
