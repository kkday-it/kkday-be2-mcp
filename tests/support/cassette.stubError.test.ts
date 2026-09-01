import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { makeCassetteFetch } from './cassette.js'

const C = 'tests/support/__fixtures__/stub-demo.json'
beforeAll(() => {
  mkdirSync('tests/support/__fixtures__', { recursive: true })
  writeFileSync(C, JSON.stringify({ interactions: [] }))
})

describe('stubError', () => {
  it('returns the injected error for a matching route (offline 403 branch)', async () => {
    const f = makeCassetteFetch('replay', C)
    f.stubError('PATCH', '/admin/product/announcement', 403, { metadata: { status: 'AU9997', desc: 'forbidden' } })
    const res = await f('https://h/admin/product/announcement/1', { method: 'PATCH', body: '{}' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ metadata: { status: 'AU9997', desc: 'forbidden' } })
  })
})
