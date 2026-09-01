// tests/support/cassette.record.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeCassetteFetch } from './cassette.js'

const OUT = 'tests/support/__fixtures__/recorded.json'

describe('record mode', () => {
  it('captures interactions via the injected real fetch and saves them', async () => {
    const realFetch = (async () => new Response(JSON.stringify({ metadata: { status: '0000' } }), { status: 200 })) as typeof fetch
    const f = makeCassetteFetch('record', OUT)
    ;(f as unknown as { _realFetch: typeof fetch })._realFetch = realFetch
    await f('https://h/admin/product/announcement', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    f.save()
    const saved = JSON.parse(readFileSync(OUT, 'utf8'))
    expect(saved.interactions).toHaveLength(1)
    expect(saved.interactions[0].method).toBe('POST')
    expect(saved.interactions[0].status).toBe(200)
  })

  it('records a non-JSON (plain text) response body without throwing', async () => {
    const NON_JSON_OUT = 'tests/support/__fixtures__/recorded-non-json.json'
    const realFetch = (async () => new Response('not json at all', { status: 500 })) as typeof fetch
    const f = makeCassetteFetch('record', NON_JSON_OUT)
    ;(f as unknown as { _realFetch: typeof fetch })._realFetch = realFetch
    await expect(f('https://h/x', { method: 'GET' })).resolves.toBeInstanceOf(Response)
    f.save()
    const saved = JSON.parse(readFileSync(NON_JSON_OUT, 'utf8'))
    expect(saved.interactions).toHaveLength(1)
    expect(saved.interactions[0].resBody).toBe('not json at all')
    expect(saved.interactions[0].status).toBe(500)
  })

  it('refuses to write a body containing a JWT', async () => {
    const realFetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
    const f = makeCassetteFetch('record', OUT)
    ;(f as unknown as { _realFetch: typeof fetch })._realFetch = realFetch
    await f('https://h/x', { method: 'POST', body: JSON.stringify({ t: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' }) })
    expect(() => f.save()).toThrow(/JWT/i)
  })
})
