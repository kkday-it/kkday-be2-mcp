import { describe, it, expect, vi } from 'vitest'
import { AnnouncementClient } from '../../src/modules/announcement/create/svcB2cClient.js'
import { GatewayError } from '../../src/errors.js'

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}
const TOKEN = jwt({ platformId: 'uuid-1' })

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('AnnouncementClient', () => {
  it('create: sends x-api-key + user-uuid(=platformId) + bearer, POST body; unwraps data on 0000', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { metadata: { status: '0000', desc: 'Success' }, data: { productAnnouncementOid: 99 } }))
    const c = new AnnouncementClient({ baseUrl: 'https://gw/svc-b2c/api/v1', apiKey: 'K', fetchImpl })
    const out = await c.create(TOKEN, { name: 'x' })
    expect(out).toEqual({ productAnnouncementOid: 99 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://gw/svc-b2c/api/v1/admin/product/announcement')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('K')
    expect(init.headers['user-uuid']).toBe('uuid-1')
    expect(init.headers.authorization).toBe('Bearer ' + TOKEN)
    expect(JSON.parse(init.body as string)).toEqual({ name: 'x' })
  })

  it('create: HTTP 200 but metadata.status != 0000 -> throws GatewayError with be2 code/desc', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { metadata: { status: '9999', desc: '失敗' } }))
    const c = new AnnouncementClient({ baseUrl: 'https://gw/svc-b2c/api/v1', apiKey: 'K', fetchImpl })
    await expect(c.create(TOKEN, {})).rejects.toMatchObject({ code: '9999' })
  })

  it('create: HTTP 403 -> throws GatewayError (status carried)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(403, { metadata: { status: '403', desc: 'forbidden' } }))
    const c = new AnnouncementClient({ baseUrl: 'https://gw/svc-b2c/api/v1', apiKey: 'K', fetchImpl })
    await expect(c.create(TOKEN, {})).rejects.toBeInstanceOf(GatewayError)
  })

  it('listByProdOids: GET with prodOids query, user-uuid header, returns data array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { metadata: { status: '0000' }, data: [{ productAnnouncementOid: 1 }] }))
    const c = new AnnouncementClient({ baseUrl: 'https://gw/svc-b2c/api/v1', apiKey: 'K', fetchImpl })
    const rows = await c.listByProdOids(TOKEN, ['7781', '16384'])
    expect(rows).toEqual([{ productAnnouncementOid: 1 }])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/admin/product/announcement?')
    expect(url).toContain('prodOids=7781%2C16384')
    expect(init.headers['user-uuid']).toBe('uuid-1')
  })
})
