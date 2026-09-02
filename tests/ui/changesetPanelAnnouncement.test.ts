import { describe, it, expect } from 'vitest'
// itemKeyOf 已抽到獨立、無 DOM 依賴的模組（changeset-panel.ts 在 import 時會觸碰 document、非
// import-safe）。changeset-panel.ts 從此模組 import 同一份 itemKeyOf，故此處測到的即面板實際用的。
import { itemKeyOf } from '../../src/ui/changesetItemKey.js'
import { itemKey as announceKey } from '../../src/modules/announcement/create/keys.js'
import { itemKey as announceUpdateKey } from '../../src/modules/announcement/update/keys.js'

describe('changeset-panel itemKeyOf: announcement', () => {
  it('produces announce:... for an announcement (create) diff item (not "undefined")', () => {
    const d = { prod_oids: ['7781', '16384'], name: '公告', start_time: '2026-09-01 00:00:00' }
    const k = itemKeyOf(d as any)
    expect(k).not.toBe('undefined')
    expect(k).toBe(announceKey(d as any))
    expect(k.startsWith('announce:')).toBe(true)
  })

  it('produces announce_update:... for an announcement_update diff item (has announcementOid), matching the server key', () => {
    const d = { announcementOid: 3084, prod_oids: ['765928'], name: '公告', start_time: '2026-09-01 00:00:00' }
    const k = itemKeyOf(d as any)
    // must equal the server-side update itemKey (else confirmed_keys mismatch → 409 on approve)
    expect(k).toBe(announceUpdateKey(d as any))
    expect(k.startsWith('announce_update:')).toBe(true)
    // regression: must NOT collapse to the create key, which omits announcementOid
    expect(k).not.toBe(announceKey(d as any))
  })
})
