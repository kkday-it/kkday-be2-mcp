import { describe, it, expect } from 'vitest'
import { appGetChangesetViewTool, appGetConfirmLinkTool } from '../src/tools/appTools.js'

function ctx(over: Partial<any> = {}) {
  return {
    userLabel: 'alice', baseUrl: 'http://127.0.0.1:8787',
    changeSets: {
      get: (id: string) => id === 'cs1' ? { id: 'cs1', creatorLabel: 'alice', status: 'pending_approval', actionType: 'shelf_toggle_product', note: undefined, diff: [{ a: 1 }] } : undefined,
      getResults: () => [],
    },
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
it('confirm-link: creator 本人拿得到 url', async () => {
  const env = await appGetConfirmLinkTool.handler({ changeset_id: 'cs1' }, ctx())
  expect(env.items[0]).toMatchObject({ confirm_url: 'http://127.0.0.1:8787/confirm/cs1' })
})
it('confirm-link: 他人 → NOT_FOUND', async () => {
  const env = await appGetConfirmLinkTool.handler({ changeset_id: 'cs1' }, ctx({ userLabel: 'bob' }))
  expect(env.errors[0].code).toBe('NOT_FOUND')
})
