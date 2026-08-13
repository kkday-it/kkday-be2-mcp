import express from 'express'
import { randomUUID } from 'node:crypto'
import type { AuthServiceClient } from '../auth/authServiceClient.js'
import type { IdentityStore } from '../store/identityStore.js'
import { CredentialStore } from '../store/credentialStore.js'
import { WebSessionStore } from './webSessionStore.js'
import { decodeJwtClaims, decodeJwtExpMs } from '../auth/jwt.js'
import { parseCookies, serializeSetCookie } from './cookies.js'

export interface SsoDeps {
  authServiceClient: AuthServiceClient; identities: IdentityStore; credentials: CredentialStore; webSessions: WebSessionStore
  authOrigin: string; now: () => number
}

// Task 4: shared "exchangeCode -> minted identity" step, factored out of the POPUP /confirm/session
// handler below so a future Phase B OAuth `authorize` redirect flow (which will also need to turn
// a be2-auth authorizationCode into a be2 identity, just for a different credential kind) can
// reuse it instead of re-deriving the authKey-from-JWT logic a second time.
export async function exchangeCodeToIdentity(
  authServiceClient: AuthServiceClient, identities: IdentityStore, code: string, now: number,
): Promise<{ identityId: string; userLabel: string; accessToken: string } | undefined> {
  const tokens = await authServiceClient.exchangeCode(code)
  const userLabel = String(decodeJwtClaims(tokens.accessToken).authKey ?? '')
  if (!userLabel) return undefined
  const identityId = randomUUID()
  identities.upsert({
    identityId, userLabel,
    accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, businessList: tokens.businessList,
    accessExpiresAt: decodeJwtExpMs(tokens.accessToken), updatedAt: now,
  })
  return { identityId, userLabel, accessToken: tokens.accessToken }
}

export function buildSsoRouter(deps: SsoDeps): express.Router {
  const r = express.Router()
  const h = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response) => { void fn(req, res).catch(() => { if (!res.headersSent) res.status(500).send('internal error') }) }

  // Safe to interpolate into an inline <script>: JSON.stringify alone does NOT escape
  // `</script>`, so a value like `</script><script>...` can break out of the script block.
  // Unicode-escaping `<` makes that breakout structurally impossible regardless of upstream validation.
  const js = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c')

  // Strict allowlist for the post-login redirect target: only same-origin confirm-page
  // paths with an opaque id-like suffix. A prefix check (`startsWith('/confirm/')`) is not
  // enough — it still accepts `/confirm/</script><script>...`.
  const NEXT_RE = /^\/confirm\/[A-Za-z0-9_-]+$/
  const safeNext = (raw: unknown): string => (typeof raw === 'string' && NEXT_RE.test(raw)) ? raw : '/'

  // POPUP launcher. Opens be2-auth in a popup; on postMessage from the be2-auth origin ONLY,
  // extracts the authorizationCode, POSTs it to /confirm/session, then navigates to `next`.
  r.get('/confirm/login', (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const next = safeNext(req.query.next)
    // Live-verified 2026-08-13 (playwright capture of real be2-web login): be2-web opens the
    // login popup with NO redirectPath; adding one makes the be2-auth SPA client-route to /404.
    const loginUrl = `${deps.authOrigin}/auth/be2/login?loginFlow=POPUP`
    res.status(200).send(`<!doctype html><meta charset=utf-8><title>be2 登入</title>
<body><p>需登入 be2 才能審批變更。</p><button id="loginBtn">登入 be2</button><p id="msg"></p><script>
  var AUTH_ORIGIN = ${js(deps.authOrigin)};
  var NEXT = ${js(next)};
  var LOGIN_URL = ${js(loginUrl)};
  var pop = null;
  // window.open MUST run inside a user gesture (click) — browsers block popups opened on load. (agy round-1)
  document.getElementById('loginBtn').addEventListener('click', function () {
    pop = window.open(LOGIN_URL, 'be2login', 'width=480,height=640');
    document.getElementById('msg').textContent = '請於彈出視窗登入…';
  });
  window.addEventListener('message', function (e) {
    if (e.origin !== AUTH_ORIGIN) return;            // MANDATORY origin check (spec §3)
    // Live-verified real contract: { event:'UPDATE_AUTH_TOKEN', data:{ authorizationCode, device } }.
    // The code is nested at e.data.data.authorizationCode (not top-level). Keep a flat fallback.
    var p = (e.data && e.data.data) ? e.data.data : e.data;
    var code = (p && (p.authorizationCode || p.code)) || null;
    if (!code) return;
    fetch('/confirm/session', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ code: code }) })
      .then(function(r){ if(!r.ok) throw new Error('session'); if(pop) pop.close(); location.replace(NEXT); })
      .catch(function(){ document.getElementById('msg').textContent = '登入失敗,請重試。'; });
  });
</script></body>`)
  })

  r.post('/confirm/session', express.json(), h(async (req, res) => {
    const code = String((req.body as { code?: unknown })?.code ?? '')
    if (!code) { res.status(400).json({ error: { code: 'NO_CODE', message: 'missing authorization code' } }); return }
    const identity = await exchangeCodeToIdentity(deps.authServiceClient, deps.identities, code, deps.now())
    if (!identity) { res.status(502).json({ error: { code: 'NO_USER', message: 'token has no authKey' } }); return }
    const sessionId = WebSessionStore.newSessionId()
    // Task 4: the confirm-page cookie's credential MUST be tagged kind='web_session' — never
    // 'static_bearer' (that's what enroll.ts mints for the Phase 1a pilot bearer). confirmRoutes.ts's
    // requireSession gates on this kind, which is the structural reason an agent cannot
    // self-approve its own change-set by replaying its own MCP bearer as this cookie: even a
    // stolen/relayed secret only ever resolves to a credential of the WRONG kind.
    deps.credentials.insert({
      credHash: CredentialStore.hash(sessionId), identityId: identity.identityId, kind: 'web_session',
      expiresAt: null, updatedAt: deps.now(),
    })
    deps.webSessions.create(sessionId, identity.identityId)
    res.setHeader('Set-Cookie', serializeSetCookie('be2mcp_sid', sessionId, { httpOnly: true, sameSite: 'Lax', path: '/confirm' }))
    res.status(200).json({ ok: true })
  }))

  r.post('/confirm/logout', h(async (req, res) => {
    const sid = parseCookies(req.header('cookie'))['be2mcp_sid']
    if (sid) deps.webSessions.delete(sid)
    res.setHeader('Set-Cookie', serializeSetCookie('be2mcp_sid', '', { httpOnly: true, sameSite: 'Lax', path: '/confirm', maxAgeSec: 0 }))
    res.status(200).send('logged out')
  }))
  return r
}
