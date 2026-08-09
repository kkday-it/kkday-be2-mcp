import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { ChangeSetStore } from '../src/changeset/store.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { getChangesetStatusTool } from '../src/changeset/tools.js'
import type { L2ToolContext } from '../src/server/l2Context.js'

function ctxFor(store: ChangeSetStore, userLabel: string): L2ToolContext {
  return { gateway: {} as never, accessToken: 'x', userLabel, sessionId: 's', bearerHash: 'bh',
    businessList: [], readOids: {} as unknown as ReadOidStore, changeSets: store, rateBudget: {} as never,
    baseUrl: 'http://x', genId: () => 'id', genToken: () => 't', now: () => 1000, emitConfirmUrl: () => {} }
}
function seed(store: ChangeSetStore) {
  store.create({ id: 'cs1', creatorLabel: 'owner@kkday.com', creatorBearerHash: 'bh', sessionId: 's', actionType: 'shelf_toggle_product',
    items: [{ prod_oid: '1', target_is_active: false }], diff: [{ prod_oid: '1', target_is_active: false, no_op: false, current_is_active: true }],
    diffVersion: 'v1', status: 'done', approvalTokenHash: 'h', createdAt: 1000 })
  store.recordResults('cs1', [{ item_key: '1', status: 'done', before: { is_active: true }, after: { is_active: false }, trace_id: 'tr' }])
}
describe('be2_get_changeset_status', () => {
  it('creator sees status + results', async () => {
    const store = new ChangeSetStore(openDb(':memory:'), { now: () => 1000 }); seed(store)
    const env = await getChangesetStatusTool.handler({ changeset_id: 'cs1' }, ctxFor(store, 'owner@kkday.com'))
    const item = env.items[0] as Record<string, unknown>
    expect(item.status).toBe('done')
    expect((item.results as unknown[])).toHaveLength(1)
  })
  it('non-creator gets NOT_FOUND (no existence leak)', async () => {
    const store = new ChangeSetStore(openDb(':memory:'), { now: () => 1000 }); seed(store)
    const env = await getChangesetStatusTool.handler({ changeset_id: 'cs1' }, ctxFor(store, 'someone-else@kkday.com'))
    expect(env.items).toEqual([])
    expect(env.errors[0]?.code).toBe('NOT_FOUND')
  })
})
