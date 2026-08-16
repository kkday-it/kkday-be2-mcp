import { esc } from '../../../core/changeset/html.js'
import type { ChangeSetRecord, DiffItem } from '../../../changeset/types.js'
import type { ConfirmView } from '../../../core/changeset/module.js'

export function renderConfirm(rec: ChangeSetRecord, diff: DiffItem[], diffVersion: string, banner: string): ConfirmView {
  const intro = `${banner}
<p>名稱為 be2 內容(untrusted),請以 oid 為準核對。</p>`

  const rows = diff.map(d => `<tr><td>${esc(d.name ?? d.pkg_oid ?? d.prod_oid)}</td><td>${esc(d.prod_oid)}${d.pkg_oid ? '/' + esc(d.pkg_oid) : ''}</td><td>${d.current_is_active === undefined ? '?' : d.current_is_active ? '上架' : '下架'}</td><td>→ ${d.target_is_active ? '上架' : '下架'}</td><td>${d.no_op ? '(無變更)' : ''}</td></tr>`).join('')
  const tableHtml = `<table data-diff-version="${esc(diffVersion)}"><tr><th>名稱</th><th>oid</th><th>現況</th><th>目標</th><th></th></tr>${rows}</table>`

  return { intro, tableHtml }
}
