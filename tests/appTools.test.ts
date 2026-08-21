import { describe, it, expect } from 'vitest'
import { appGetBatchViewTool } from '../src/tools/appTools.js'
import { z } from 'zod'

describe('appGetBatchViewTool zod', () => {
  it('接受 shelf_toggle_product', () => {
    const schema = z.object(appGetBatchViewTool.inputShape as never)
    expect(schema.safeParse({ action_type: 'shelf_toggle_product', prod_oids: ['1'] }).success).toBe(true)
  })
  it('接受 shelf_toggle_bundle', () => {
    const schema = z.object(appGetBatchViewTool.inputShape as never)
    expect(schema.safeParse({ action_type: 'shelf_toggle_bundle', prod_oids: ['1'] }).success).toBe(true)
  })
})
