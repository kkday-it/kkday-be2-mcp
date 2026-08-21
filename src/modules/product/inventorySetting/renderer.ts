import { esc } from '../../../core/changeset/html.js'
import type { ChangeSetRecord, InventoryDiffItem } from '../../../core/changeset/types.js'
import type { ConfirmView } from '../../../core/changeset/module.js'

export function renderConfirm(rec: ChangeSetRecord, diff: InventoryDiffItem[], diffVersion: string, banner: string): ConfirmView {
  const intro = `
<p><strong style="color:#b00">庫存數量修改立即生效並清除快取、立即影響前台可售；歸零將使該方案前台不可購買。</strong></p>${banner}`
  const rows = diff.map(d =>
    `<tr><td>${esc(d.item_oid)}/${esc(d.supplier_oid)}</td>` +
    `<td>${d.current ?? '未設'}</td><td>→ ${esc(d.target)}</td>` +
    `<td>${d.no_op ? '(無變更)' : ''}</td></tr>`).join('')
  const tableHtml = `<table data-diff-version="${esc(diffVersion)}"><tr><th>item/supplier</th><th>現量(fullday)</th><th>目標</th><th></th></tr>${rows}</table>`
  return { intro, tableHtml }
}
