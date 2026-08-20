import { describe, it, expect, vi } from 'vitest'
import { computeAnnouncementDiff } from '../../src/modules/announcement/create/diff.js'
import { executeAnnouncement } from '../../src/modules/announcement/create/executor.js'
import type { AnnouncementCreateItem, ChangeSetRecord } from '../../src/core/changeset/types.js'

// Regression for the final-review Critical: makeAnnouncementClient() throws when SIT_ANNOUNCE_API_KEY
// is absent (dev/test). That must NOT block staging (computeDiff) nor crash execution (executor) —
// it must degrade: existing_count = null for the diff, and per-item `failed` results for execution.

const item: AnnouncementCreateItem = {
  prod_oids: ['7781'], name: '公告', is_enabled: true,
  start_time: '2026-09-01 00:00:00', langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}

describe('announcement degrades when svc-b2c client unavailable (no api key)', () => {
  it('computeDiff with client=undefined does not throw; existing_count = null', async () => {
    const ctx = { gateway: { get: vi.fn().mockResolvedValue({ name: 'A' }) }, accessToken: 'tok', userLabel: 'u' } as any
    const [d] = await computeAnnouncementDiff([item], ctx, undefined)
    expect(d.existing_count).toBeNull()
    expect(d.product_names).toEqual(['A'])
    expect(d.noop).toBe(false)
  })

  it('executeAnnouncement returns per-item failed (not a thrown crash) when the client cannot be built', async () => {
    // Ensure the key is absent so makeAnnouncementClient() throws inside executeAnnouncement.
    const prev = process.env.SIT_ANNOUNCE_API_KEY
    delete process.env.SIT_ANNOUNCE_API_KEY
    try {
      const rec = { id: 'cs1', actionType: 'announcement', items: [item] } as unknown as ChangeSetRecord
      const ctx = { accessToken: 'tok', modifyUser: 'uuid-1', span: async (_n: string, fn: (t: string) => Promise<unknown>) => fn('t') } as any
      const results = await executeAnnouncement(ctx, rec)
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('failed')
      expect(results[0].item_key.startsWith('announce:')).toBe(true)
    } finally {
      if (prev !== undefined) process.env.SIT_ANNOUNCE_API_KEY = prev
    }
  })
})
