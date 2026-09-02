import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { makeCassetteFetch } from '../../support/cassette.js'
import { AnnouncementClient } from '../../../src/modules/announcement/create/svcB2cClient.js'
import { executeAnnouncementUpdateWith, toFullDoc } from '../../../src/modules/announcement/update/executor.js'
import type { AnnouncementUpdateItem, ChangeSetRecord } from '../../../src/core/changeset/types.js'

// The seed cassette (tests/cassettes/announcement-update.json) has a GET on oid 2404 and a PATCH
// on oid 3084 (DIFFERENT oids), so it can't drive a same-oid getDetail->patch flow. Build a small
// purpose cassette here instead, reusing the real captured shapes from the seed (langs array
// shape, prodOids-as-string, envelope) but on the SAME oid (5001) so a real read-merge-write
// round trip can be exercised offline.
const CASSETTE_DIR = 'tests/announcement/update/__fixtures__'
const CASSETTE_PATH = `${CASSETTE_DIR}/announcement-update-executor.json`
const BASE_URL = 'https://api-gateway.stage.kkday.com/svc-b2c/api/v1'
const OID = 5001

const item: AnnouncementUpdateItem = {
  announcementOid: OID, prod_oids: ['765928'], name: '[CLAUDE-TEST] 更新後標題', is_enabled: true,
  start_time: '2026-09-01 00:00:00', end_time: null, langs: ['zh-tw'],
  contents: [{ lang: 'zh-tw', content: '[CLAUDE-TEST] 更新後內文' }],
}
// The exact wire body our executor will PATCH — built via the real toFullDoc(), so the cassette's
// stored reqBody is guaranteed byte-for-byte identical to what the code under test produces
// (no hand-duplicated logic to drift out of sync).
const expectedPatchBody = toFullDoc(item, undefined)

// No-op item (9b review): target is byte-for-byte equivalent to what getDetail returns for this
// oid — same name/is_enabled/prod_oids/start_time/end_time/contents. A DIFFERENT oid (5002) than
// the happy-path item's, deliberately with NO PATCH interaction recorded for it in the cassette
// below — if the executor regresses to always-PATCH, the PATCH call would throw "no cassette
// match" (proving a write was attempted); the fix must instead short-circuit to skipped_noop
// before ever calling client.patch.
const NOOP_OID = 5002
const noopItem: AnnouncementUpdateItem = {
  announcementOid: NOOP_OID, prod_oids: ['765928'], name: '[CLAUDE-TEST] 相同標題', is_enabled: true,
  start_time: '2026-08-28 00:00:00', end_time: null, langs: ['zh-tw'],
  contents: [{ lang: 'zh-tw', content: '[CLAUDE-TEST] 相同內文' }],
}

beforeAll(() => {
  mkdirSync(CASSETTE_DIR, { recursive: true })
  writeFileSync(CASSETTE_PATH, JSON.stringify({
    interactions: [
      {
        method: 'GET',
        url: `${BASE_URL}/admin/product/announcement/${OID}`,
        reqBody: null,
        status: 200,
        resBody: {
          metadata: { status: '0000', desc: 'Success' },
          data: {
            productAnnouncementOid: OID,
            name: '[CLAUDE-TEST] 舊標題',
            prodOids: '[765928]', // §6.3: GET 回字串，非陣列
            isEnabled: true,
            startTime: '2026-08-28 00:00:00',
            endTime: null,
            createUser: '李佳樺(chiahua.lee)',
            createDate: '2025-08-08 08:20:16',
            modifyUser: '李佳樺(chiahua.lee)',
            modifyDate: '2026-08-29 15:37:12',
            langs: [
              { langCode: 'zh-tw', content: '[CLAUDE-TEST] 舊內文' },
              { langCode: 'en-default', content: '[CLAUDE-TEST] old en content' },
            ],
          },
        },
      },
      {
        method: 'PATCH',
        url: `${BASE_URL}/admin/product/announcement/${OID}`,
        reqBody: expectedPatchBody,
        status: 200,
        resBody: { metadata: { status: '0000', desc: 'Success' }, data: null },
      },
      {
        // GET for the no-op oid — deliberately NO matching PATCH interaction below.
        method: 'GET',
        url: `${BASE_URL}/admin/product/announcement/${NOOP_OID}`,
        reqBody: null,
        status: 200,
        resBody: {
          metadata: { status: '0000', desc: 'Success' },
          data: {
            productAnnouncementOid: NOOP_OID,
            name: '[CLAUDE-TEST] 相同標題',
            prodOids: '[765928]',
            isEnabled: true,
            startTime: '2026-08-28 00:00:00',
            endTime: null,
            createUser: '李佳樺(chiahua.lee)',
            createDate: '2025-08-08 08:20:16',
            modifyUser: '李佳樺(chiahua.lee)',
            modifyDate: '2026-08-29 15:37:12',
            langs: [
              { langCode: 'zh-tw', content: '[CLAUDE-TEST] 相同內文' },
            ],
          },
        },
      },
    ],
  }, null, 2))
})

// AnnouncementClient derives the user-uuid header from the access token's JWT `platformId` claim
// (decodePlatformId, ../../../src/modules/announcement/create/userUuid.ts) — a plain 'tok' string
// would throw MODIFY_USER_UNRESOLVED before any HTTP call is made, so this must look like a JWT.
function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

function ctx(): any {
  return {
    accessToken: fakeJwt({ platformId: 'uuid-1' }), modifyUser: 'uuid-1', userLabel: 'u', sessionId: 's',
    span: async (_n: string, fn: (t: string) => Promise<unknown>) => fn('trace-1'), now: () => 0,
  }
}

describe('executeAnnouncementUpdate via cassette (offline, real client, same-oid read-merge-write)', () => {
  it('reads current then PATCHes the merged full document and reports done', async () => {
    const fetchImpl = makeCassetteFetch('replay', CASSETTE_PATH)
    const client = new AnnouncementClient({ baseUrl: BASE_URL, apiKey: 'test-key', fetchImpl })
    const rec = { id: 'cs1', actionType: 'announcement_update', items: [item] } as unknown as ChangeSetRecord

    const results = await executeAnnouncementUpdateWith(client, ctx(), rec)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('done')  // metadata.status '0000' on both legs
    expect(results[0].item_key).toBe('announce_update:5001:[CLAUDE-TEST] 更新後標題:765928:2026-09-01 00:00:00')

    // (a) read current happened — asserted via the recorded 'before'
    expect((results[0].before as any)?.name).toBe('[CLAUDE-TEST] 舊標題')

    // (b) PATCHed the merged full document — langSettings full array, prodOids int[], endTime null
    const after = results[0].after as Record<string, unknown>
    expect(after.prodOids).toEqual([765928])
    expect(after.endTime).toBeNull()
    expect(after.langSettings).toEqual([{ langCode: 'zh-tw', content: '[CLAUDE-TEST] 更新後內文' }])
    expect(after.name).toBe('[CLAUDE-TEST] 更新後標題')
    expect(after.isEnabled).toBe(true)
  })

  it('reports failed with the be2 error code on a 403 PATCH (does not throw)', async () => {
    const fetchImpl = makeCassetteFetch('replay', CASSETTE_PATH)
    fetchImpl.stubError('PATCH', '/admin/product/announcement', 403, { metadata: { status: 'AU9997', desc: 'forbidden' } })
    const client = new AnnouncementClient({ baseUrl: BASE_URL, apiKey: 'test-key', fetchImpl })
    const rec = { id: 'cs1', actionType: 'announcement_update', items: [item] } as unknown as ChangeSetRecord

    const results = await executeAnnouncementUpdateWith(client, ctx(), rec)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('failed')
    expect(results[0].error_code).toBe('AU9997')
  })

  it('skips the PATCH and reports skipped_noop when target equals current (9b review)', async () => {
    const fetchImpl = makeCassetteFetch('replay', CASSETTE_PATH)
    const client = new AnnouncementClient({ baseUrl: BASE_URL, apiKey: 'test-key', fetchImpl })
    const rec = { id: 'cs1', actionType: 'announcement_update', items: [noopItem] } as unknown as ChangeSetRecord

    const results = await executeAnnouncementUpdateWith(client, ctx(), rec)

    expect(results).toHaveLength(1)
    // If the executor regressed to always-PATCH, it would hit the unrecorded PATCH interaction
    // for NOOP_OID, get "no cassette match", and the catch block would report 'failed' —
    // asserting 'skipped_noop' specifically proves no write was attempted.
    expect(results[0].status).toBe('skipped_noop')
    expect((results[0].before as any)?.name).toBe('[CLAUDE-TEST] 相同標題')
  })
})
