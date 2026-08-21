import { esc } from '../../../core/changeset/html.js'
import type { ChangeSetRecord, AnnouncementDiffItem } from '../../../core/changeset/types.js'
import type { ConfirmView } from '../../../core/changeset/module.js'

// 伺服器端雙時區顯示（無外部庫、固定 GMT+8；be2 operator 多在台北）。start/end 存 UTC+0 字串，
// 加 8h 顯示台北時間，避免排程時間看錯（spec §5.7/§10「時間雙時區」）。DST 不適用（台北無 DST）。
function dualTz(utcStr: string): string {
  const ms = Date.parse(utcStr.replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return `${utcStr} UTC`
  const l = new Date(ms + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const local = `${l.getUTCFullYear()}-${p(l.getUTCMonth() + 1)}-${p(l.getUTCDate())} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}:${p(l.getUTCSeconds())}`
  return `${utcStr} UTC / ${local} (GMT+8)`
}

export function renderConfirm(_rec: ChangeSetRecord, diff: AnnouncementDiffItem[], diffVersion: string, banner: string): ConfirmView {
  // en-default 是 en-xx 各語系的 fallback 文案來源（spec §5.3 假設#4「建議存在，warn 不 block」）。
  // 缺它不擋批准，但在確認頁（人工批准當下）出一則非阻擋提醒——這是「warn」最該被看到的地方。
  const missingEnDefault = diff.some(d => !d.langs.includes('en-default'))
  const enDefaultNote = missingEnDefault
    ? `<p style="color:#b35900">提醒：未含 <code>en-default</code> 語系（en-xx 各語系的 fallback 文案來源）；缺它前台其他 en 語系可能無 fallback 文案。此為提醒、不阻擋批准。</p>`
    : ''
  const intro = `\n<p><strong style="color:#b00">商品公告會即時對前台顯示</strong>;請確認內容與生效時間。</p>${enDefaultNote}${banner}`

  const rows = diff.map(d => {
    const prods = d.product_names.length
      ? d.product_names.map(esc).join('、')
      : d.prod_oids.map(esc).join('、')
    const existing = d.existing_count == null ? '未知' : String(d.existing_count)
    const time = esc(dualTz(d.start_time)) + (d.end_time ? '<br>~ ' + esc(dualTz(d.end_time)) : '')
    // per-lang 內文預覽（untrusted → esc；換行保留）。
    const contentPreview = d.contents.map(c =>
      `<div><strong>${esc(c.lang)}</strong>: <span style="white-space:pre-wrap">${esc(c.content)}</span></div>`).join('')
    return `<tr>` +
      `<td>${esc(d.name)}</td>` +
      `<td>${prods}<br><small>${d.prod_oids.map(esc).join(',')}</small></td>` +
      `<td>${d.is_enabled ? '啟用' : '停用'}</td>` +
      `<td>${time}</td>` +
      `<td>${d.langs.map(esc).join(', ')}</td>` +
      `<td>${contentPreview}</td>` +
      `<td>${existing}</td>` +
      `</tr>`
  }).join('')

  const tableHtml = `<table data-diff-version="${esc(diffVersion)}">` +
    `<tr><th>公告</th><th>商品</th><th>狀態</th><th>生效時間</th><th>語系</th><th>內文預覽</th><th>既有公告數</th></tr>${rows}</table>`
  return { intro, tableHtml }
}
