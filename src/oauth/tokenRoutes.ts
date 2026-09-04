import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import type { OAuthStore } from './oauthStore.js'
import { CredentialStore } from '../store/credentialStore.js'
import type { IdentityStore } from '../store/identityStore.js'
import type { AuditLog } from '../audit/auditLog.js'
import { randomTraceId } from '../otel.js'

// Task 10：OAuth 2.1 外殼的認證核心——`POST /oauth/token`。這是整條 be2-mcp 認證鏈裡，
// 「auth bypass」影響面最大的一支端點：PKCE 驗證錯了 = 任何人都能用攔截到的 authz code 換
// token；code/refresh 沒做到一次性 = code 能重放；refresh rotation 沒有 reuse-detection
// family revoke = 竊得一顆已被合法使用者續期掉的舊 refresh 仍能長期冒用身分（OAuth 2.1 /
// RFC 9700 明文要求的攻擊模型）。三件事都在這支檔案做完，不假手他處。
//
// PKCE 只驗 S256：Task 9 的 authorize 在鑄 code 當下就只接受 code_challenge_method=S256（見
// authorizeRoutes.ts validateParams），且沒有把 method 存進 oauth_auth_codes（表裡只有
// code_challenge 本身）——這裡沒有「查表決定要用哪種方法驗」的資料可查，直接硬編 S256
// 是唯一與 authorize 端行為一致的做法，不是偷懶。

export interface TokenDeps {
  oauthStore: OAuthStore
  credentials: CredentialStore
  identities: IdentityStore
  audit: AuditLog
  now: () => number
  genToken?: () => string
  accessTtlSeconds?: number
  refreshTtlMs?: number
}

// access credential 本身沒有 DB 層的到期時間（expiresAt: null，與既有 static_bearer/
// web_session 慣例一致——見 authorizeRoutes.ts/ssoRoutes.ts）：它的失效完全靠「這一列
// credentials 還在不在」決定（rotation 精準刪一列、family revoke 整批刪）。expires_in 只是
// 回給 OAuth client 的建議值，讓 client 端知道何時該主動打 refresh_token grant 續期。
const DEFAULT_ACCESS_TTL_SECONDS = 3600
// refresh 需要一個真正的到期時間（存進 oauth_refresh.exp），因為 reuse-detection 依賴
// 「這顆 refresh 是否還在合法視窗內」——給 30 天，對齊 pilot 使用場景（人不會 30 天不用一次
// be2-mcp）。
const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function buildTokenRouter(deps: TokenDeps): express.Router {
  const r = express.Router()
  // 真實 OAuth client（含 Claude）慣例用 application/x-www-form-urlencoded 打 token
  // endpoint；app.ts 已全域掛 express.json()，這裡再疊一層 urlencoded，兩種 content-type
  // 都能解析（json 中介層對非 json content-type 會直接 next()，兩者不衝突）。
  r.use(express.urlencoded({ extended: false }))

  const genToken = deps.genToken ?? (() => randomBytes(32).toString('hex'))
  const accessTtlSeconds = deps.accessTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS
  const refreshTtlMs = deps.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  function invalidGrant(res: express.Response): void {
    res.status(400).json({ error: 'invalid_grant' })
  }

  // reuse-detection family revoke（RFC 9700 fail-closed）：偵測到一顆 refresh 被重複使用時，撤銷
  // 整個 token family——不只這顆。兩條路徑會走到這裡：(a) getRefresh 讀到 consumed===1（先前已被
  // rotate 掉的舊 refresh 又被拿來用）；(b) 條件式 markRefreshConsumed 輸掉 race（讀到 consumed=0
  // 但翻轉時已被並發請求搶先消費）。兩者語義相同（合法 client 每顆 refresh 只會用一次），故共用
  // 這一份，避免複製兩份 revoke 邏輯而漂移。audit 失敗不擋 revoke 本身（invalidGrant 照回）。
  async function revokeRefreshFamily(identityId: string, refreshHash: string): Promise<void> {
    await deps.oauthStore.deleteRefreshByIdentity(identityId)
    await deps.credentials.deleteByIdentityAndKind(identityId, 'oauth_access')
    // spec §3.3：reuse-detection family revoke = token 遭竊訊號，SIEM 價值最高的一筆 security 事件。
    try {
      await deps.audit.record({
        userLabel: (await deps.identities.get(identityId))?.userLabel ?? 'unknown',
        sessionId: '-', clientInfo: 'oauth-token', tool: 'oauth_refresh_reuse',
        params: { identity_id: identityId, refresh_hash_prefix: refreshHash.slice(0, 8) },
        status: 'error', errorMessage: 'refresh reuse detected — whole family revoked (RFC 9700 fail-closed)',
        eventType: 'security.token_revoked', severity: 'CRITICAL',
        traceId: randomTraceId(), durationMs: 0,
      })
    } catch (err) { console.error('refresh-reuse audit failed:', err) }
  }

  // 鑄一組新的 access+refresh，兩者互相綁定（refresh 記著這批一起發出的 access 是哪一列），
  // 供之後 rotation 精準刪除用。回傳的明文只活在這次 response 裡，store 永遠只落雜湊。
  async function issueTokenPair(identityId: string, clientId: string): Promise<{ access_token: string; refresh_token: string }> {
    const now = deps.now()
    const rawAccess = genToken()
    const rawRefresh = genToken()
    const accessCredHash = CredentialStore.hash(rawAccess)
    await deps.credentials.insert({ credHash: accessCredHash, identityId, kind: 'oauth_access', expiresAt: null, updatedAt: now })
    await deps.oauthStore.insertRefresh({
      refreshHash: CredentialStore.hash(rawRefresh), identityId, clientId,
      exp: now + refreshTtlMs, consumed: 0, accessCredHash,
    })
    return { access_token: rawAccess, refresh_token: rawRefresh }
  }

  r.post('/oauth/token', (req, res) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const grantType = str(body.grant_type)

      if (grantType === 'authorization_code') {
        const code = str(body.code)
        const verifier = str(body.code_verifier)
        const clientId = str(body.client_id)
        const redirectUri = str(body.redirect_uri)
        if (!code || !verifier || !clientId || !redirectUri) { invalidGrant(res); return }

        const row = await deps.oauthStore.getAuthCode(CredentialStore.hash(code))
        if (!row || row.consumed === 1 || row.exp < deps.now() || row.clientId !== clientId || row.redirectUri !== redirectUri) {
          invalidGrant(res)
          return
        }
        // PKCE S256：base64url(sha256(code_verifier)) 必須等於 authorize 那步存下的 code_challenge。
        const expectedChallenge = createHash('sha256').update(verifier).digest('base64url')
        if (expectedChallenge !== row.codeChallenge) { invalidGrant(res); return }

        // Defense in depth：code 綁的 identity 理論上應該一路存在，但既然 IdentityStore 就在手邊
        // （且 app.ts 的 purgeCredential 在某些收尾路徑真的會刪掉 identity），多查一次不昂貴，
        // 換到「絕不會對著一個已經不存在的身分發 token」的保證。
        if (!(await deps.identities.get(row.identityId))) { invalidGrant(res); return }

        // 一次性：驗證全部通過才 consume（驗證失敗絕不消費這支 code——見上面獨立的 PKCE-only
        // 測試，錯 verifier 不該燒掉一支原本合法的 code）。consume 本身是條件式 CAS：輸掉 race
        // （另一個並發請求已先消費同一支 code）代表這支 code 不再屬於我方，回 invalidGrant，語義
        // 同上面 row.consumed===1 的路徑，不額外做 revoke。
        if (!(await deps.oauthStore.consumeAuthCode(row.codeHash))) { invalidGrant(res); return }

        const tokens = await issueTokenPair(row.identityId, row.clientId)
        res.status(200).json({ ...tokens, token_type: 'Bearer', expires_in: accessTtlSeconds })
        return
      }

      if (grantType === 'refresh_token') {
        const rawRefresh = str(body.refresh_token)
        const clientId = str(body.client_id)
        if (!rawRefresh) { invalidGrant(res); return }

        const refreshHash = CredentialStore.hash(rawRefresh)
        const row = await deps.oauthStore.getRefresh(refreshHash)
        if (!row) { invalidGrant(res); return }

        if (row.consumed === 1) {
          // Reuse of a refresh that was already rotated away = signal the token was exfiltrated
          // (a legitimate client only ever presents each refresh once, right before it gets
          // replaced). OAuth 2.1 / RFC 9700 要求 fail closed on the WHOLE family, not just this
          // token — the attacker may already hold the current rotated pair too.
          await revokeRefreshFamily(row.identityId, refreshHash)
          invalidGrant(res)
          return
        }
        if (row.exp < deps.now()) { invalidGrant(res); return }
        if (clientId && row.clientId !== clientId) { invalidGrant(res); return }
        if (!(await deps.identities.get(row.identityId))) { invalidGrant(res); return }

        // Rotate：舊 refresh 標 consumed（不刪——reuse-detection 需要它還在，才能認出「這顆曾經
        // 合法過」），刪掉這顆 refresh 綁定的那一列舊 access credential（精準、只刪這一列，不動
        // 同 identity 底下的其他 credential），再鑄一組新的。markRefreshConsumed 是條件式 CAS：
        // 上面 getRefresh 讀到 consumed=0 到這裡之間，可能有並發請求搶先消費了同一顆 refresh——
        // 輸掉這個 race（回 false）與 consumed===1 是同一個訊號（同一顆 refresh 被雙用），故走
        // 相同的 family revoke，reuse-detection 才不會在真正的並發雙用下漏接。
        if (!(await deps.oauthStore.markRefreshConsumed(row.refreshHash))) {
          await revokeRefreshFamily(row.identityId, refreshHash)
          invalidGrant(res)
          return
        }
        if (row.accessCredHash) await deps.credentials.delete(row.accessCredHash)

        const tokens = await issueTokenPair(row.identityId, row.clientId)
        res.status(200).json({ ...tokens, token_type: 'Bearer', expires_in: accessTtlSeconds })
        return
      }

      res.status(400).json({ error: 'invalid_request' })
    })().catch(() => { if (!res.headersSent) res.status(500).json({ error: 'server_error' }) })
  })

  return r
}
