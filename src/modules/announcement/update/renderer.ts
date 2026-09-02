import { esc } from '../../../core/changeset/html.js'
import type { ChangeSetRecord, AnnouncementUpdateDiffItem } from '../../../core/changeset/types.js'
import type { ConfirmView } from '../../../core/changeset/module.js'

// 伺服器端雙時區顯示（同 create/renderer.ts；無外部庫、固定 GMT+8）。start/end 存 UTC+0 字串，
// 加 8h 顯示台北時間，避免排程時間看錯。DST 不適用（台北無 DST）。
function dualTz(utcStr: string): string {
  const ms = Date.parse(utcStr.replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return `${utcStr} UTC`
  const l = new Date(ms + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const local = `${l.getUTCFullYear()}-${p(l.getUTCMonth() + 1)}-${p(l.getUTCDate())} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}:${p(l.getUTCSeconds())}`
  return `${utcStr} UTC / ${local} (GMT+8)`
}

function contentBlock(contents: Array<{ lang: string; content: string }>): string {
  return contents.map(c =>
    `<div><strong>${esc(c.lang)}</strong>: <span style="white-space:pre-wrap">${esc(c.content)}</span></div>`).join('')
}

export function renderConfirm(_rec: ChangeSetRecord, diff: AnnouncementUpdateDiffItem[], diffVersion: string, banner: string): ConfirmView {
  const missingEnDefault = diff.some(d => !d.langs.includes('en-default'))
  const enDefaultNote = missingEnDefault
    ? `<p style="color:#b35900">提醒：未含 <code>en-default</code> 語系（en-xx 各語系的 fallback 文案來源）；缺它前台其他 en 語系可能無 fallback 文案。此為提醒、不阻擋批准。</p>`
    : ''
  // full-REPLACE 高風險提醒：PATCH 是整份文件覆蓋（§6.2），非部分合併——被省略的語系等同被清空。
  const intro = `\n<p><strong style="color:#b00">商品公告「更新」會即時對前台顯示，且採整份文件覆蓋（非部分合併）</strong>；請確認新內容與生效時間，未列出的語系將被上面的新內容取代。</p>${enDefaultNote}${banner}`

  const rows = diff.map(d => {
    const prods = d.product_names.length
      ? d.product_names.map(esc).join('、')
      : d.prod_oids.map(esc).join('、')
    const targetTime = esc(dualTz(d.start_time)) + (d.end_time ? '<br>~ ' + esc(dualTz(d.end_time)) : '')
    const beforeBlock = d.current
      ? `<div><small>${d.current.is_enabled ? '啟用' : '停用'} / ${esc(dualTz(d.current.start_time))}` +
        `${d.current.end_time ? '<br>~ ' + esc(dualTz(d.current.end_time)) : ''}</small>` +
        `<div>${contentBlock(d.current.contents)}</div></div>`
      : '<em>現況讀取失敗（未知）</em>'
    const afterBlock = `<div><small>${d.is_enabled ? '啟用' : '停用'} / ${targetTime}</small>` +
      `<div>${contentBlock(d.contents)}</div></div>`
    return `<tr>` +
      `<td>#${esc(String(d.announcementOid))} ${esc(d.name)}</td>` +
      `<td>${prods}<br><small>${d.prod_oids.map(esc).join(',')}</small></td>` +
      `<td>${beforeBlock}</td>` +
      `<td>${afterBlock}</td>` +
      `<td>${d.noop ? '無變更' : '有變更'}</td>` +
      `</tr>`
  }).join('')

  const tableHtml = `<table data-diff-version="${esc(diffVersion)}">` +
    `<tr><th>公告 (oid)</th><th>商品</th><th>現況 before</th><th>更新後 after</th><th>是否變更</th></tr>${rows}</table>`
  return { intro, tableHtml }
}
