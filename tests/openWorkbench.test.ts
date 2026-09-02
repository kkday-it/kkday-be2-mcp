import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { openWorkbenchTool } from '../src/tools/openWorkbench.js'

describe('be2_open_workbench', () => {
  it('綁 workbench 面板、名稱正確', () => {
    expect(openWorkbenchTool.name).toBe('be2_open_workbench')
    expect(openWorkbenchTool.uiResourceUri).toBe('ui://be2/workbench.html')
  })
  it('handler 回 prefill envelope', async () => {
    const env = await openWorkbenchTool.handler({ feature: 'shelf', prod_oids: ['546965'] } as never, {} as never)
    expect(JSON.stringify(env)).toContain('546965')
  })
  it('給 prod_mids → 解析成 canonical oid prefill、resolved_ids 帶出', async () => {
    const gw = { get: async (p: string) => p.includes('mid-10759') ? { prod_oid: '38352' } : {} }
    const env = await openWorkbenchTool.handler(
      { feature: 'inventory', prod_mids: ['10759'] } as never, { gateway: gw, accessToken: 't' } as never)
    expect(env.items).toEqual([{ feature: 'inventory', prod_oids: ['38352'] }])
    expect(env.resolved_ids).toEqual([{ mid: '10759', oid: '38352' }])
  })

  it('兩者皆空 → 仍開空白面板(不呼叫 resolver、無 error)', async () => {
    const env = await openWorkbenchTool.handler({} as never, {} as never)
    expect(env.items).toEqual([{ feature: null, prod_oids: [] }])
    expect(env.errors).toEqual([])
  })

  it('input schema 接受 prod_mids', () => {
    const schema = z.object(openWorkbenchTool.inputShape)
    expect(schema.safeParse({ feature: 'inventory', prod_mids: ['10759'] }).success).toBe(true)
  })
})
