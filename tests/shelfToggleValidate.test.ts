import { describe, it, expect } from 'vitest'
// 先載入 core diff（連帶跑完 modules/index.js 的 registerAllModules），避免直接 import leaf
// module.js 觸發 module↔core diff 的循環 import 初始化順序問題（同 changesetDiff.test.ts 慣例）。
import '../src/core/changeset/diff.js'
import { shelfToggleProductModule, shelfTogglePlanModule } from '../src/modules/product/shelfToggle/module.js'
import { shelfToggleBundleModule } from '../src/modules/product/shelfToggleBundle/module.js'

describe('shelf single-direction validate', () => {
  it('product: 混上下架 → mixed_direction', () => {
    const r = shelfToggleProductModule.validate(
      [{ prod_oid: '1', target_is_active: true }, { prod_oid: '2', target_is_active: false }] as never, 0)
    expect(r?.key).toBe('mixed_direction')
  })
  it('product: 同方向 → null', () => {
    expect(shelfToggleProductModule.validate(
      [{ prod_oid: '1', target_is_active: true }, { prod_oid: '2', target_is_active: true }] as never, 0)).toBeNull()
  })
  it('plan: 混上下架 → mixed_direction', () => {
    expect(shelfTogglePlanModule.validate(
      [{ prod_oid: '1', pkg_oid: 'a', target_is_active: true }, { prod_oid: '1', pkg_oid: 'b', target_is_active: false }] as never, 0)?.key)
      .toBe('mixed_direction')
  })
  it('bundle: 混上下架 → mixed_direction', () => {
    expect(shelfToggleBundleModule.validate(
      [{ prod_oid: '1', bundle_pkg_oid: 'a', target_is_active: true }, { prod_oid: '1', bundle_pkg_oid: 'b', target_is_active: false }] as never, 0)?.key)
      .toBe('mixed_direction')
  })
  it('空陣列 / 單筆 → null', () => {
    expect(shelfToggleProductModule.validate([] as never, 0)).toBeNull()
    expect(shelfToggleProductModule.validate([{ prod_oid: '1', target_is_active: false }] as never, 0)).toBeNull()
  })
})
