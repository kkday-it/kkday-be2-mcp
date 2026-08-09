import { randomBytes } from 'node:crypto'
import { TokenStore } from '../store/tokenStore.js'
import type { AuthServiceClient } from './authServiceClient.js'
import { decodeJwtClaims, decodeJwtExpMs } from './jwt.js'

export function generateBearer(): string {
  return `be2mcp_${randomBytes(24).toString('hex')}`
}

type EnrollInput = { userLabel: string } & ({ account: string; password: string; otp?: string } | { code: string })

export async function enrollUser(
  deps: { store: TokenStore; auth: AuthServiceClient },
  input: EnrollInput,
  now: () => number = Date.now,
): Promise<{ bearer: string }> {
  const code = 'code' in input
    ? input.code
    : (await deps.auth.login(input.account, input.password, { otp: input.otp })).authorizationCode
  const tokens = await deps.auth.exchangeCode(code)
  // Identity anchor (Phase 2b fix): derive the stored userLabel from the access token's own
  // `authKey` claim rather than the caller-supplied label. This is the SAME derivation the
  // confirm-page SSO session uses (src/server/ssoRoutes.ts) — sharing one source of truth means
  // a bearer's creatorLabel and a confirm-session's userLabel can never silently diverge (which
  // would otherwise 404 the change-set's own creator on their own approval page). Fall back to
  // the passed-in label only if the token somehow has no authKey claim.
  const claims = decodeJwtClaims(tokens.accessToken)
  const authKey = typeof claims.authKey === 'string' && claims.authKey ? claims.authKey : undefined
  const userLabel = authKey ?? input.userLabel
  const bearer = generateBearer()
  deps.store.upsert({
    bearerHash: TokenStore.hashBearer(bearer),
    userLabel,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    businessList: tokens.businessList,
    accessExpiresAt: decodeJwtExpMs(tokens.accessToken),
    updatedAt: now(),
  })
  return { bearer }
}
