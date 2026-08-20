import express from 'express'
import { getModule } from '../core/changeset/registry.js'
import '../modules/index.js'
import type { ExecutorDeps } from '../core/changeset/executor.js'
import { approveAndExecute } from '../core/changeset/confirmService.js'
import { AppError } from '../errors.js'
import type { TokenManager } from '../auth/tokenManager.js'
import type { WebSessionStore } from './webSessionStore.js'
import type { CredentialStore } from '../store/credentialStore.js'
import { parseCookies } from './cookies.js'
import type { AnyDiffItem } from '../core/changeset/types.js'
import { esc } from '../core/changeset/html.js'
import type { ConfirmView } from '../core/changeset/module.js'

// Task 5: the confirm-page's auth model switches from a per-change-set capability token
// (`?token=`) to the be2-auth SSO web session (Task 4's `be2mcp_sid` cookie + WebSessionStore).
// Identity (who is approving) and authorization (which change-sets they may see) both come from
// the session now — never from the request body/query — closing the Phase 2a self-approval hole
// (anyone with the link could approve) documented in the Phase 2b design spec.
export interface ConfirmDeps extends ExecutorDeps {
  tokenManager: TokenManager
  webSessions: WebSessionStore
  // Task 4: requireSession resolves the cookie through this store to enforce the credential
  // KIND gate (kind === 'web_session') — the structural half of "an agent cannot self-approve":
  // an agent's own oauth_access / static_bearer secret, sent as this cookie, must resolve to a
  // credential of the wrong kind and be rejected, never merely rely on the secret being unknown.
  credentials: CredentialStore
  modifyUserFrom: (accessToken: string) => string
}

// creatorLabel (bearer-side, src/auth/enroll.ts) and session userLabel (confirm-page side,
// src/server/ssoRoutes.ts) now both derive from the same JWT authKey claim, but comparing them
// with strict `===` is still fragile against incidental case/whitespace differences (and would
// otherwise 404 a change-set's own creator on their own approval page). Normalize defensively.
const sameUser = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

function renderShell(id: string, view: ConfirmView, diffVersion: string, schedule?: { executeAtUtc: number; wall: string; tz: string }): string {
  const scheduleIntro = schedule ? `<p style="opacity:0.8;font-size:0.9em;margin-top:0">將於 ${esc(schedule.wall)} (${esc(schedule.tz)}) 執行；現況為批准當下快照，執行時庫存可能已因銷售變動，將以 SET 目標值覆寫</p>` : ''
  const hiddenInputs = `<input type=hidden name=diff_version value="${esc(diffVersion)}">${schedule ? `\n  <input type=hidden name=expected_execute_at_utc value="${schedule.executeAtUtc}">` : ''}`
  const btnText = schedule ? `批准(將於 ${esc(schedule.wall)} ${esc(schedule.tz)} 執行)` : '批准並執行'
  return `<!doctype html><meta charset=utf-8><title>確認變更 ${esc(id)}</title>
<style>body{font-family:sans-serif;max-width:820px;margin:2rem auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px}button{padding:8px 16px;font-size:1rem}</style>
<h1>確認 change-set ${esc(id)}</h1>${scheduleIntro}${view.intro}
${view.tableHtml}
<form method=post action="/confirm/${esc(id)}/approve" style="margin-top:1rem">
  ${hiddenInputs}
  <button type=submit>${btnText}</button></form>
<form method=post action="/confirm/${esc(id)}/reject"><button type=submit>拒絕</button></form>`
}

export function buildConfirmRouter(deps: ConfirmDeps): express.Router {
  const r = express.Router()
  r.use(express.urlencoded({ extended: false }))   // approve/reject may be form posts from the page
  // Express 5 (this project's version) auto-catches a rejected promise from an async route
  // handler — it will NOT crash the process the way Express 4 would. But its default error
  // handler renders an HTML page (and can include the error message) instead of the clean,
  // audit-consistent surface the rest of this codebase uses. Wrap every async route anyway so
  // gateway/executor throws become a controlled 500 with nothing leaked, and so a bug here can
  // never regress into a crash if this code is ever ported behind a different Express major.
  const h = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response) => { void fn(req, res).catch(err => {
      console.error('confirm route error:', (err as Error).message)
      if (!res.headersSent) res.status(500).send('internal error')
    }) }

  async function requireSession(req: express.Request): Promise<{ sessionId: string; userLabel: string; accessToken: string; identityId: string } | undefined> {
    const sid = parseCookies(req.header('cookie'))['be2mcp_sid']
    if (!sid) return undefined
    const sess = deps.webSessions.get(sid)   // undefined if idle-expired (row deleted)
    if (!sess) return undefined
    // Task 4 kind gate: the be2mcp_sid cookie must resolve to a credential MINTED BY the
    // confirm-page SSO login (kind === 'web_session'). An agent holding its own oauth_access or
    // static_bearer credential and sending that secret AS this cookie must be rejected here —
    // structurally, not just because the secret happens to be "unknown" (it is a perfectly known,
    // valid credential — just of the wrong kind for this surface). This is what makes
    // self-approval impossible even if the agent knows the change-set id (鐵則 #4).
    const cred = deps.credentials.getBySecret(sid)
    if (!cred || cred.kind !== 'web_session') return undefined
    let user
    try {
      user = await deps.tokenManager.getFreshByCredHash(cred.credHash)
    } catch {
      // be2 refresh token expired/revoked (AuthError REAUTH_REQUIRED) or upstream unavailable:
      // the web session is dead. Delete it and treat as no-session so the caller redirects to
      // login — otherwise every /confirm request 500s in a loop until the idle TTL. (agy round-1)
      deps.webSessions.delete(sid)
      return undefined
    }
    deps.webSessions.touch(sid)
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
  function loginRedirect(res: express.Response, next: string) { res.redirect(302, `/confirm/login?next=${encodeURIComponent(next)}`) }

  async function liveDiff(rec: NonNullable<ReturnType<typeof deps.changeSets.get>>, accessToken: string) {
    const mod = getModule(rec.actionType)
    const diff = await mod.computeDiff({ gateway: deps.gateway, accessToken, userLabel: rec.creatorLabel }, rec.items) as AnyDiffItem[]
    return { diff, version: mod.diffVersion(diff) }
  }

  r.get('/confirm/:id', h(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const who = await requireSession(req)
    if (!who) { loginRedirect(res, `/confirm/${req.params.id}`); return }
    const rec = deps.changeSets.get(String(req.params.id))
    // IDOR: only the change-set's creator may view it. Generic 404 either way — no existence leak
    // for a different user's change-set id.
    if (!rec || !sameUser(rec.creatorLabel, who.userLabel) || (rec.status !== 'pending_approval' && rec.status !== 'scheduled')) { res.status(404).send('not found'); return }
    
    if (rec.status === 'scheduled') {
      const banner = `<p style="color:#2a2;font-weight:bold;margin-bottom:1rem">已排程:將於 ${esc(rec.schedule!.wall)}(${esc(rec.schedule!.tz)})執行(登出不影響執行)</p>`
      const view = getModule(rec.actionType).renderConfirm(rec, rec.diff, rec.diffVersion, banner)
      const shellHtml = `<!doctype html><meta charset=utf-8><title>確認變更 ${esc(rec.id)}</title>
<style>body{font-family:sans-serif;max-width:820px;margin:2rem auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px}button{padding:8px 16px;font-size:1rem}</style>
<h1>確認 change-set ${esc(rec.id)}</h1>${view.intro}
${view.tableHtml}
<form method=post action="/confirm/${esc(rec.id)}/cancel" style="margin-top:1rem">
  <button type=submit>取消排程</button></form>`
      res.status(200).send(shellHtml)
      return
    }

    const { diff, version } = await liveDiff(rec, who.accessToken)
    res.status(200).send(renderShell(rec.id, getModule(rec.actionType).renderConfirm(rec, diff, version, ''), version, rec.schedule))
  }))

  r.post('/confirm/:id/approve', h(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const who = await requireSession(req)
    if (!who) { loginRedirect(res, `/confirm/${req.params.id}`); return }
    const rec = deps.changeSets.get(String(req.params.id))
    if (!rec || !sameUser(rec.creatorLabel, who.userLabel) || rec.status !== 'pending_approval') { res.status(404).send('not found'); return }
    // Task 11: the actual recompute-diff -> staleness -> CAS -> resolve-modify_user -> execute ->
    // audit sequence now lives in src/changeset/confirmService.ts's approveAndExecute — shared
    // with the MCP Apps panel's app_confirm_changeset tool so there is exactly one implementation
    // of this security-critical sequence. The confirm page never passes confirmedKeys (it has no
    // per-item checkboxes; stays whole-batch, unchanged from Phase 2a/2b). Any throw here (e.g.
    // modifyUserFrom failing) propagates to the `h()` wrapper -> 500, with the change-set left
    // 'pending_approval' (retryable, not stranded) — same as before the extraction.
    let out
    try {
      out = await approveAndExecute(deps, {
        rec, who, expectedDiffVersion: String(req.body?.diff_version),
        channel: 'confirm_page',
        audit: { ip: req.ip, clientInfo: req.header('user-agent') },
        expectedExecuteAtUtc: req.body?.expected_execute_at_utc !== undefined && req.body.expected_execute_at_utc !== '' ? Number(req.body.expected_execute_at_utc) : undefined,
      })
    } catch (e) {
      // 排程兩個新錯誤是「可預期、可自助」的 409(批准只驗仍在未來,SCHEDULE_IN_PAST 在人審久
      // 一點的 tight schedule 上很容易發生)——不能落進 h() 的通用 500 讓訊息蒸發。其他 throw
      // (modifyUserFrom 失敗等)維持既有慣例向上拋 → 500。
      if (e instanceof AppError && (e.code === 'SCHEDULE_IN_PAST' || e.code === 'SCHEDULE_ECHO_MISMATCH')) {
        res.status(409).send(`<!doctype html><meta charset=utf-8><h1>無法批准</h1><p>${esc(e.message)}</p>`)
        return
      }
      throw e
    }
    if (out.stale) {
      const { diff, version } = await liveDiff(rec, who.accessToken)
      res.status(409).send(renderShell(rec.id, getModule(rec.actionType).renderConfirm(rec, diff, version, '<p style="color:#b00">目標欄位已被改動,請重新確認。</p>'), version, rec.schedule))
      return
    }
    if (out.casFailed) { res.status(409).send('已被處理或已過期'); return }
    if (out.scheduled) {
      res.status(200).send(`<!doctype html><meta charset=utf-8><style>body{font-family:sans-serif;max-width:820px;margin:2rem auto}</style><h1>已排程</h1><p>變更將於 ${esc(rec.schedule!.wall)} (${esc(rec.schedule!.tz)}) 執行。</p><p>取消排程請透過批次精靈面板或本確認頁的排程檢視(可回本確認頁取消排程)。</p>`)
      return
    }
    res.status(200).send(`<!doctype html><meta charset=utf-8><h1>執行結果:${esc(out.status)}</h1><pre>${esc(JSON.stringify(out.results, null, 2))}</pre>`)
  }))

  r.post('/confirm/:id/cancel', h(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const who = await requireSession(req)
    if (!who) { loginRedirect(res, `/confirm/${req.params.id}`); return }
    const rec = deps.changeSets.get(String(req.params.id))
    if (!rec || !sameUser(rec.creatorLabel, who.userLabel)) { res.status(404).send('not found'); return }
    // 只有 scheduled 可取消(spec §8):cancelled 是唯一允許的人工轉移、終態。
    const won = deps.changeSets.casStatus(rec.id, 'scheduled', 'cancelled', deps.now())
    if (!won) { res.status(409).send('已被處理或非排程狀態'); return }
    deps.audit.record({
      userLabel: who.userLabel, sessionId: who.sessionId,
      clientInfo: 'confirm-page:' + String(req.headers['user-agent'] ?? '').slice(0, 80),
      tool: 'changeset.cancel', params: { changeset_id: rec.id, ip: req.ip },
      status: 'ok', traceId: 'n/a', durationMs: 0,
    })
    res.status(200).send('已取消排程')
  }))

  r.post('/confirm/:id/reject', h(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const who = await requireSession(req)
    if (!who) { loginRedirect(res, `/confirm/${req.params.id}`); return }
    const rec = deps.changeSets.get(String(req.params.id))
    if (!rec || !sameUser(rec.creatorLabel, who.userLabel)) { res.status(404).send('not found'); return }
    // Same CAS discipline as approve: only a still-pending change-set can be rejected. Prevents
    // rejecting a change-set that has already been approved/executed (or rejected) concurrently.
    const won = deps.changeSets.casStatus(rec.id, 'pending_approval', 'rejected', deps.now())
    if (!won) { res.status(409).send('已被處理或已過期'); return }
    deps.audit.record({
      userLabel: who.userLabel, sessionId: who.sessionId,
      clientInfo: 'confirm-page:' + String(req.headers['user-agent'] ?? '').slice(0, 80),
      tool: 'changeset.reject', params: { changeset_id: rec.id, ip: req.ip },
      status: 'ok', traceId: 'n/a', durationMs: 0,
    })
    res.status(200).send('rejected')
  }))
  return r
}
