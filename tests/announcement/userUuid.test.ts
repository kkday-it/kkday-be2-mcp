import { describe, it, expect } from 'vitest'
import { decodePlatformId } from '../../src/modules/announcement/create/userUuid.js'

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

describe('decodePlatformId', () => {
  it('extracts platformId claim', () => {
    expect(decodePlatformId(jwt({ platformId: 'f7965b8d-abc' }))).toBe('f7965b8d-abc')
  })
  it('throws when platformId missing', () => {
    expect(() => decodePlatformId(jwt({ sub: 'x' }))).toThrow(/platformId/)
  })
  it('throws on malformed token', () => {
    expect(() => decodePlatformId('not-a-jwt')).toThrow()
  })
})
