import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../../../core/changeset/module.js'
import { itemKey } from './keys.js'

export const shelfToggleBundleWizard: WizardDescriptor = {
  label: '批次套裝上下架',
  itemKey,
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[] {
    const active = opts.target === 'on'
    return rows.filter(r => r.checked && r.is_bundle && r.pkg_oid)
      .map(r => ({ prod_oid: r.prod_oid, bundle_pkg_oid: r.pkg_oid, target_is_active: active }))
  },
  renderDiffCard(d: Record<string, unknown>, h: DomHelpers): HTMLElement {
    const card = h.el('div', 'bw-diff-card')
    const title = h.el('div', 'bw-diff-title'); h.text(title, (d.bundle_pkg_oid as string) ?? (d.prod_oid as string))
    card.appendChild(title)
    const row = h.el('div', 'bw-diff-row')
    const cur = h.el('span'); h.text(cur, d.current_is_active == null ? '—' : (d.current_is_active ? '上架' : '下架'))
    const arrow = h.el('span', 'bw-diff-arrow'); h.text(arrow, '→')
    const tgt = h.el('span', 'bw-diff-target'); h.text(tgt, d.target_is_active ? '上架' : '下架')
    row.appendChild(cur); row.appendChild(arrow); row.appendChild(tgt); card.appendChild(row)
    return card
  },
}
