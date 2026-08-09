import express from 'express'
import type { AuthServiceClient } from '../auth/authServiceClient.js'
import { TokenStore } from '../store/tokenStore.js'
import { WebSessionStore } from './webSessionStore.js'
import { decodeJwtClaims, decodeJwtExpMs } from '../auth/jwt.js'
import { parseCookies, serializeSetCookie } from './cookies.js'

export interface SsoDeps {
  authServiceClient: AuthServiceClient; tokenStore: TokenStore; webSessions: WebSessionStore
  authOrigin: string; now: () => number
}

export function buildSsoRouter(deps: SsoDeps): express.Router {
  const r = express.Router()
  const h = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response) => { void fn(req, res).catch(() => { if (!res.headersSent) res.status(500).send('internal error') }) }

  // POPUP launcher. Opens be2-auth in a popup; on postMessage from the be2-auth origin ONLY,
  // extracts the authorizationCode, POSTs it to /confirm/session, then navigates to `next`.
  r.get('/confirm/login', (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/confirm/') ? req.query.next : '/'
    const loginUrl = `${deps.authOrigin}/auth/be2/login?loginFlow=POPUP&redirectPath=${encodeURIComponent(deps.authOrigin + '/auth/be2/login')}`
    res.status(200).send(`<!doctype html><meta charset=utf-8><title>be2 登入</title>
<body><p>需登入 be2 才能審批變更。</p><button id="loginBtn">登入 be2</button><p id="msg"></p><script>
  var AUTH_ORIGIN = ${JSON.stringify(deps.authOrigin)};
  var NEXT = ${JSON.stringify(next)};
  var LOGIN_URL = ${JSON.stringify(loginUrl)};
  var pop = null;
  // window.open MUST run inside a user gesture (click) — browsers block popups opened on load. (agy round-1)
  document.getElementById('loginBtn').addEventListener('click', function () {
    pop = window.open(LOGIN_URL, 'be2login', 'width=480,height=640');
    document.getElementById('msg').textContent = '請於彈出視窗登入…';
  });
  window.addEventListener('message', function (e) {
    if (e.origin !== AUTH_ORIGIN) return;            // MANDATORY origin check (spec §3)
    var code = (e.data && (e.data.authorizationCode || e.data.code)) || null;
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
    const tokens = await deps.authServiceClient.exchangeCode(code)
    const userLabel = String(decodeJwtClaims(tokens.accessToken).authKey ?? '')
    if (!userLabel) { res.status(502).json({ error: { code: 'NO_USER', message: 'token has no authKey' } }); return }
    const sessionId = WebSessionStore.newSessionId()
    deps.tokenStore.upsert({
      bearerHash: TokenStore.hashBearer(sessionId), userLabel,
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, businessList: tokens.businessList,
      accessExpiresAt: decodeJwtExpMs(tokens.accessToken), updatedAt: deps.now(),
    })
    deps.webSessions.create(sessionId, userLabel)
    res.setHeader('Set-Cookie', serializeSetCookie('be2mcp_sid', sessionId, { httpOnly: true, sameSite: 'Lax', path: '/confirm' }))
    res.status(200).json({ ok: true })
  }))

  r.post('/confirm/logout', (req, res) => {
    const sid = parseCookies(req.header('cookie'))['be2mcp_sid']
    if (sid) deps.webSessions.delete(sid)
    res.setHeader('Set-Cookie', serializeSetCookie('be2mcp_sid', '', { httpOnly: true, sameSite: 'Lax', path: '/confirm', maxAgeSec: 0 }))
    res.status(200).send('logged out')
  })
  return r
}
