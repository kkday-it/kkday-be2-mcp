import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../../../core/changeset/module.js'
import { itemKey } from './keys.js'

export const inventorySettingWizard: WizardDescriptor = {
  label: '批次庫存數量調整',
  schedulable: true,
  step2WarningText: '庫存數量修改立即生效並清除快取、立即影響前台可售；歸零將使該方案前台不可購買。',
  itemKey,
  buildItems(rows: WizardRowInput[]): unknown[] {
    const out: Array<{ item_oid: string; supplier_oid: string; quantity: number }> = []
    for (const r of rows) {
      if (!r.checked || !r.item_oid || !r.supplier_oid || typeof r.quantity !== 'number' || Number.isNaN(r.quantity)) continue
      out.push({ item_oid: r.item_oid, supplier_oid: r.supplier_oid, quantity: r.quantity })
    }
    return out
  },
  renderDiffCard(d: Record<string, unknown>, h: DomHelpers): HTMLElement {
    const card = h.el('div', 'bw-diff-card')
    const title = h.el('div', 'bw-diff-title')
    h.text(title, `${d.item_oid}:${d.supplier_oid}`)
    card.appendChild(title)
    const row = h.el('div', 'bw-diff-row')
    const cur = h.el('span'); h.text(cur, d.current != null ? String(d.current) : '未設')
    const arrow = h.el('span', 'bw-diff-arrow'); h.text(arrow, '→')
    const tgt = h.el('span', 'bw-diff-target'); h.text(tgt, d.target != null ? String(d.target) : '—')
    row.appendChild(cur); row.appendChild(arrow); row.appendChild(tgt)
    card.appendChild(row)
    if (d.no_op) { const n = h.el('div', 'bw-noop-badge'); h.text(n, '此筆現況與目標相同，將不產生實際變更'); card.appendChild(n) }
    return card
  },
}
