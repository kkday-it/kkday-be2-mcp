import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { makeCassetteFetch } from './cassette.js'

const CASSETTE = 'tests/support/__fixtures__/replay-demo.json'

beforeAll(() => {
  mkdirSync('tests/support/__fixtures__', { recursive: true })
  writeFileSync(CASSETTE, JSON.stringify({ interactions: [
    { method: 'PATCH', url: 'https://h/admin/product/announcement/3084',
      reqBody: { name: 'n' }, status: 200, resBody: { metadata: { status: '0000' } } },
  ] }))
})

describe('replay mode', () => {
  it('returns the recorded response when the request matches (incl volatile modify_user)', async () => {
    const f = makeCassetteFetch('replay', CASSETTE)
    const res = await f('https://h/admin/product/announcement/3084', {
      method: 'PATCH', body: JSON.stringify({ name: 'n', modify_user: 'uuid-x' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ metadata: { status: '0000' } })
  })
  it('throws loudly on an unmatched request (never falls back to live)', async () => {
    const f = makeCassetteFetch('replay', CASSETTE)
    await expect(f('https://h/admin/product/announcement/9999', { method: 'PATCH', body: '{}' }))
      .rejects.toThrow(/no cassette match/i)
  })
  it('replays multiple identical requests in recorded order (stateful GET before/after)', async () => {
    const path = 'tests/support/__fixtures__/seq-demo.json'
    writeFileSync(path, JSON.stringify({ interactions: [
      { method: 'GET', url: 'https://h/state', reqBody: undefined, status: 200, resBody: { v: 'before' } },
      { method: 'GET', url: 'https://h/state', reqBody: undefined, status: 200, resBody: { v: 'after' } },
    ] }))
    const f = makeCassetteFetch('replay', path)
    expect(await (await f('https://h/state', { method: 'GET' })).json()).toEqual({ v: 'before' })
    expect(await (await f('https://h/state', { method: 'GET' })).json()).toEqual({ v: 'after' })
  })
  it('replays a single recorded response repeatably (idempotent poll — sticky)', async () => {
    const f = makeCassetteFetch('replay', CASSETTE)
    const once = await (await f('https://h/admin/product/announcement/3084', { method: 'PATCH', body: JSON.stringify({ name: 'n' }) })).json()
    const twice = await (await f('https://h/admin/product/announcement/3084', { method: 'PATCH', body: JSON.stringify({ name: 'n' }) })).json()
    expect(once).toEqual(twice)
  })
})
