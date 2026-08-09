import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { ChangeSetStore } from '../changeset/store.js'
import { computeShelfDiff, diffVersionHash } from '../changeset/diff.js'
import { executeChangeSet, type ExecutorDeps } from '../changeset/executor.js'
import type { DiffItem } from '../changeset/types.js'

export interface ConfirmDeps extends ExecutorDeps {}

function esc(s: unknown): string { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)) }

function renderPage(id: string, token: string, diff: DiffItem[], diffVersion: string, banner = ''): string {
  const rows = diff.map(d => `<tr><td>${esc(d.name ?? d.pkg_oid ?? d.prod_oid)}</td><td>${esc(d.prod_oid)}${d.pkg_oid ? '/' + esc(d.pkg_oid) : ''}</td><td>${d.current_is_active === undefined ? '?' : d.current_is_active ? '上架' : '下架'}</td><td>→ ${d.target_is_active ? '上架' : '下架'}</td><td>${d.no_op ? '(無變更)' : ''}</td></tr>`).join('')
  return `<!doctype html><meta charset=utf-8><title>確認變更 ${esc(id)}</title>
<style>body{font-family:sans-serif;max-width:820px;margin:2rem auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px}button{padding:8px 16px;font-size:1rem}</style>
<h1>確認 change-set ${esc(id)}</h1>${banner}
<p>名稱為 be2 內容(untrusted),請以 oid 為準核對。</p>
<table data-diff-version="${esc(diffVersion)}"><tr><th>名稱</th><th>oid</th><th>現況</th><th>目標</th><th></th></tr>${rows}</table>
<form method=post action="/confirm/${esc(id)}/approve" style="margin-top:1rem">
  <input type=hidden name=token value="${esc(token)}"><input type=hidden name=diff_version value="${esc(diffVersion)}">
  <button type=submit>批准並執行</button></form>
<form method=post action="/confirm/${esc(id)}/reject"><input type=hidden name=token value="${esc(token)}"><button type=submit>拒絕</button></form>`
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
  const tokenOf = (req: express.Request) => String(req.query.token ?? req.body?.token ?? '')
  // Constant-time compare against the stored hash — avoids leaking timing information about how
  // many leading hex chars of the token hash matched. Both sides are sha256 hex (64 chars) in
  // practice, but a length mismatch is treated defensively as a non-match rather than thrown.
  function hashesEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'hex'), bufB = Buffer.from(b, 'hex')
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
  }
  function load(id: string, token: string) {
    const rec = deps.changeSets.get(id)
    if (!rec || !hashesEqual(rec.approvalTokenHash, ChangeSetStore.hashToken(token))) return undefined
    return rec
  }
  async function liveDiff(rec: NonNullable<ReturnType<typeof deps.changeSets.get>>) {
    const user = await deps.tokenManager.getFreshByHash(rec.creatorBearerHash)
    const diff = await computeShelfDiff(rec.actionType, rec.items, { gateway: deps.gateway, accessToken: user.accessToken, userLabel: user.userLabel })
    return { diff, version: diffVersionHash(diff) }
  }

  r.get('/confirm/:id', h(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const rec = load(String(req.params.id), tokenOf(req))
    if (!rec || rec.status !== 'pending_approval') { res.status(404).send('not found'); return }
    const { diff, version } = await liveDiff(rec)
    res.status(200).send(renderPage(rec.id, tokenOf(req), diff, version))
  }))

  r.post('/confirm/:id/approve', h(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const token = tokenOf(req)
    const rec = load(String(req.params.id), token)
    if (!rec || rec.status !== 'pending_approval') { res.status(404).send('not found'); return }
    const { diff, version } = await liveDiff(rec)
    if (version !== String(req.body?.diff_version)) { res.status(409).send(renderPage(rec.id, token, diff, version, '<p style="color:#b00">目標欄位在你檢視期間被改動,已重新載入最新狀態,請再次確認後批准。</p>')); return }
    // Atomic compare-and-swap: two concurrent approves (double-click / client retry) can both
    // pass the `status === 'pending_approval'` check above (that read is stale by the time we
    // get here, since liveDiff() awaits and yields the event loop). Only the request that wins
    // the pending_approval -> approved transition may proceed to executeChangeSet; the loser gets
    // a 409 and never touches the gateway. This is what guarantees execute-exactly-once.
    const won = deps.changeSets.casStatus(rec.id, 'pending_approval', 'approved', deps.now())
    if (!won) { res.status(409).send('已被處理或已過期'); return }
    // Fix 2: audit the human DECISION itself (governance event "human approved change-set X at
    // T"), separate from the per-item audit rows executeChangeSet writes under tool=
    // 'changeset.execute'. Without this, reject wrote zero audit rows and approve's decision
    // moment had no trail distinct from the resulting writes.
    deps.audit.record({
      userLabel: rec.creatorLabel, sessionId: rec.sessionId,
      clientInfo: 'confirm-page:' + String(req.headers['user-agent'] ?? '').slice(0, 80),
      tool: 'changeset.approve', params: { changeset_id: rec.id, ip: req.ip },
      status: 'ok', traceId: 'n/a', durationMs: 0,
    })
    const out = await executeChangeSet(deps, rec.id)
    res.status(200).send(`<!doctype html><meta charset=utf-8><h1>執行結果:${esc(out.status)}</h1><pre>${esc(JSON.stringify(out.results, null, 2))}</pre>`)
  }))

  r.post('/confirm/:id/reject', h(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const rec = load(String(req.params.id), tokenOf(req))
    if (!rec) { res.status(404).send('not found'); return }
    // Same CAS discipline as approve: only a still-pending change-set can be rejected. Prevents
    // rejecting a change-set that has already been approved/executed (or rejected) concurrently.
    const won = deps.changeSets.casStatus(rec.id, 'pending_approval', 'rejected', deps.now())
    if (!won) { res.status(409).send('已被處理或已過期'); return }
    // Fix 2: same governance-event audit as approve, above.
    deps.audit.record({
      userLabel: rec.creatorLabel, sessionId: rec.sessionId,
      clientInfo: 'confirm-page:' + String(req.headers['user-agent'] ?? '').slice(0, 80),
      tool: 'changeset.reject', params: { changeset_id: rec.id, ip: req.ip },
      status: 'ok', traceId: 'n/a', durationMs: 0,
    })
    res.status(200).send('rejected')
  }))
  return r
}
