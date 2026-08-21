import { describe, it, expect } from 'vitest'
import { openWorkbenchTool } from '../src/tools/openWorkbench.js'

describe('openWorkbenchTool', () => {
  it('綁 workbench 面板、名稱正確', () => {
    expect(openWorkbenchTool.name).toBe('be2_open_workbench')
    expect(openWorkbenchTool.uiResourceUri).toBe('ui://be2/workbench.html')
  })
  it('handler 回 prefill envelope', async () => {
    const env = await openWorkbenchTool.handler({ feature: 'shelf', prod_oids: ['546965'] } as never, {} as never)
    expect(JSON.stringify(env)).toContain('546965')
  })
})
