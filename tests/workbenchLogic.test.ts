// tests/workbenchLogic.test.ts
import { describe, it, expect } from 'vitest'
import { parseOidInput, splitBatches, ingestAnnouncement } from '../src/ui/workbenchLogic.js'

describe('parseOidInput', () => {
  it('多分隔 + 去重 + 去空', () => {
    expect(parseOidInput('546965, 546970\n546965  546988')).toEqual(['546965', '546970', '546988'])
  })
})
describe('splitBatches', () => {
  it('先按 action_type 分組、再按 cap 切', () => {
    const items = [
      { action_type: 'shelf_toggle_product', x: 1 }, { action_type: 'shelf_toggle_plan', x: 2 },
      { action_type: 'shelf_toggle_product', x: 3 },
    ]
    const b = splitBatches(items as never, 2)
    expect(b.map(g => g.action_type)).toEqual(['shelf_toggle_product', 'shelf_toggle_plan'])
    expect(b[0].items).toHaveLength(2)
  })
  it('超過 cap 同 action_type 切多塊', () => {
    const items = Array.from({ length: 25 }, () => ({ action_type: 'inventory_setting' }))
    const b = splitBatches(items as never, 20)
    expect(b).toHaveLength(2)
    expect(b[0].items).toHaveLength(20); expect(b[1].items).toHaveLength(5)
  })
})
describe('ingestAnnouncement', () => {
  it('抓 json 區塊、lang_code→langCode', () => {
    const raw = '（可讀版）...\n```json\n{"type":"be2-announcement-content","langs":[{"lang_code":"zh-tw","content":"你好"}]}\n```'
    expect(ingestAnnouncement(raw)).toEqual({ langs: [{ langCode: 'zh-tw', content: '你好' }] })
  })
  it('type 不符 → null', () => {
    expect(ingestAnnouncement('```json\n{"type":"x","langs":[]}\n```')).toBeNull()
  })
})
