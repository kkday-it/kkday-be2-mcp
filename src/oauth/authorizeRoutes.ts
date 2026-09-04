import express from 'express'
import { randomBytes } from 'node:crypto'
import type { AuthServiceClient } from '../auth/authServiceClient.js'
import type { IdentityStore } from '../store/identityStore.js'
import { CredentialStore } from '../store/credentialStore.js'
import { WebSessionStore } from '../server/webSessionStore.js'
import { serializeSetCookie } from '../server/cookies.js'
import { exchangeCodeToIdentity } from '../server/ssoRoutes.js'
import { isAllowedRedirectUri } from './redirectUri.js'
import type { OAuthStore } from './oauthStore.js'

// Task 9：OAuth 2.1 `/oauth/authorize`——外殼（discovery/DCR，Task 6/7）與內核（be2-auth 登入，
// Task 4 的 exchangeCodeToIdentity）在此接軌。登入腿走 POPUP（見
// docs/be2-mcp/spike-oauth-login-leg.md 定論），直接復用 ssoRoutes.ts 的 postMessage+origin 檢查
// 樣式，唯一差別是這裡驗完登入後不是導向 /confirm/:id，而是鑄一次性 authz code 導回 OAuth
// client 的 redirect_uri。

export interface AuthorizeDeps {
  oauthStore: OAuthStore
  authServiceClient: AuthServiceClient
  identities: IdentityStore
  credentials: CredentialStore
  webSessions: WebSessionStore
  authOrigin: string
  now: () => number
  genCode?: () => string
  codeTtlMs?: number
}

interface ValidParams { clientId: string; redirectUri: string; codeChallenge: string; state: string }

export function buildAuthorizeRouter(deps: AuthorizeDeps): express.Router {
  const r = express.Router()
  const genCode = deps.genCode ?? (() => randomBytes(32).toString('hex'))
  const codeTtlMs = deps.codeTtlMs ?? 60_000
  const h = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response) => { void fn(req, res).catch(() => { if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } }) }) }

  // Safe to interpolate into an inline <script>: see ssoRoutes.ts's `js` for why plain
  // JSON.stringify is not enough (</script> breakout) — every value embedded into the
  // authorize launcher page (client_id/redirect_uri/code_challenge/state) is attacker-influenced
  // query-string input and MUST go through this before landing in the HTML.
  const js = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c')

  // 單一驗證函式，GET /oauth/authorize（query）與 POST /oauth/authorize/complete（body 回傳的
  // 同一組參數）都呼叫它——後者不是信任前端 JS 沒被竄改，而是把它當獨立、可被任何人直接
  // POST 的公開端點重新驗證一次（defense in depth；見下方 complete handler 的註解）。
  async function validateParams(p: {
    client_id?: unknown; redirect_uri?: unknown; response_type?: unknown
    code_challenge?: unknown; code_challenge_method?: unknown; state?: unknown
  }): Promise<{ ok: true; params: ValidParams } | { ok: false }> {
    const clientId = typeof p.client_id === 'string' ? p.client_id : ''
    const client = clientId ? await deps.oauthStore.getClient(clientId) : undefined
    if (!client) return { ok: false }
    const redirectUri = typeof p.redirect_uri === 'string' ? p.redirect_uri : ''
    // 兩道檢查缺一不可：必須在「這個 client 註冊時登記的 redirect_uris」裡，且獨立通過
    // isAllowedRedirectUri（Task 7 的全域 allowlist）——client 表本身若被繞過 register 端點的
    // 檢查直接寫入（理論上不該發生，但這裡不假設它一定乾淨），仍要擋下。
    if (!redirectUri || !client.redirectUris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri)) return { ok: false }
    if (p.response_type !== 'code') return { ok: false }
    const codeChallenge = typeof p.code_challenge === 'string' ? p.code_challenge : ''
    if (!codeChallenge) return { ok: false }
    if (p.code_challenge_method !== 'S256') return { ok: false }
    const state = typeof p.state === 'string' ? p.state : ''
    if (!state) return { ok: false }
    return { ok: true, params: { clientId, redirectUri, codeChallenge, state } }
  }

  // GET /oauth/authorize — 驗證失敗一律 400（絕不 redirect 到未經驗證的 redirect_uri，即使
  // query 裡帶了看起來合理的 redirect_uri：驗證沒過就沒有「可信的導向目標」）。驗證通過才渲染
  // POPUP 登入過場頁，把已驗證過的參數原封嵌入頁面，供登入成功後回傳給 complete 端點。
  r.get('/oauth/authorize', h(async (req, res) => {
    const v = await validateParams(req.query as Record<string, unknown>)
    if (!v.ok) { res.status(400).send('invalid_request'); return }
    const { clientId, redirectUri, codeChallenge, state } = v.params
    // NOTE: be2-web 的登入頁 NOT set no-referrer；be2-auth 登入 SPA 疑似檢查 document.referrer，
    // no-referrer 會讓 popup 收不到 referrer → 跳 /404。此頁的 referrer 只含 authorize query
    // （client_id/code_challenge/state，去給受信任的 be2-auth），洩漏面低，故不設 no-referrer。
    // Live-verified 2026-08-13 (playwright capture of real be2-web login): be2-web opens the
    // login popup with NO redirectPath; adding one makes the be2-auth SPA client-route to /404.
    const loginUrl = `${deps.authOrigin}/auth/be2/login?loginFlow=POPUP`
    res.status(200).send(`<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>連接 Claude 與 be2 — 授權登入</title>
<style>
  :root { --bg:#f5f5f7; --card:#fff; --text:#1d1d1f; --muted:#6e6e73; --border:rgba(0,0,0,.08); --tint:#0A84FF; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; display:flex; justify-content:center; align-items:center; min-height:100vh; padding:16px; box-sizing:border-box; }
  .card { background:var(--card); width:100%; max-width:400px; border-radius:14px; box-shadow:0 1px 2px rgba(0,0,0,.04), 0 4px 12px rgba(0,0,0,.04); padding:32px; box-sizing:border-box; text-align:center; }
  @media (max-width:480px) {
    body { padding:0; align-items:stretch; }
    .card { border-radius:0; box-shadow:none; max-width:100%; padding:32px 24px; display:flex; flex-direction:column; justify-content:center; }
  }
  .signature { margin:0 auto 24px; width:200px; display:block; }
  .signature .dash { stroke-dasharray:6; animation:dash-flow 20s linear infinite reverse; }
  .signature.loading .dash { animation-duration:2s; }
  .signature.success .dash { stroke-dasharray:none; animation:none; }
  @media (prefers-reduced-motion: reduce) { .signature .dash { animation:none; } }
  @keyframes dash-flow { to { stroke-dashoffset: 100; } }
  h1 { font-size:1.25rem; font-weight:650; letter-spacing:-0.02em; margin:0 0 12px; }
  p { font-size:.9375rem; line-height:1.6; margin:0 0 24px; }
  .trust-points { text-align:left; margin:0 0 24px; padding:0; list-style:none; color:var(--muted); font-size:.8125rem; line-height:1.5; }
  .trust-points li { position:relative; padding-left:20px; margin-bottom:8px; }
  .trust-points li::before { content:"✓"; position:absolute; left:0; top:0; }
  button { width:100%; background:var(--tint); color:#fff; border:none; border-radius:10px; padding:12px; font-size:1rem; cursor:pointer; transition:filter .2s; }
  button:hover { filter:brightness(1.1); }
  button:focus-visible { outline:2px solid var(--tint); outline-offset:2px; }
  #msg { color:var(--muted); font-size:.9375rem; min-height:1.5em; margin:16px 0 24px; }
  .footer { font-size:.8125rem; color:var(--muted); margin:0; }
  #msg a { color:var(--tint); text-decoration:none; }
  #msg a:hover { text-decoration:underline; }
</style>
<div class="card">
  <svg class="signature" id="conn" viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg">
    <line class="dash" x1="60" y1="30" x2="140" y2="30" stroke="var(--muted)" stroke-width="2" />
    <circle cx="30" cy="30" r="30" fill="#D97757" />
    <text x="30" y="34" fill="#fff" font-size="12" font-family="sans-serif" font-weight="600" text-anchor="middle">Claude</text>
    <circle cx="170" cy="30" r="30" fill="#26BEC9" />
    <text x="170" y="34" fill="#fff" font-size="14" font-family="sans-serif" font-weight="600" text-anchor="middle">be2</text>
  </svg>
  <h1>連接 Claude 與 be2</h1>
  <p>Claude 請求以你的 be2 身分存取商品後台。登入後，agent 才能替你查詢商品與方案。</p>
  <ul class="trust-points">
    <li>登入視窗是 be2 官方登入頁，本頁不會經手你的密碼</li>
    <li>所有寫入都需你在確認頁親自批准後才會執行</li>
    <li>憑證存於公司內網，不外傳</li>
  </ul>
  <button id="loginBtn">使用 be2 帳號登入</button>
  <div id="msg"></div>
  <div class="footer">身分由 kkday-auth-service 驗證 · be2-mcp</div>
</div>
<script>
  var AUTH_ORIGIN = ${js(deps.authOrigin)};
  var LOGIN_URL = ${js(loginUrl)};
  var CLIENT_ID = ${js(clientId)};
  var REDIRECT_URI = ${js(redirectUri)};
  var CODE_CHALLENGE = ${js(codeChallenge)};
  var STATE = ${js(state)};
  var pop = null;
  var uiState = 'idle';
  var pollTimer = null;
  var btn = document.getElementById('loginBtn');
  var msgEl = document.getElementById('msg');
  var conn = document.getElementById('conn');

  function setUiState(s) {
    if (uiState === 'success') return;
    uiState = s;
    if (s === 'idle') {
      if (btn) { btn.disabled = false; btn.textContent = '使用 be2 帳號登入'; }
      if (conn && conn.classList) { conn.classList.remove('loading'); conn.classList.remove('success'); }
    } else if (s === 'waiting_popup') {
      if (btn) { btn.disabled = true; btn.textContent = '等待彈出視窗登入…'; }
      if (msgEl) msgEl.textContent = '請於彈出視窗登入…';
      if (conn && conn.classList) conn.classList.add('loading');
    } else if (s === 'exchanging') {
      if (msgEl) msgEl.textContent = '登入成功，正在完成授權…';
      if (btn) btn.disabled = true;
    } else if (s === 'success') {
      if (conn && conn.classList) { conn.classList.remove('loading'); conn.classList.add('success'); }
      if (msgEl) msgEl.textContent = '授權完成，正在返回 Claude…';
    } else if (s === 'error') {
      if (msgEl) msgEl.textContent = '登入失敗,請重試。';
      if (btn) { btn.disabled = false; btn.textContent = '使用 be2 帳號登入'; }
      if (conn && conn.classList) conn.classList.remove('loading');
    }
  }

  function stopPoll() {
    if (pollTimer) {
      try {
        if (typeof clearInterval === 'function') clearInterval(pollTimer);
      } catch (e) {}
      pollTimer = null;
    }
  }

  try {
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('storage', function (e) {
        if (e.key === 'be2mcp_authorize_done' && uiState !== 'success') {
          if (btn) btn.disabled = true;
          if (msgEl) msgEl.textContent = '已在另一個分頁完成授權，此分頁可關閉';
          stopPoll();
        }
      });
    }
  } catch (e) {}

  if (btn && typeof btn.addEventListener === 'function') {
    // window.open MUST run inside a user gesture (click) — browsers block popups opened on load.
    btn.addEventListener('click', function () {
      setUiState('waiting_popup');
      pop = window.open(LOGIN_URL, 'be2login', 'width=480,height=640');
      if (!pop) {
        setUiState('idle');
        if (msgEl) msgEl.textContent = '彈出視窗被瀏覽器封鎖——請允許本站彈出視窗後重試';
        return;
      }
      try {
        if (typeof setInterval === 'function') {
          pollTimer = setInterval(function () {
            try {
              if (pop && pop.closed) {
                stopPoll();
                if (uiState === 'waiting_popup') {
                  setUiState('idle');
                  if (msgEl) msgEl.textContent = '登入視窗已關閉，未完成登入——可再試一次';
                }
              }
            } catch (e) {}
          }, 1000);
        }
      } catch (e) {}
    });
  }

  try {
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('message', function (e) {
        if (e.origin !== AUTH_ORIGIN) return;            // MANDATORY origin check
        // be2-auth LoginPage.vue (validatePopupPageSource) handshake: the popup posts
        // AUTH_LOGIN_READY and the opener MUST reply CONFIRM_LOGIN_DOMAIN within 500ms,
        // or the popup client-routes to /404 (root cause of the 2026-08-14 live 404s).
        if (e.data && e.data.event === 'AUTH_LOGIN_READY') {
          var w = e.source || pop;
          if (w) w.postMessage({ event: 'CONFIRM_LOGIN_DOMAIN' }, AUTH_ORIGIN);
          return;
        }
        // Live-verified real contract: { event:'UPDATE_AUTH_TOKEN', data:{ authorizationCode, device } }.
        var p = (e.data && e.data.data) ? e.data.data : e.data;
        var code = (p && (p.authorizationCode || p.code)) || null;
        if (!code) return;
        
        stopPoll();
        setUiState('exchanging');
        
        fetch('/oauth/authorize/complete', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({
            code: code, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
            response_type: 'code', code_challenge: CODE_CHALLENGE, code_challenge_method: 'S256', state: STATE,
          }),
        })
          .then(function(r){ if(!r.ok) throw new Error('authorize'); return r.json(); })
          .then(function(d){ 
            if (pop) pop.close(); 
            setUiState('success');
            try { if (typeof localStorage !== 'undefined') localStorage.setItem('be2mcp_authorize_done', String(Date.now())); } catch(e) {}
            location.replace(d.redirectTo); 
            try {
              if (typeof setTimeout === 'function') {
                setTimeout(function () {
                  try {
                    if (msgEl) {
                      msgEl.textContent = '';
                      var a = document.createElement('a');
                      a.textContent = '若未自動跳轉，點此完成授權';
                      a.setAttribute('href', d.redirectTo);
                      msgEl.appendChild(a);
                    }
                  } catch (e) {}
                }, 1500);
              }
            } catch(e) {}
          })
          .catch(function(){ setUiState('error'); });
      });
    }
  } catch (e) {}
</script>
</html>`)
  }))

  // POST /oauth/authorize/complete — 這是一個公開端點（如 /confirm/session），任何人都能直接
  // POST 到這裡而不經過上面的 GET 頁面，所以必須把 client_id/redirect_uri/PKCE 參數重新驗證
  // 一遍（不能只信任「這是我們自己頁面送出的」）。驗證失敗：不鑄 code、不建 session/cookie。
  r.post('/oauth/authorize/complete', express.json(), h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const v = await validateParams(body)
    if (!v.ok) { res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'invalid authorize params' } }); return }
    const code = typeof body.code === 'string' ? body.code : ''
    if (!code) { res.status(400).json({ error: { code: 'NO_CODE', message: 'missing authorization code' } }); return }

    const identity = await exchangeCodeToIdentity(deps.authServiceClient, deps.identities, code, deps.now())
    if (!identity) { res.status(502).json({ error: { code: 'NO_USER', message: 'token has no authKey' } }); return }

    // SSO-seamless cookie：與確認頁（ssoRoutes.ts /confirm/session）同一套 web_session
    // credential 模型、同一個 Path=/confirm，讓使用者在 authorize 這步登入後，稍後開確認頁
    // 也是免登入的靜默體驗。
    const sessionId = WebSessionStore.newSessionId()
    await deps.credentials.insert({
      credHash: CredentialStore.hash(sessionId), identityId: identity.identityId, kind: 'web_session',
      expiresAt: null, updatedAt: deps.now(),
    })
    await deps.webSessions.create(sessionId, identity.identityId)
    res.setHeader('Set-Cookie', serializeSetCookie('be2mcp_sid', sessionId, { httpOnly: true, sameSite: 'Lax', path: '/confirm' }))

    // 一次性 authz code：明文只活在這個 JSON 回應（給前端 JS 組回 redirect_uri 用）與瀏覽器
    // 之後導向 redirect_uri 的那個 URL 裡，store 裡永遠只有 sha256 雜湊——與 credentials/
    // web_sessions 的明文永不落地原則一致。
    const rawCode = genCode()
    await deps.oauthStore.insertAuthCode({
      codeHash: CredentialStore.hash(rawCode), clientId: v.params.clientId, redirectUri: v.params.redirectUri,
      codeChallenge: v.params.codeChallenge, identityId: identity.identityId,
      exp: deps.now() + codeTtlMs, consumed: 0,
    })
    const redirectTo = `${v.params.redirectUri}?code=${encodeURIComponent(rawCode)}&state=${encodeURIComponent(v.params.state)}`
    res.status(200).json({ redirectTo })
  }))

  return r
}
