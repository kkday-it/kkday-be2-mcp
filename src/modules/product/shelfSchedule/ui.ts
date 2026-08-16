import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../../../core/changeset/module.js'
import { itemKey } from './keys.js'

export const shelfScheduleWizard: WizardDescriptor = {
  label: '批次上架排程設定',
  itemKey,
  step2WarningText: '原排程將被整組取代（reserve_queue 為整組替換、非合併）',
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[] {
    return rows.filter(r => r.checked && !r.is_bundle && (r.queue.length > 0 || r.cleared))
      .map(r => ({ prod_oid: r.prod_oid, pkg_oid: r.pkg_oid, queue: r.queue }))
  },
  renderDiffCard(d: Record<string, unknown>, h: DomHelpers): HTMLElement {
    const card = h.el('div', 'bw-diff-card')
    const title = h.el('div', 'bw-diff-title')
    h.text(title, d.pkg_name ?? d.pkg_oid)
    card.appendChild(title)

    const row = h.el('div', 'bw-diff-row')
    const curSide = h.el('div', 'bw-diff-side')
    h.renderQueueLines(curSide, Array.isArray(d.current_queue) ? d.current_queue : [], '(無排程)')
    const arrow = h.el('span', 'bw-diff-arrow')
    h.text(arrow, '→')
    const newSide = h.el('div', 'bw-diff-side')
    h.renderQueueLines(newSide, Array.isArray(d.new_queue) ? d.new_queue : [])
    row.appendChild(curSide); row.appendChild(arrow); row.appendChild(newSide)
    card.appendChild(row)

    if (d.noop) {
      const noop = h.el('div', 'bw-noop-badge')
      h.text(noop, '此筆現況與目標相同，將不產生實際變更')
      card.appendChild(noop)
    }
    return card
  }
}
