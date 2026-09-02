import { describe, it, expect } from 'vitest'
import { makeCassetteFetch } from '../support/cassette.js'
import { AnnouncementClient } from '../../src/modules/announcement/create/svcB2cClient.js'
import { GatewayError } from '../../src/errors.js'

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}
const TOKEN = jwt({ platformId: 'uuid-1' })

const CASSETTE = 'tests/cassettes/announcement-update.json'

// PATCH reqBody 需與 cassette 錄製的完全一致（經 normalizeBody 排除 VOLATILE_KEYS）才能 replay 命中。
const PATCH_BODY = {
  name: '[CLAUDE-TEST] 自動化契約探測 可刪',
  isEnabled: true,
  prodOids: [765928],
  startTime: '2026-09-01 00:00:00',
  endTime: null,
  langSettings: [
    { langCode: 'zh-tw', content: '[CLAUDE-TEST] 自動化契約探測，可刪。EDIT2' },
  ],
}

describe('AnnouncementClient.getDetail / patch (cassette-backed, offline)', () => {
  it('getDetail: GET /admin/product/announcement/{oid}, unwraps data (langs present)', async () => {
    const fetchImpl = makeCassetteFetch('replay', CASSETTE)
    const c = new AnnouncementClient({
      baseUrl: 'https://api-gateway.stage.kkday.com/svc-b2c/api/v1', apiKey: 'test-key', fetchImpl,
    })
    const data = await c.getDetail(TOKEN, 2404) as { productAnnouncementOid: number; langs: unknown[] }
    expect(data.productAnnouncementOid).toBe(2404)
    expect(Array.isArray(data.langs)).toBe(true)
    expect(data.langs.length).toBeGreaterThan(0)
  })

  it('patch: PATCH /admin/product/announcement/{oid} with full doc body, resolves on envelope 0000', async () => {
    const fetchImpl = makeCassetteFetch('replay', CASSETTE)
    const c = new AnnouncementClient({
      baseUrl: 'https://api-gateway.stage.kkday.com/svc-b2c/api/v1', apiKey: 'test-key', fetchImpl,
    })
    await expect(c.patch(TOKEN, 3084, PATCH_BODY)).resolves.toBeUndefined()
  })

  it('patch: surfaces stubbed 403/AU9997 as GatewayError', async () => {
    const fetchImpl = makeCassetteFetch('replay', CASSETTE)
    fetchImpl.stubError('PATCH', '/admin/product/announcement', 403, { metadata: { status: 'AU9997', desc: 'forbidden' } })
    const c = new AnnouncementClient({
      baseUrl: 'https://api-gateway.stage.kkday.com/svc-b2c/api/v1', apiKey: 'test-key', fetchImpl,
    })
    await expect(c.patch(TOKEN, 3084, PATCH_BODY)).rejects.toBeInstanceOf(GatewayError)
    await expect(c.patch(TOKEN, 3084, PATCH_BODY)).rejects.toMatchObject({ code: 'AU9997' })
  })
})
