import { describe, it, expect, vi } from 'vitest'

// F3: appGetAnnouncementViewTool's client.listByProdOids call is only reachable when
// makeAnnouncementClient() actually returns a client (normally gated by API_ANNOUNCE_KEY in
// test/dev, which is absent here) — mock it so the request-uuid threading on this read path is
// exercised, rather than silently taking the "client unavailable" degrade branch.
const listByProdOids = vi.fn().mockResolvedValue([])
vi.mock('../../src/modules/announcement/create/svcB2cClient.js', () => ({
  makeAnnouncementClient: () => ({ listByProdOids }),
}))

const { appGetAnnouncementViewTool } = await import('../../src/tools/appTools.js')

function ctx(getImpl: (p: string) => Promise<unknown>, traceId?: string) {
  return {
    gateway: { get: vi.fn(getImpl) }, accessToken: 'tok', userLabel: 'u', sessionId: 's',
    rateBudget: { consume: vi.fn() }, traceId,
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

  it('passes ctx.traceId through to client.listByProdOids', async () => {
    listByProdOids.mockClear()
    await appGetAnnouncementViewTool.handler({ prod_oids: ['7781'] } as any, ctx(async () => ({ name: 'A' }), 'trace-view'))
    expect(listByProdOids.mock.calls[0][2]).toBe('trace-view')
  })
})
