import { randomBytes } from 'node:crypto'
import { TokenStore } from '../store/tokenStore.js'
import type { AuthServiceClient } from './authServiceClient.js'
import { decodeJwtExpMs } from './jwt.js'

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
  const bearer = generateBearer()
  deps.store.upsert({
    bearerHash: TokenStore.hashBearer(bearer),
    userLabel: input.userLabel,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    businessList: tokens.businessList,
    accessExpiresAt: decodeJwtExpMs(tokens.accessToken),
    updatedAt: now(),
  })
  return { bearer }
}
