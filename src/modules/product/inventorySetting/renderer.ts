import { esc } from '../../../core/changeset/html.js'
import type { ChangeSetRecord, InventoryDiffItem } from '../../../core/changeset/types.js'
import type { ConfirmView } from '../../../core/changeset/module.js'

export function renderConfirm(rec: ChangeSetRecord, diff: InventoryDiffItem[], diffVersion: string, banner: string): ConfirmView {
  const intro = `
<p><strong style="color:#b00">庫存寫入立即影響前台可售並清 cache</strong>;adjust 的目標值以批准當下的即時庫存重算。</p>${banner}`

  const rows = diff.flatMap(item => item.dates.map(d =>
    `<tr><td>${esc(item.item_oid)}/${esc(item.supplier_oid)}</td><td>${esc(d.date)}</td>` +
    `<td>${d.current ?? '?'}</td><td>${item.op === 'adjust' ? (item.quantity > 0 ? '+' : '') + item.quantity : '=' + item.quantity}</td>` +
    `<td>→ ${d.target}</td>` +
    `<td>${d.would_go_negative ? '<strong style="color:#b00">would_go_negative:將被排除,該項結果為 partial</strong>' : d.no_op ? '(無變更)' : ''}</td></tr>`)).join('')
    
  const tableHtml = `<table data-diff-version="${esc(diffVersion)}"><tr><th>item/supplier</th><th>日期</th><th>現量</th><th>op</th><th>目標</th><th></th></tr>${rows}</table>`
  
  return { intro, tableHtml }
}
