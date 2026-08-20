import { describe, it, expect } from 'vitest'
import { validateAnnouncementItems } from '../../src/modules/announcement/create/validate.js'
import type { AnnouncementCreateItem } from '../../src/core/changeset/types.js'

const ok: AnnouncementCreateItem = {
  prod_oids: ['7781'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: '2026-09-02 00:00:00',
  langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}

describe('validateAnnouncementItems', () => {
  it('passes a well-formed item', () => { expect(validateAnnouncementItems([ok])).toBeNull() })
  it('rejects empty name', () => { expect(validateAnnouncementItems([{ ...ok, name: '' }])?.message).toMatch(/name/) })
  it('rejects name > 254', () => { expect(validateAnnouncementItems([{ ...ok, name: 'x'.repeat(255) }])?.message).toMatch(/254/) })
  it('rejects empty prod_oids', () => { expect(validateAnnouncementItems([{ ...ok, prod_oids: [] }])?.message).toMatch(/prod_oids/) })
  it('rejects empty langs', () => { expect(validateAnnouncementItems([{ ...ok, langs: [] }])?.message).toMatch(/langs/) })
  it('rejects bad start_time format', () => { expect(validateAnnouncementItems([{ ...ok, start_time: '2026/09/01' }])?.message).toMatch(/start_time/) })
  it('rejects end_time before start_time', () => { expect(validateAnnouncementItems([{ ...ok, end_time: '2026-08-31 00:00:00' }])?.message).toMatch(/end_time/) })
  it('rejects lang without content', () => { expect(validateAnnouncementItems([{ ...ok, langs: ['zh-tw', 'ja-jp'] }])?.message).toMatch(/ja-jp/) })
})
