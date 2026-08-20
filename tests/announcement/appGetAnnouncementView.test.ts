import { describe, it, expect, vi } from 'vitest'
import { appGetAnnouncementViewTool } from '../../src/tools/appTools.js'

function ctx(getImpl: (p: string) => Promise<unknown>) {
  return {
    gateway: { get: vi.fn(getImpl) }, accessToken: 'tok', userLabel: 'u', sessionId: 's',
    rateBudget: { consume: vi.fn() },
  } as any
}

describe('app_get_announcement_view', () => {
  it('returns product names + read_oids for scope-gate', async () => {
    const env = await appGetAnnouncementViewTool.handler({ prod_oids: ['7781'] } as any, ctx(async () => ({ name: 'A' })))
    expect(env.read_oids).toContain('7781')
    const first = (env.items[0] as any).products[0]
    expect(first.prod_oid).toBe('7781')
    expect(first.name).toBe('A')
    expect(env.errors.length).toBe(0)
  })
})
