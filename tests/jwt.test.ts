import { describe, it, expect } from 'vitest'
import { decodeJwtExpMs } from '../src/auth/jwt.js'

function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

describe('decodeJwtExpMs', () => {
  it('returns exp in ms', () => {
    expect(decodeJwtExpMs(fakeJwt({ exp: 1754700000 }))).toBe(1754700000_000)
  })
  it('throws on garbage', () => {
    expect(() => decodeJwtExpMs('not-a-jwt')).toThrow()
  })
})
