import { describe, it, expect } from 'vitest'
import { decodeJwtClaims } from '../src/auth/jwt.js'

function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

describe('decodeJwtClaims', () => {
  it('returns the payload claims (incl. authKey email)', () => {
    const c = decodeJwtClaims(fakeJwt({ authKey: 'user@kkday.com', subAuthOid: 42, exp: 123 }))
    expect(c.authKey).toBe('user@kkday.com')
    expect(c.subAuthOid).toBe(42)
  })
  it('throws on a non-JWT', () => {
    expect(() => decodeJwtClaims('nope')).toThrow()
  })
})
