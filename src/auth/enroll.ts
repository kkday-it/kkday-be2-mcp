import { randomBytes, randomUUID } from 'node:crypto'
import { IdentityStore } from '../store/identityStore.js'
import { CredentialStore } from '../store/credentialStore.js'
import type { AuthServiceClient } from './authServiceClient.js'
import { decodeJwtClaims, decodeJwtExpMs } from './jwt.js'

export function generateBearer(): string {
  return `be2mcp_${randomBytes(24).toString('hex')}`
}

type EnrollInput = { userLabel: string } & ({ account: string; password: string; otp?: string } | { code: string })

// Task 3：enroll 直接建 identity + credential（不再經 TokenStore 扁平相容層）。
// 一次 enroll = 一個新 identity（帶 be2 token）+ 一個 static_bearer credential 指向它，
// 對齊 identity/credential 拆分後的地基（IdentityStore/CredentialStore，Task 1）。
export async function enrollUser(
  deps: { identities: IdentityStore; credentials: CredentialStore; auth: AuthServiceClient },
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
  const identityId = randomUUID()
  await deps.identities.upsert({
    identityId,
    userLabel,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    businessList: tokens.businessList,
    accessExpiresAt: decodeJwtExpMs(tokens.accessToken),
    updatedAt: now(),
  })
  const bearer = generateBearer()
  await deps.credentials.insert({
    credHash: CredentialStore.hash(bearer),
    identityId,
    kind: 'static_bearer',
    expiresAt: null,
    updatedAt: now(),
  })
  return { bearer }
}
