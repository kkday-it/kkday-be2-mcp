import { describe, it, expect } from 'vitest'
import { inventorySettingWizard } from '../src/modules/product/inventorySetting/ui.js'

const row = (over: any) => ({ checked: true, is_bundle: false, prod_oid: 'p', pkg_oid: 'k', pkg_name: 'N', item_oid: '1650033', supplier_oid: '181', queue: [], cleared: false, ...over })

describe('inventorySettingWizard.buildItems', () => {
  it('emits {item_oid, supplier_oid, quantity} for checked rows with a numeric quantity', () => {
    const items = inventorySettingWizard.buildItems([row({ quantity: 50 })], {}) as any[]
    expect(items).toEqual([{ item_oid: '1650033', supplier_oid: '181', quantity: 50 }])
  })
  it('skips unchecked rows and rows without a quantity', () => {
    expect(inventorySettingWizard.buildItems([row({ checked: false, quantity: 50 })], {})).toEqual([])
    expect(inventorySettingWizard.buildItems([row({ quantity: undefined })], {})).toEqual([])
  })
  it('skips rows missing item_oid/supplier_oid', () => {
    expect(inventorySettingWizard.buildItems([row({ item_oid: undefined, quantity: 5 })], {})).toEqual([])
  })
  it('itemKey matches server keys.ts', () => {
    expect(inventorySettingWizard.itemKey({ item_oid: '1650033', supplier_oid: '181' })).toBe('1650033:181')
  })
})
