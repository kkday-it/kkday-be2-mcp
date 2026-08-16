import { esc } from '../../../core/changeset/html.js'
import type { ChangeSetRecord, InventoryPlatformDiffItem } from '../../../changeset/types.js'
import type { ConfirmView } from '../../../core/changeset/module.js'

export function renderConfirm(rec: ChangeSetRecord, diff: InventoryPlatformDiffItem[], diffVersion: string, banner: string): ConfirmView {
  const intro = `${banner}
<p>方案名稱為 be2 內容(untrusted),請以 oid 為準核對。寫入單位是 item_oid×supplier_oid,方案清單僅為受影響範圍展示。</p>`

  const rows = diff.map(d => {
    const pkgNames = d.affected_pkgs.map(p => esc(p.pkg_name)).join(', ') || '(無)'
    const unverified = d.affected_pkgs_unverified ? ' <em>(未經伺服器驗證)</em>' : ''
    return `<tr><td>${esc(d.item_oid)}/${esc(d.supplier_oid)}</td><td>${esc(d.current)}</td><td>→ ${esc(d.target)}</td><td>${esc(pkgNames)}${unverified}</td><td>${d.noop ? '(無變更)' : ''}</td></tr>`
  }).join('')
  
  const tableHtml = `<table data-diff-version="${esc(diffVersion)}"><tr><th>item/supplier</th><th>現況</th><th>目標</th><th>受影響方案</th><th></th></tr>${rows}</table>`
  
  return { intro, tableHtml }
}
