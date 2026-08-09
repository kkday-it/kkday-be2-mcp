import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { modifyUserFromPlaceholder } from '../src/server/app.js'
import { AppError } from '../src/errors.js'

function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

describe('modifyUserFromPlaceholder (Fix 4 guard)', () => {
  const ORIGINAL = process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER
  beforeEach(() => { delete process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER })
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER
    else process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER = ORIGINAL
  })

  it('throws AppError(MODIFY_USER_UNRESOLVED) by default — never silently resolves a wrong user', () => {
    const token = fakeJwt({ platformId: 'p-123' })
    expect(() => modifyUserFromPlaceholder(token)).toThrow(AppError)
    try {
      modifyUserFromPlaceholder(token)
      expect.unreachable()
    } catch (e) {
      expect((e as AppError).code).toBe('MODIFY_USER_UNRESOLVED')
    }
  })

  it('returns the placeholder platformId only when the dev escape hatch env flag is set to 1', () => {
    process.env.BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER = '1'
    const token = fakeJwt({ platformId: 'p-123' })
    expect(modifyUserFromPlaceholder(token)).toBe('p-123')
  })
})
