import express from 'express'
import { parseCookies } from './cookies.js'
import type { WebSessionStore } from './webSessionStore.js'
import type { CredentialStore } from '../store/credentialStore.js'
import type { TokenManager } from '../auth/tokenManager.js'

// confirmRoutes 與 ssoRoutes 共用的 web-session 登入 gate(kind gate + 死 session 清理 + touch),自 confirmRoutes 抽出,行為不變
export interface SessionGateDeps { webSessions: WebSessionStore; credentials: CredentialStore; tokenManager: TokenManager }
export interface SessionUser { sessionId: string; userLabel: string; accessToken: string; identityId: string }

export async function requireSession(deps: SessionGateDeps, req: express.Request): Promise<SessionUser | undefined> {
  const sid = parseCookies(req.header('cookie'))['be2mcp_sid']
  if (!sid) return undefined
  const sess = await deps.webSessions.get(sid)   // undefined if idle-expired (row deleted)
  if (!sess) return undefined
  // Task 4 kind gate: the be2mcp_sid cookie must resolve to a credential MINTED BY the
  // confirm-page SSO login (kind === 'web_session'). An agent holding its own oauth_access or
  // static_bearer credential and sending that secret AS this cookie must be rejected here —
  // structurally, not just because the secret happens to be "unknown" (it is a perfectly known,
  // valid credential — just of the wrong kind for this surface). This is what makes
  // self-approval impossible even if the agent knows the change-set id (鐵則 #4).
  const cred = await deps.credentials.getBySecret(sid)
  if (!cred || cred.kind !== 'web_session') return undefined
  let user
  try {
    user = await deps.tokenManager.getFreshByCredHash(cred.credHash)
  } catch {
    // be2 refresh token expired/revoked (AuthError REAUTH_REQUIRED) or upstream unavailable:
    // the web session is dead. Delete it and treat as no-session so the caller redirects to
    // login — otherwise every /confirm request 500s in a loop until the idle TTL. (agy round-1)
    await deps.webSessions.delete(sid)
    return undefined
  }
  await deps.webSessions.touch(sid)
  // Security fix (final whole-branch review finding, credential-at-rest leak): never hand back
  // the raw cookie secret `sid` as the audited sessionId. `sid` IS the web_session credential's
  // secret — audit_log is append-only (no-delete trigger), so a raw sid landing in a row would
  // be an unredactable, still-valid approval credential for anyone who can read the SQLite
  // file/export. `cred.credHash` (already computed above as sha256(sid), and already the value
  // persisted in the `credentials` table) is a stable non-secret per-session correlator: same
  // discriminating power for audit purposes, but its preimage (the cookie itself) cannot be
  // recovered from it. `who.sessionId` has no consumer besides audit labeling (grep-verified:
  // confirmService.ts, executor.ts, confirmRoutes.ts's own reject handler) so this swap is safe.
  return { sessionId: cred.credHash, userLabel: user.userLabel, accessToken: user.accessToken, identityId: cred.identityId }
}
