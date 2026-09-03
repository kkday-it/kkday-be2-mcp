import { describe, it, expect } from 'vitest'
import { renderConfirm } from '../../../src/modules/announcement/update/renderer.js'
import type { AnnouncementUpdateDiffItem, ChangeSetRecord } from '../../../src/core/changeset/types.js'

const rec = { id: 'cs1', actionType: 'announcement_update' } as unknown as ChangeSetRecord

function diffItem(current: AnnouncementUpdateDiffItem['current']): AnnouncementUpdateDiffItem {
  return {
    announcementOid: 3084, prod_oids: ['765928'], product_names: ['A'], name: '公告(新)', is_enabled: true,
    start_time: '2026-09-01 00:00:00', end_time: null, langs: ['zh-tw'],
    contents: [{ lang: 'zh-tw', content: 'hi' }], current, noop: false,
  }
}
const currentKnown: AnnouncementUpdateDiffItem['current'] = {
  name: '公告(舊)', is_enabled: true, prod_oids: ['765928'], start_time: '2026-08-28 00:00:00',
  end_time: null, langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'old' }],
}

describe('announcement_update renderConfirm — blind full-replace visibility', () => {
  it('warns explicitly when current is unreadable (approver cannot preview which langs/fields get deleted)', () => {
    const v = renderConfirm(rec, [diffItem(null)], 'ver1', '')
    expect(v.intro).toContain('無法預覽')          // explicit blind-full-replace warning in the intro
    expect(v.tableHtml).toContain('現況讀取失敗')     // per-row before-unknown marker still present
  })
  it('does NOT show the blind-replace warning when current is known (before/after fully previewable)', () => {
    const v = renderConfirm(rec, [diffItem(currentKnown)], 'ver1', '')
    expect(v.intro).not.toContain('無法預覽')
  })
})
