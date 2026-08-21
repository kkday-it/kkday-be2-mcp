import { describe, it, expect, vi } from 'vitest'
import { createChangesetCore } from '../../src/core/changeset/tools.js'

// scope-gate：未讀過的 prod_oid 不得 stage。
function baseCtx(readHas: boolean): any {
  return {
    now: () => 0, sessionId: 's', userLabel: 'u', bearerHash: 'h', businessList: [{ code: 'product.announcement.update' }],
    readOids: { has: () => readHas }, rateBudget: { consumeChangeset: vi.fn() },
    gateway: { get: vi.fn().mockResolvedValue({ name: 'A' }) }, accessToken: 'tok',
    genId: () => 'cs1', changeSets: { create: vi.fn() }, emitConfirmUrl: vi.fn(), baseUrl: 'http://x',
  }
}
const item = {
  prod_oids: ['7781'], name: '公告', is_enabled: true, start_time: '2026-09-01 00:00:00',
  langs: ['zh-tw'], contents: [{ lang: 'zh-tw', content: 'hi' }],
}

describe('announcement scope-gate', () => {
  it('rejects staging when prod_oid was not read this session', async () => {
    const env = await createChangesetCore({ action_type: 'announcement', items: [item] }, baseCtx(false))
    expect(env.errors[0].code).toBe('SCOPE_NOT_READ')
  })
})
