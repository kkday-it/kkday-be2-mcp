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
  it('emits Secure only when explicitly requested (kept OFF on loopback per design)', () => {
    const secure = serializeSetCookie('be2mcp_sid', 'abc', { secure: true })
    expect(secure).toContain('Secure')
    const insecure = serializeSetCookie('be2mcp_sid', 'abc', {})
    expect(insecure).not.toContain('Secure')
    const defaulted = serializeSetCookie('be2mcp_sid', 'abc')
    expect(defaulted).not.toContain('Secure')
  })
  it('does not throw on a malformed percent-encoded cookie value, and still returns the others', () => {
    expect(() => parseCookies('a=1; bad=%; b=2')).not.toThrow()
    const parsed = parseCookies('a=1; bad=%; b=2')
    expect(parsed.a).toBe('1')
    expect(parsed.b).toBe('2')
    expect(parsed.bad).toBe('%') // falls back to raw value instead of throwing
  })
})
