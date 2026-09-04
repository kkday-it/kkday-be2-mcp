import express from 'express'
import type { OAuthStore } from './oauthStore.js'
import { CredentialStore } from '../store/credentialStore.js'
import type { IdentityStore } from '../store/identityStore.js'
import type { AuditLog } from '../audit/auditLog.js'
import { revokeGrant } from './revocation.js'

// RFC 7009 token revocation(spec §4)。公開端點:public client 以「持有 token」為授權,
// 回應絕不洩漏 token 是否存在(查無/歸屬不符一律 200 空 body)。撤銷語義 = grant 級
// (revokeGrant),與 tokenRoutes 的 refresh-reuse family revoke 同形狀。
export interface RevokeDeps { oauthStore: OAuthStore; credentials: CredentialStore; identities: IdentityStore; audit: AuditLog }

export function buildRevokeRouter(deps: RevokeDeps): express.Router {
  const r = express.Router()
  r.use(express.urlencoded({ extended: false }))
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  r.post('/oauth/revoke', (req, res) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const token = str(body.token)
      if (!token) { res.status(400).json({ error: 'invalid_request' }); return }
      const hint = str(body.token_type_hint)
      const clientId = str(body.client_id)
      const hash = CredentialStore.hash(token)

      // hint 只是查找順序;一種查無必須擴大到另一種(RFC 7009 §2.1)。
      let identityId: string | undefined
      let kind: 'refresh_token' | 'access_token' | undefined
      let boundClientId: string | undefined
      const tryRefresh = async (): Promise<boolean> => {
        const row = await deps.oauthStore.getRefresh(hash)   // consumed / 過期列照樣命中:撤銷冪等無害
        if (!row) return false
        identityId = row.identityId; kind = 'refresh_token'; boundClientId = row.clientId
        return true
      }
      const tryAccess = async (): Promise<boolean> => {
        const cred = await deps.credentials.get(hash)
        if (!cred || cred.kind !== 'oauth_access') return false   // static_bearer/web_session 一律視為 unknown
        identityId = cred.identityId; kind = 'access_token'
        // family 已亡(如 oauth-purge 刪了過期 refresh)→ 反查不到 clientId → 跳過歸屬檢查,
        // possession 足矣(spec §4.3,agy round-2 conceded 的真實生產路徑)。
        boundClientId = (await deps.oauthStore.getRefreshByAccessCredHash(cred.credHash))?.clientId
        return true
      }
      const found = hint === 'access_token' ? ((await tryAccess()) || (await tryRefresh())) : ((await tryRefresh()) || (await tryAccess()))

      if (!found) { res.status(200).end(); return }                                     // 不當存在性 oracle
      if (clientId && boundClientId && boundClientId !== clientId) { res.status(200).end(); return }  // 歸屬不符=視為 unknown

      const revoked = await revokeGrant(deps, identityId!)
      // spec §3.2(98 行):audit 失敗不擋業務——revoke 已完成,throw 會被外層 .catch 轉 500,
      // 但撤銷其實成功了(誤導呼叫端重試)。
      try {
        await deps.audit.record({
          userLabel: revoked?.userLabel ?? 'unknown', sessionId: '-', clientInfo: 'oauth-revoke',
          tool: 'oauth_revoke', params: { kind, client_id: clientId || undefined, cred_hash_prefix: hash.slice(0, 8) },
          status: 'ok',
          eventType: 'security.token_revoked', severity: 'CRITICAL',
          traceId: '-', durationMs: 0,
        })
      } catch (err) { console.error('oauth-revoke audit failed:', err) }
      res.status(200).end()
    })().catch(() => { if (!res.headersSent) res.status(500).json({ error: 'server_error' }) })
  })
  return r
}
