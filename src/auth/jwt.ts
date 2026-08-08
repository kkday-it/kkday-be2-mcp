// Payload decode ONLY — never signature verification (spec §3: verification is
// delegated to auth-service). exp is used solely to schedule L2 refresh.
export function decodeJwtExpMs(jwt: string): number {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('not a JWT')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  if (typeof payload.exp !== 'number') throw new Error('JWT has no exp claim')
  return payload.exp * 1000
}
