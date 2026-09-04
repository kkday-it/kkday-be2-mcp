import type { CredentialStore } from '../store/credentialStore.js'
import type { OAuthStore } from '../oauth/oauthStore.js'
import type { IdentityStore } from '../store/identityStore.js'
import type { AuditLog } from '../audit/auditLog.js'
import crypto from 'node:crypto'

export const randomTraceId = (): string => crypto.randomUUID().replace(/-/g, '')

// G2（spec §3.3）：identity 的 be2 refresh 死亡（撤權/鎖定/到期）＝重大安全事件。
// 撤銷動作沿用 app.ts 原 callback 內容；audit 只記 identityId + userLabel，
// per-credential 歸因結構上不可能（per-identity single-flight，全家憑證一起失效）。
export function buildOnReauthRequired(deps: {
  credentials: CredentialStore; oauthStore: OAuthStore; identities: IdentityStore; audit: AuditLog
}): (identityId: string) => Promise<void> {
  return async (identityId) => {
    const userLabel = (await deps.identities.get(identityId))?.userLabel ?? 'unknown'
    await deps.credentials.deleteByIdentity(identityId)
    await deps.oauthStore.deleteRefreshByIdentity(identityId)
    try {
      await deps.audit.record({
        userLabel, sessionId: '-', clientInfo: 'token-manager', tool: 'auth.reauth_required',
        params: { identity_id: identityId }, status: 'error',
        errorMessage: 'be2 refresh dead — all credentials of this identity revoked (fail-closed)',
        eventType: 'security.reauth_required', severity: 'WARN',
        traceId: randomTraceId(), durationMs: 0,
      })
    } catch (err) { console.error('reauth audit failed:', err) }   // audit 失敗不擋撤銷
  }
}
