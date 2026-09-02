// tests/support/cassette.normalize.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeUrl, normalizeBody, matchKey } from './cassette.js'

describe('normalizeUrl', () => {
  it('sorts query params so order does not matter', () => {
    expect(normalizeUrl('https://h/p?b=2&a=1')).toBe(normalizeUrl('https://h/p?a=1&b=2'))
  })
  it('keeps path and host', () => {
    expect(normalizeUrl('https://h/admin/product/announcement/3084')).toContain('/admin/product/announcement/3084')
  })
})

describe('normalizeBody', () => {
  it('strips volatile fields (modify_user) symmetrically', () => {
    expect(normalizeBody({ name: 'x', modify_user: 'uuid-a' }))
      .toEqual(normalizeBody({ name: 'x', modify_user: 'uuid-b' }))
  })
  it('sorts keys so key order does not matter', () => {
    expect(normalizeBody({ b: 1, a: 2 })).toEqual(normalizeBody({ a: 2, b: 1 }))
  })
  it('recurses into nested objects and arrays', () => {
    expect(normalizeBody({ langSettings: [{ content: 'x', langCode: 'zh-tw', modify_user: 'u' }] }))
      .toEqual(normalizeBody({ langSettings: [{ langCode: 'zh-tw', content: 'x' }] }))
  })
})

describe('matchKey', () => {
  it('is identical for full body (with modify_user) vs cassette body (without)', () => {
    const live = matchKey('PATCH', 'https://h/a?x=1', { name: 'n', modify_user: 'u1' })
    const recorded = matchKey('PATCH', 'https://h/a?x=1', { name: 'n' })
    expect(live).toBe(recorded)
  })
  it('differs when method or path differs', () => {
    expect(matchKey('PATCH', 'https://h/a', {})).not.toBe(matchKey('POST', 'https://h/a', {}))
  })
})
