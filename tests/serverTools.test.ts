import { describe, it, expect } from 'vitest'
import { TOOLS } from '../src/server/app.js'

describe('model-visible TOOLS', () => {
  it('含 workbench、不含舊 wizard 入口', () => {
    const names = TOOLS.map(t => t.name)
    expect(names).toContain('be2_open_workbench')
    expect(names).not.toContain('be2_open_batch_wizard')
    expect(names).not.toContain('be2_open_announcement_wizard')
  })
})
