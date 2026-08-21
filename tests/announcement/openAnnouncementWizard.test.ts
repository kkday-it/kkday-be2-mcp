import { describe, it, expect } from 'vitest'
import { openAnnouncementWizardTool as t } from '../../src/tools/openAnnouncementWizard.js'

describe('be2_open_announcement_wizard', () => {
  it('is a model-visible entry bound to the announcement panel', () => {
    expect(t.name).toBe('be2_open_announcement_wizard')
    expect(t.uiResourceUri).toBe('ui://be2/announcement-wizard.html')
  })
  it('echoes prod_oids prefill (no scope authority)', async () => {
    const env = await t.handler({ prod_oids: ['7781'] } as any, {} as any)
    expect((env.items[0] as any).prod_oids).toEqual(['7781'])
  })
  it('defaults prod_oids to []', async () => {
    const env = await t.handler({} as any, {} as any)
    expect((env.items[0] as any).prod_oids).toEqual([])
  })
})
