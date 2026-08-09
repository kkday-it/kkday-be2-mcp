import { describe, it, expect, vi } from 'vitest'
import { GatewayClient } from '../src/gateway/client.js'
import { GatewayError } from '../src/errors.js'

function make(status: number, body: unknown) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  return { client: new GatewayClient({ baseUrl: 'https://gw.test', fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl }
}

describe('GatewayClient', () => {
  it('GETs with bearer + x-auth-id headers and unwraps data envelope', async () => {
    const { client, fetchImpl } = make(200, { data: { hello: 1 } })
    const out = await client.get('/product/api/v1/drafts/products/p1/info', 'fake-jwt', { lang: 'zh-tw' })
    expect(out).toEqual({ hello: 1 })
    const call = (fetchImpl.mock.calls[0] as unknown) as [string | Request, RequestInit | undefined]
    expect(String(call[0])).toBe('https://gw.test/product/api/v1/drafts/products/p1/info?lang=zh-tw')
    const h = call[1]!.headers as Record<string, string>
    expect(h.authorization).toBe('Bearer fake-jwt')
    expect(h['x-auth-id']).toBe('be2')
  })
  it('returns bare body when no data envelope', async () => {
    const { client } = make(200, { is_active: true })
    expect(await client.get('/p', 't')).toEqual({ is_active: true })
  })
  it('maps 403 to GatewayError with status + code, message contains path', async () => {
    const { client } = make(403, { error: { code: 'FORBIDDEN', message: 'no permission' } })
    await expect(client.get('/x', 't')).rejects.toSatisfy((e: unknown) =>
      e instanceof GatewayError && e.status === 403 && e.code === 'FORBIDDEN' && e.message.includes('/x'))
  })
  it('never includes the access token in thrown errors', async () => {
    const { client } = make(500, {})
    await expect(client.get('/x', 'secret-jwt')).rejects.toSatisfy(
      (e: unknown) => !(String((e as Error).message).includes('secret-jwt')))
  })
})
