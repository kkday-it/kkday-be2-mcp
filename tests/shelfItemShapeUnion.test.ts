import { describe, it, expect } from 'vitest'
// 先載入 core diff（連帶 registerAllModules），避免直接 import leaf module 的循環 import 初始化問題。
import '../src/core/changeset/diff.js'
import { z } from 'zod'
import { createChangesetInputShape } from '../src/core/changeset/tools.js'

// 回歸：itemShape 是 z.union(所有 module.itemSchema,依註冊序)。product schema({prod_oid,target_is_active})
// 是 plan/bundle item 的純子集且排在前面;若 product 非 .strict(),zod union 會讓 plan/bundle item 命中
// product 並剝除 pkg_oid/bundle_pkg_oid → 過 plan/bundle isItem 就 INVALID_ITEMS,上下架方案/組合方案
// 建立變更全掛（live 揪出）。product schema 加 .strict() 修掉。
describe('createChangeset itemShape union — 不得剝除 plan/bundle 的 key', () => {
  const schema = z.object(createChangesetInputShape as never)
  it('shelf_toggle_plan item 保留 pkg_oid（不被 product schema 剝掉）', () => {
    const r = schema.safeParse({ action_type: 'shelf_toggle_plan', items: [{ prod_oid: '34133', pkg_oid: '1936562', target_is_active: true }] })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.items as Array<Record<string, unknown>>)[0]).toEqual({ prod_oid: '34133', pkg_oid: '1936562', target_is_active: true })
  })
  it('shelf_toggle_bundle item 保留 bundle_pkg_oid', () => {
    const r = schema.safeParse({ action_type: 'shelf_toggle_bundle', items: [{ prod_oid: '34133', bundle_pkg_oid: '57478', target_is_active: false }] })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.items as Array<Record<string, unknown>>)[0]).toEqual({ prod_oid: '34133', bundle_pkg_oid: '57478', target_is_active: false })
  })
  it('shelf_toggle_product item 照舊只有兩欄', () => {
    const r = schema.safeParse({ action_type: 'shelf_toggle_product', items: [{ prod_oid: '34133', target_is_active: true }] })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.items as Array<Record<string, unknown>>)[0]).toEqual({ prod_oid: '34133', target_is_active: true })
  })
})
