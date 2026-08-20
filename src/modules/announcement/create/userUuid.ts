import { AppError } from '../../../errors.js'

// user-uuid header = JWT platformId claim（§3 契約）。語義同 src/server/app.ts#modifyUserFromToken，
// 但獨立於 module 內、不跨 server→module import。fail-closed：解不出 platformId 一律 throw。
export function decodePlatformId(accessToken: string): string {
  const parts = accessToken.split('.')
  if (parts.length !== 3) {
    throw new AppError('MODIFY_USER_UNRESOLVED', 'access token is not a JWT', 500)
  }
  let payload: { platformId?: string }
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new AppError('MODIFY_USER_UNRESOLVED', 'access token payload not decodable', 500)
  }
  if (!payload.platformId) {
    throw new AppError('MODIFY_USER_UNRESOLVED', 'access token missing platformId claim', 500)
  }
  return payload.platformId
}
