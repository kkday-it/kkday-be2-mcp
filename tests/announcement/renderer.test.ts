import { describe, it, expect } from 'vitest'
import { renderConfirm } from '../../src/modules/announcement/create/renderer.js'
import type { AnnouncementDiffItem, ChangeSetRecord } from '../../src/core/changeset/types.js'

const diff: AnnouncementDiffItem = {
  prod_oids: ['7781'], product_names: ['<商品A>'], name: '<b>颱風</b>', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: null, langs: ['zh-tw'],
  contents: [{ lang: 'zh-tw', content: '颱風<script>期間暫停' }], existing_count: 3, noop: false,
}
const rec = { id: 'cs1', actionType: 'announcement' } as unknown as ChangeSetRecord

describe('announcement renderConfirm', () => {
  it('escapes untrusted values (no raw HTML injection)', () => {
    const v = renderConfirm(rec, [diff], 'ver1', '')
    expect(v.tableHtml).not.toContain('<b>颱風</b>')
    expect(v.tableHtml).not.toContain('<script>期間')
    expect(v.tableHtml).toContain('&lt;b&gt;')
    expect(v.tableHtml).toContain('data-diff-version="ver1"')
  })
  it('shows high-risk banner (customer-facing) + existing count', () => {
    const v = renderConfirm(rec, [diff], 'ver1', '')
    expect(v.intro).toMatch(/前台/)
    expect(v.tableHtml).toContain('3')
  })
  it('shows per-lang content preview (escaped)', () => {
    const v = renderConfirm(rec, [diff], 'ver1', '')
    expect(v.tableHtml).toContain('zh-tw')
    expect(v.tableHtml).toContain('期間暫停')
  })
  it('shows dual timezone (UTC + GMT+8) for start_time', () => {
    const v = renderConfirm(rec, [diff], 'ver1', '')
    expect(v.tableHtml).toContain('2026-09-01 00:00:00 UTC')
    expect(v.tableHtml).toContain('2026-09-01 08:00:00 (GMT+8)')
  })
  it('en-default warn: shows a non-blocking note when langs lacks en-default', () => {
    const v = renderConfirm(rec, [diff], 'ver1', '')  // diff.langs = ['zh-tw'] (no en-default)
    expect(v.intro).toContain('en-default')
    expect(v.intro).toMatch(/提醒|不阻擋/)
  })
  it('en-default warn: no note when en-default present', () => {
    const withEn = { ...diff, langs: ['zh-tw', 'en-default'], contents: [{ lang: 'zh-tw', content: 'x' }, { lang: 'en-default', content: 'y' }] }
    const v = renderConfirm(rec, [withEn], 'ver1', '')
    expect(v.intro).not.toContain('en-default')
  })
  it('existing_count null renders as 未知', () => {
    const unknown = { ...diff, existing_count: null }
    const v = renderConfirm(rec, [unknown], 'ver1', '')
    expect(v.tableHtml).toContain('未知')
  })
})
