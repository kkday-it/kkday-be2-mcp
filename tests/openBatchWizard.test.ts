import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { openBatchWizardTool } from '../src/tools/openBatchWizard.js'

describe('be2_open_batch_wizard', () => {
  it('是面板工具（uiResourceUri 指向 batch-wizard 面板，同 findProducts.ts 的慣例）', () => {
    expect(openBatchWizardTool.uiResourceUri).toBe('ui://be2/batch-wizard.html')
  })

  it('prod_oids 進 structuredContent（供面板預填），連同 action_type', async () => {
    const env = await openBatchWizardTool.handler({ action_type: 'inventory_platform', prod_oids: ['34133'] } as never, {} as never)
    expect(env.items).toEqual([{ action_type: 'inventory_platform', prod_oids: ['34133'] }])
  })

  it('沒給 prod_oids（optional）也能開面板', async () => {
    const env = await openBatchWizardTool.handler({ action_type: 'shelf_schedule' } as never, {} as never)
    expect(env.items).toEqual([{ action_type: 'shelf_schedule', prod_oids: [] }])
  })

  it('input schema 只收三個合法 batch action_type（inventory_platform/shelf_schedule/inventory_setting），拒絕其他值', () => {
    const schema = z.object(openBatchWizardTool.inputShape)
    expect(schema.safeParse({ action_type: 'inventory_platform' }).success).toBe(true)
    expect(schema.safeParse({ action_type: 'shelf_schedule', prod_oids: ['1', '2'] }).success).toBe(true)
    expect(schema.safeParse({ action_type: 'inventory_setting' }).success).toBe(true)
    expect(schema.safeParse({ action_type: 'shelf_toggle_product' }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('input schema 拒絕超過 10 個 prod_oids', () => {
    const schema = z.object(openBatchWizardTool.inputShape)
    const ok = schema.safeParse({ action_type: 'inventory_platform', prod_oids: Array.from({ length: 10 }, (_, i) => String(i)) })
    expect(ok.success).toBe(true)
    const tooMany = schema.safeParse({ action_type: 'inventory_platform', prod_oids: Array.from({ length: 11 }, (_, i) => String(i)) })
    expect(tooMany.success).toBe(false)
  })
})
