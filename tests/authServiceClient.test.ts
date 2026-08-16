import { describe, it, expect, vi } from 'vitest'
import { AuthServiceClient } from '../src/auth/authServiceClient.js'
import { AuthError } from '../src/errors.js'

function clientWith(response: { status: number; body: unknown }) {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch & { mock: { calls: any[][] } }
  const client = new AuthServiceClient({ baseUrl: 'https://auth.test', serviceKey: 'sk', fetchImpl })
  return { client, fetchImpl }
}

describe('AuthServiceClient', () => {
  it('login posts account/password and unwraps authorizationCode from metadata/data envelope (camelCase)', async () => {
    const { client, fetchImpl } = clientWith({ status: 200, body: { metadata: { status: 'SUCCESS' }, data: { authorizationCode: 'uuid-1' } } })
    const out = await client.login('u@kkday.com', 'pw')
    expect(out.authorizationCode).toBe('uuid-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://auth.test/api/v1/auth/be2/login')
    expect(init!.method).toBe('POST')
    expect(JSON.parse(init!.body as string)).toEqual({ account: 'u@kkday.com', password: 'pw' })
  })
  it('login tolerates snake_case authorization_code in data envelope', async () => {
    const { client } = clientWith({ status: 200, body: { data: { authorization_code: 'uuid-1' } } })
    const out = await client.login('u@kkday.com', 'pw')
    expect(out.authorizationCode).toBe('uuid-1')
  })
  it('exchangeCode GETs with service key header and returns tokens (metadata/data envelope)', async () => {
    const body = { metadata: { status: 'SUCCESS' }, data: { accessToken: 'fake-jwt', refreshToken: 'fake-r', businessList: [] } }
    const { client, fetchImpl } = clientWith({ status: 200, body })
    const out = await client.exchangeCode('uuid-1')
    expect(out.accessToken).toBe('fake-jwt')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://auth.test/api/v1/login-authorization-code/uuid-1')
    expect((init!.headers as Record<string, string>).authorization).toBe('sk')
  })
  it('exchangeCode tolerates snake_case token fields in data envelope', async () => {
    const body = { data: { access_token: 'fake-jwt', refresh_token: 'fake-r', business_list: [1] } }
    const { client } = clientWith({ status: 200, body })
    const out = await client.exchangeCode('uuid-1')
    expect(out).toEqual({ accessToken: 'fake-jwt', refreshToken: 'fake-r', businessList: [1] })
  })
  it('exchangeCode tolerates bare body (no data envelope)', async () => {
    const body = { accessToken: 'fake-jwt', refreshToken: 'fake-r', businessList: [] }
    const { client } = clientWith({ status: 200, body })
    const out = await client.exchangeCode('uuid-1')
    expect(out.accessToken).toBe('fake-jwt')
  })
  it('refresh PATCHes and returns rotated tokens', async () => {
    const body = { data: { accessToken: 'a2', refreshToken: 'r2', businessList: [1] } }
    const { client, fetchImpl } = clientWith({ status: 200, body })
    const out = await client.refresh('r1')
    expect(out).toEqual({ accessToken: 'a2', refreshToken: 'r2', businessList: [1] })
    expect(fetchImpl.mock.calls[0][1]!.method).toBe('PATCH')
  })
  it('maps non-2xx to AuthError using the VERIFIED metadata envelope (AU9010 at HTTP 422), no secrets in message', async () => {
    const { client } = clientWith({
      status: 422,
      body: { metadata: { status: 'AU9010', desc: 'Incorrect username or password. Please try again.', pagination: null, errors: null }, data: null },
    })
    await expect(client.login('u', 'pw')).rejects.toSatisfy((e: unknown) =>
      e instanceof AuthError && e.code === 'AU9010' && !String(e.message).includes('pw'))
  })
})
