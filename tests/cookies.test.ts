import { describe, it, expect } from 'vitest'
import { parseCookies, serializeSetCookie } from '../src/server/cookies.js'

describe('cookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; be2mcp_sid=abc; b=2')).toEqual({ a: '1', be2mcp_sid: 'abc', b: '2' })
    expect(parseCookies(undefined)).toEqual({})
  })
  it('serializes an HttpOnly cookie', () => {
    const c = serializeSetCookie('be2mcp_sid', 'abc', { httpOnly: true, sameSite: 'Lax', path: '/confirm' })
    expect(c).toContain('be2mcp_sid=abc')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Path=/confirm')
  })
})
