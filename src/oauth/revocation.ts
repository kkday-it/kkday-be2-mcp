import type { OAuthStore } from './oauthStore.js'
import type { CredentialStore } from '../store/credentialStore.js'
import type { IdentityStore } from '../store/identityStore.js'

export interface RevocationDeps { oauthStore: OAuthStore; credentials: CredentialStore; identities: IdentityStore }

// grant 級撤銷(spec §4.4):一條 OAuth 連線 = 一個 identity,kind-scoped 刪光它的 OAuth 面向
// 憑證即等於 RFC 7009「same authorization grant」語義。web_session / static_bearer 刻意不碰
// (與 tokenRoutes 的 refresh-reuse family revoke 同形狀);identity 列存真實 be2 token,
// 沒有任何 credential 引用時一併清掉(否則成 oauth-purge 要掃的 ghost)。
export async function revokeGrant(deps: RevocationDeps, identityId: string): Promise<{ userLabel: string } | undefined> {
  const identity = await deps.identities.get(identityId)
  await deps.oauthStore.deleteRefreshByIdentity(identityId)
  await deps.credentials.deleteByIdentityAndKind(identityId, 'oauth_access')
  if (identity && (await deps.credentials.countByIdentity(identityId)) === 0) await deps.identities.delete(identityId)
  return identity ? { userLabel: identity.userLabel } : undefined
}
