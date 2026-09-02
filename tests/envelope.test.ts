import { describe, it, expect } from 'vitest'
import { makeEnvelope, toEnvelopeError, toEnvelopeErrorWithMidHint } from '../src/tools/envelope.js'

describe('makeEnvelope resolved_ids', () => {
  it('resolvedIds 非空時帶出 resolved_ids', () => {
    const env = makeEnvelope([], [], [], [{ mid: '10759', oid: '38352' }])
    expect(env.resolved_ids).toEqual([{ mid: '10759', oid: '38352' }])
  })
  it('未給或空陣列時不帶 resolved_ids 欄位(向後相容)', () => {
    expect('resolved_ids' in makeEnvelope([])).toBe(false)
    expect('resolved_ids' in makeEnvelope([], [], [], [])).toBe(false)
  })
})

describe('toEnvelopeErrorWithMidHint', () => {
  it('404 附加 mid 提示句', () => {
    const e = Object.assign(new Error('GET .../switch -> 404: not_found'), { status: 404 })
    const out = toEnvelopeErrorWithMidHint('546965', e)
    expect(out.status).toBe(404)
    expect(out.message).toContain('prod_mid')
    expect(out.message).toContain('not_found')
  })
  it('非 404 行為等同 toEnvelopeError', () => {
    const e = Object.assign(new Error('boom'), { status: 500, code: 'X' })
    expect(toEnvelopeErrorWithMidHint('k', e)).toEqual(toEnvelopeError('k', e))
  })
})
