import { esc } from '../../../core/changeset/html.js'
import type { ChangeSetRecord, ShelfScheduleDiffItem, ScheduleEntry } from '../../../changeset/types.js'
import type { ConfirmView } from '../../../core/changeset/module.js'

export function renderConfirm(rec: ChangeSetRecord, diff: ShelfScheduleDiffItem[], diffVersion: string, banner: string): ConfirmView {
  const intro = `
<p><strong style="color:#b00">原排程將被整組取代(reserve_queue 為整組替換、非合併);以下時間皆為 UTC</strong>,由 be2 原生排程到點自動執行(我方不建 scheduler)。</p>${banner}`

  const fmtQueue = (q: ScheduleEntry[]) => q.length
    ? q.map(e => `${esc(e.reserve_date_utc)} UTC → ${e.reserve_status ? '上架' : '下架'}`).join('<br>')
    : '(空,將清除排程)'
  const rows = diff.map(item =>
    `<tr><td>${esc(item.pkg_name)}</td><td>${esc(item.prod_oid)}/${esc(item.pkg_oid)}</td>` +
    `<td>${fmtQueue(item.current_queue)}</td><td>${fmtQueue(item.new_queue)}</td>` +
    `<td>${item.noop ? '(無變更)' : ''}</td></tr>`).join('')
    
  const tableHtml = `<table data-diff-version="${esc(diffVersion)}"><tr><th>方案</th><th>oid</th><th>現有排程</th><th>新排程</th><th></th></tr>${rows}</table>`
  
  return { intro, tableHtml }
}
