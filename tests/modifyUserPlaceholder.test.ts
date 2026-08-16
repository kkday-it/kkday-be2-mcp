import { describe, it, expect } from 'vitest'
import { modifyUserFromToken } from '../src/server/app.js'
import { AppError } from '../src/errors.js'

function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

describe('modifyUserFromToken', () => {
  it('resolves platformId from token by default', () => {
    const token = fakeJwt({ platformId: 'p-123' })
    expect(modifyUserFromToken(token)).toBe('p-123')
  })

  it('throws AppError(MODIFY_USER_UNRESOLVED) if the token has no platformId claim', () => {
    const token = fakeJwt({ someOtherClaim: 'p-123' })
    expect(() => modifyUserFromToken(token)).toThrow(AppError)
    try {
      modifyUserFromToken(token)
      expect.unreachable()
    } catch (e) {
      expect((e as AppError).code).toBe('MODIFY_USER_UNRESOLVED')
    }
  })

  it('throws AppError(MODIFY_USER_UNRESOLVED) if the token is invalid', () => {
    expect(() => modifyUserFromToken('invalid-token')).toThrow(AppError)
  })
})
