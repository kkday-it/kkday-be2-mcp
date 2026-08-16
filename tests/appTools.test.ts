import { describe, it, expect } from 'vitest'
import { appGetChangesetViewTool, appGetConfirmLinkTool } from '../src/tools/appTools.js'
import { ApprovalNonceStore } from '../src/core/changeset/approvalNonce.js'

function ctx(over: Partial<any> = {}) {
  return {
    userLabel: 'alice', baseUrl: 'http://127.0.0.1:8787', sessionId: 's1',
    changeSets: {
      get: (id: string) => {
        if (id === 'cs1') return { id: 'cs1', creatorLabel: 'alice', status: 'pending_approval', actionType: 'shelf_toggle_product', note: undefined, diff: [{ a: 1 }], diffVersion: 'v1' }
        if (id === 'cs2') return { id: 'cs2', creatorLabel: 'alice', status: 'approved', actionType: 'shelf_toggle_product', note: undefined, diff: [{ a: 1 }], diffVersion: 'v2' }
        return undefined
      },
      getResults: () => [],
    },
    nonces: new ApprovalNonceStore(),
    ...over,
  } as any
}

it('view: creator 本人拿得到 diff', async () => {
  const env = await appGetChangesetViewTool.handler({ changeset_id: 'cs1' }, ctx())
  expect(env.items[0]).toMatchObject({ changeset_id: 'cs1', status: 'pending_approval' })
})
it('view: 他人 → NOT_FOUND（無 existence leak）', async () => {
  const env = await appGetChangesetViewTool.handler({ changeset_id: 'cs1' }, ctx({ userLabel: 'bob' }))
  expect(env.errors[0].code).toBe('NOT_FOUND')
})
it('view: pending_approval 附上 diff_version 與 nonce（面板批准用）', async () => {
  const env = await appGetChangesetViewTool.handler({ changeset_id: 'cs1' }, ctx())
  const item = env.items[0] as Record<string, unknown>
  expect(item.diff_version).toBe('v1')
  expect(typeof item.nonce).toBe('string')
  expect((item.nonce as string).length).toBeGreaterThan(0)
})
it('view: 非 pending_approval 不附 nonce / diff_version', async () => {
  const env = await appGetChangesetViewTool.handler({ changeset_id: 'cs2' }, ctx())
  const item = env.items[0] as Record<string, unknown>
  expect(item.nonce).toBeUndefined()
  expect(item.diff_version).toBeUndefined()
})
it('confirm-link: creator 本人拿得到 url', async () => {
  const env = await appGetConfirmLinkTool.handler({ changeset_id: 'cs1' }, ctx())
  expect(env.items[0]).toMatchObject({ confirm_url: 'http://127.0.0.1:8787/confirm/cs1' })
})
it('confirm-link: 他人 → NOT_FOUND', async () => {
  const env = await appGetConfirmLinkTool.handler({ changeset_id: 'cs1' }, ctx({ userLabel: 'bob' }))
  expect(env.errors[0].code).toBe('NOT_FOUND')
})
