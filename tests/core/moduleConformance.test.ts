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
  shelf_toggle_bundle: { prod_oid: '19513', bundle_pkg_oid: '57478', target_is_active: false },
}

const DIFF_SAMPLES: Record<string, any[]> = {
  shelf_toggle_product: [{ prod_oid: '546965', target_is_active: false, current_is_active: true, no_op: false }],
  shelf_toggle_plan: [{ prod_oid: '546965', pkg_oid: '888', target_is_active: false, current_is_active: true, no_op: false }],
  inventory_setting: [{ item_oid: '1713281', supplier_oid: '0', op: 'set', quantity: 5, dates: [{ date: '2027-01-01', current: 10, target: 5, no_op: false, would_go_negative: false }] }],
  inventory_platform: [{ item_oid: '1713281', supplier_oid: '0', current: 'BE2', target: 'BE2_SCM', noop: false, affected_pkgs: [{ prod_oid: '34133', pkg_oid: '1', pkg_name: 'x' }] }],
  shelf_schedule: [{ prod_oid: '34133', pkg_oid: '1', pkg_name: 'x', current_queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }], new_queue: [{ reserve_date_utc: '2027-01-02 00:00:00', reserve_status: false }], noop: false }],
  shelf_toggle_bundle: [{ prod_oid: '19513', bundle_pkg_oid: '57478', name: '展望台門票 + 大阪地鐵一日券', current_is_active: true, target_is_active: false, no_op: false }],
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
      // shelf-toggle 家族（product/plan/bundle）共用 {prod_oid, target_is_active} 基底形狀，
      // 彼此的寬鬆 schema 會互相接受——這是設計上的重疊（executor 由 rec.actionType 明確路由，
      // 非靠 isItem 分辨），互斥性測試對家族內豁免（原本 product↔plan，bundle 加入同家族）。
      const shelfFamily = new Set(['shelf_toggle_product', 'shelf_toggle_plan', 'shelf_toggle_bundle'])
      for (const [otherType, otherSample] of Object.entries(SAMPLES)) {
        if (type === otherType) continue
        if (shelfFamily.has(type) && shelfFamily.has(otherType)) continue
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

    it(`${type}: diffVersion 對相同輸入穩定`, () => {
      const m = getModule(type)
      const diffSample = DIFF_SAMPLES[type]
      expect(m.diffVersion(diffSample as any)).toBe(m.diffVersion(structuredClone(diffSample) as any))
    })

    it(`${type}: diffVersion 對 live 現況變動敏感（非恆定 hash）`, () => {
      const m = getModule(type)
      const diffSample = DIFF_SAMPLES[type]
      const mutated = structuredClone(diffSample) as any
      if (type === 'shelf_toggle_product' || type === 'shelf_toggle_plan' || type === 'shelf_toggle_bundle') {
        mutated[0].current_is_active = !mutated[0].current_is_active
      } else if (type === 'inventory_setting') {
        mutated[0].dates[0].current += 1
      } else if (type === 'inventory_platform') {
        mutated[0].current = mutated[0].current === 'BE2' ? 'EXTERNAL' : 'BE2'
      } else if (type === 'shelf_schedule') {
        mutated[0].current_queue = []
      }
      expect(m.diffVersion(mutated)).not.toBe(m.diffVersion(diffSample as any))
    })

    it(`${type}: itemKey(item) === itemKey(對應 diff item)`, () => {
      const m = getModule(type)
      const diffSample = DIFF_SAMPLES[type]
      expect(m.itemKey(sample as any)).toBe(m.itemKey(diffSample[0] as any))
    })
  }

  describe('inventory_setting 特殊語義 (op-aware)', () => {
    const adjustSample = [{ item_oid: '1713281', supplier_oid: '0', op: 'adjust', quantity: 5, dates: [{ date: '2027-01-01', current: 10, target: 15, no_op: false, would_go_negative: false }] }]
    it('adjust 樣本改 current → hash 不變', () => {
      const m = getModule('inventory_setting')
      const mutated = structuredClone(adjustSample)
      mutated[0].dates[0].current = 999
      expect(m.diffVersion(adjustSample as any)).toBe(m.diffVersion(mutated as any))
    })
    it('adjust 樣本改 quantity 或 dates → hash 必變', () => {
      const m = getModule('inventory_setting')
      const mutatedQ = structuredClone(adjustSample)
      mutatedQ[0].quantity = 6
      expect(m.diffVersion(adjustSample as any)).not.toBe(m.diffVersion(mutatedQ as any))
      
      const mutatedD = structuredClone(adjustSample)
      mutatedD[0].dates[0].date = '2027-01-02'
      expect(m.diffVersion(adjustSample as any)).not.toBe(m.diffVersion(mutatedD as any))
    })
  })
})
