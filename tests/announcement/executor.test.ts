import { describe, it, expect, vi } from 'vitest'
import { executeAnnouncementWith } from '../../src/modules/announcement/create/executor.js'
import type { ChangeSetRecord } from '../../src/core/changeset/types.js'
import { GatewayError } from '../../src/errors.js'

const item = {
  prod_oids: ['7781', '16384'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: null as string | null,
  langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}
const rec = { id: 'cs1', actionType: 'announcement', items: [item] } as unknown as ChangeSetRecord

function ctx(): any {
  return {
    accessToken: 'tok', modifyUser: 'uuid-1', userLabel: 'u', sessionId: 's',
    span: async (_n: string, fn: (t: string) => Promise<unknown>) => fn('trace-1'), now: () => 0,
  }
}

describe('executeAnnouncement', () => {
  it('POSTs wire body (prodOids number[], modify_user=platformId) and reports done', async () => {
    const client = { create: vi.fn().mockResolvedValue({ productAnnouncementOid: 42 }) } as any
    const results = await executeAnnouncementWith(client, ctx(), rec)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('done')
    expect(results[0].item_key).toBe('announce:公告:16384,7781:2026-09-01 00:00:00')
    const body = client.create.mock.calls[0][1]
    expect(body.prodOids).toEqual([7781, 16384])
    expect(body.isEnabled).toBe(true)
    expect(body.modify_user).toBe('uuid-1')
    expect(body.contents).toEqual([{ lang: 'zh-tw', content: 'hi' }])
  })
  it('reports failed with be2 code on 403 (does not throw)', async () => {
    const client = { create: vi.fn().mockRejectedValue(new GatewayError('403', 'forbidden', 403)) } as any
    const results = await executeAnnouncementWith(client, ctx(), rec)
    expect(results[0].status).toBe('failed')
    expect(results[0].error_code).toBe('403')
  })

  // F3: request-uuid 貫穿 — client.create 收到的 traceId 必須與該筆 ItemResult.trace_id 同值
  // （span callback 給的值，見 core/changeset/executor.ts:53-56 註解），三方 join 才不斷鏈。
  it('passes the span traceId to client.create, matching ItemResult.trace_id', async () => {
    const client = { create: vi.fn().mockResolvedValue({ productAnnouncementOid: 42 }) } as any
    const results = await executeAnnouncementWith(client, ctx(), rec)
    expect(client.create.mock.calls[0][2]).toBe('trace-1')
    expect(results[0].trace_id).toBe('trace-1')
  })
})
