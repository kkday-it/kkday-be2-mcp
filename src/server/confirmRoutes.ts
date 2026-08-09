import express from 'express'
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
  function load(id: string, token: string) {
    const rec = deps.changeSets.get(id)
    if (!rec || rec.approvalTokenHash !== ChangeSetStore.hashToken(token)) return undefined
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
    deps.changeSets.setStatus(rec.id, 'approved', deps.now())
    const out = await executeChangeSet(deps, rec.id)
    res.status(200).send(`<!doctype html><meta charset=utf-8><h1>執行結果:${esc(out.status)}</h1><pre>${esc(JSON.stringify(out.results, null, 2))}</pre>`)
  }))

  r.post('/confirm/:id/reject', h(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const rec = load(String(req.params.id), tokenOf(req))
    if (!rec) { res.status(404).send('not found'); return }
    deps.changeSets.setStatus(rec.id, 'rejected', deps.now())
    res.status(200).send('rejected')
  }))
  return r
}
