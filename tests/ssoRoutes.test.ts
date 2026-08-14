import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { openDb } from '../src/store/db.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'
import { buildSsoRouter } from '../src/server/ssoRoutes.js'
import { runLauncherScript } from './launcherHarness.js'

function fakeJwt(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`
}
let server: Server, base: string, identities: IdentityStore, credentials: CredentialStore, webSessions: WebSessionStore
beforeEach(async () => {
  const db = openDb(':memory:')
  identities = new IdentityStore(db); credentials = new CredentialStore(db)
  webSessions = new WebSessionStore(db, { now: () => 1000 })
  const jwt = fakeJwt({ authKey: 'approver@kkday.com', exp: Math.floor(Date.now() / 1000) + 3000 })
  const authServiceClient = { exchangeCode: async (_c: string) => ({ accessToken: jwt, refreshToken: 'r', businessList: [] }) } as never
  const router = buildSsoRouter({ authServiceClient, identities, credentials, webSessions, authOrigin: 'https://auth-220.sit.kkday.com', now: () => 1000 })
  const app = express(); app.use(express.json()); app.use(router)
  server = app.listen(0); await new Promise(r => server.on('listening', r as () => void))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

describe('SSO routes', () => {
  it('GET /confirm/login serves a click-gated POPUP launcher that pins the be2-auth origin', async () => {
    const r = await fetch(`${base}/confirm/login?next=${encodeURIComponent('/confirm/cs1')}`)
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toContain('loginFlow=POPUP')
    expect(html).toContain('auth-220.sit.kkday.com')          // the pinned origin for postMessage check
    expect(html).toContain('id="loginBtn"')                   // popup opens on click (not on load) — browsers block load-time popups
    expect(html).toContain('addEventListener')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
  })
  it('POST /confirm/session exchanges a code, creates a session, sets an HttpOnly cookie', async () => {
    const r = await fetch(`${base}/confirm/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'auth-code-1' }) })
    expect(r.status).toBe(200)
    const setCookie = r.headers.get('set-cookie')!
    expect(setCookie).toContain('be2mcp_sid=')
    expect(setCookie).toContain('HttpOnly')
    // the session exists and is labelled by the token's authKey email
    const sid = /be2mcp_sid=([^;]+)/.exec(setCookie)![1]
    // Task 4: web_sessions now stores identity_id (not userLabel directly) — the identity it
    // points at is what carries the userLabel.
    const sess = webSessions.get(sid)!
    expect(identities.get(sess.identityId)!.userLabel).toBe('approver@kkday.com')
    // the credential minted for this cookie must be kind='web_session' (Task 4 kind gate) —
    // never 'static_bearer', which is what enroll.ts's static-bearer path would have produced.
    const cred = credentials.getBySecret(sid)!
    expect(cred.kind).toBe('web_session')
    // the be2 token was stored under hash(sessionId) so getFreshByCredHash works later
    expect(identities.get(cred.identityId)!.userLabel).toBe('approver@kkday.com')
  })
  it('POST /confirm/session rejects a missing code', async () => {
    const r = await fetch(`${base}/confirm/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(400)
  })
  it('GET /confirm/login rejects a `next` breakout attempt and never emits an unescaped </script> breakout', async () => {
    const malicious = '/confirm/</script><script>alert(1)</script>'
    const r = await fetch(`${base}/confirm/login?next=${encodeURIComponent(malicious)}`)
    const html = await r.text()
    expect(r.status).toBe(200)
    // the literal breakout sequence must never appear unescaped in the response
    expect(html).not.toContain('</script><script>alert')
    // next must have been rejected by the strict allowlist and fallen back to '/'
    expect(html).toMatch(/var NEXT = "\\?\/"/) // fell back to '/' (plain or unicode-escaped slash form)
  })
  // be2-auth LoginPage.vue（validatePopupPageSource）：popup 開啟後發 AUTH_LOGIN_READY，
  // opener 必須在 500ms 內回 {event:'CONFIRM_LOGIN_DOMAIN'}，且 be2-auth 驗這則回覆的
  // event.origin——不回就 client-route 到 /404（2026-08-14 live 404 的根因之一）。
  it('launcher 收到 be2-auth 的 AUTH_LOGIN_READY → 回 CONFIRM_LOGIN_DOMAIN 給 popup（targetOrigin 鎖 be2-auth）', async () => {
    const html = await (await fetch(`${base}/confirm/login`)).text()
    const page = runLauncherScript(html)
    const pop = page.clickLogin()
    page.dispatchMessage({ origin: 'https://auth-220.sit.kkday.com', source: pop, data: { event: 'AUTH_LOGIN_READY' } })
    expect(pop.posted).toEqual([{ data: { event: 'CONFIRM_LOGIN_DOMAIN' }, targetOrigin: 'https://auth-220.sit.kkday.com' }])
  })
  it('launcher 對非 be2-auth origin 的 AUTH_LOGIN_READY 不回握手', async () => {
    const html = await (await fetch(`${base}/confirm/login`)).text()
    const page = runLauncherScript(html)
    const pop = page.clickLogin()
    page.dispatchMessage({ origin: 'https://evil.example.com', source: pop, data: { event: 'AUTH_LOGIN_READY' } })
    expect(pop.posted).toEqual([])
  })
  it('GET /confirm/login preserves a clean, allowlisted `next`', async () => {
    const r = await fetch(`${base}/confirm/login?next=${encodeURIComponent('/confirm/cs1')}`)
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toContain('/confirm/cs1')
  })
})
