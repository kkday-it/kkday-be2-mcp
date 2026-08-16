import { describe, it, expect, beforeAll } from 'vitest'
import { getModule, listModules, resetRegistryForTest } from '../../src/core/changeset/registry.js'
import { registerAllModules } from '../../src/modules/index.js'

// 各 module 一筆合法 item 樣本（從既有測試 fixture 取值）
const SAMPLES: Record<string, unknown> = {
  shelf_toggle_product: { prod_oid: '546965', target_is_active: false },
  shelf_toggle_plan: { prod_oid: '546965', pkg_oid: '888', target_is_active: false },
  inventory_setting: { item_oid: '1713281', supplier_oid: '0', op: 'set', quantity: 5, dates: ['2027-01-01'] },
  inventory_platform: { item_oid: '1713281', supplier_oid: '0', target: 'BE2_SCM', affected_pkgs: [{ prod_oid: '34133', pkg_oid: '1', pkg_name: 'x' }] },
  shelf_schedule: { prod_oid: '34133', pkg_oid: '1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] },
}

beforeAll(() => { resetRegistryForTest(); registerAllModules() })

describe('module conformance', () => {
  it('union 成員 ⇔ registry 一一對應', () => {
    expect(listModules().map(m => m.actionType).sort()).toEqual(Object.keys(SAMPLES).sort())
  })
  
  for (const [type, sample] of Object.entries(SAMPLES)) {
    it(`${type}: itemSchema 接受自己的樣本`, () => {
      const m = getModule(type)
      expect(() => m.itemSchema.parse(sample)).not.toThrow()
    })
    
    it(`${type}: itemSchema+isItem 拒絕其他 module 的樣本`, () => {
      const m = getModule(type)
      for (const [otherType, otherSample] of Object.entries(SAMPLES)) {
        if (type === otherType) continue
        if ((type === 'shelf_toggle_product' && otherType === 'shelf_toggle_plan') ||
            (type === 'shelf_toggle_plan' && otherType === 'shelf_toggle_product')) {
          continue
        }
        const parsed = m.itemSchema.safeParse(otherSample)
        const isItem = m.isItem(otherSample)
        expect(!parsed.success || !isItem).toBe(true)
      }
    })
    
    it(`${type}: itemKey(item) 非空且不含 undefined`, () => {
      const m = getModule(type)
      const key = m.itemKey(sample as any)
      expect(key).toBeTruthy()
      expect(key).not.toMatch(/undefined/)
    })
    
    it(`${type}: scopeOids 非空且全為非空字串`, () => {
      const m = getModule(type)
      const oids = m.scopeOids(sample as any)
      expect(Array.isArray(oids)).toBe(true)
      expect(oids.length).toBeGreaterThan(0)
      oids.forEach(oid => {
        expect(typeof oid).toBe('string')
        expect(oid.length).toBeGreaterThan(0)
      })
    })
  }
})
