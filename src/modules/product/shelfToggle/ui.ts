import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../../../core/changeset/module.js'
import { itemKey } from './keys.js'

function renderShelfCard(d: Record<string, unknown>, h: DomHelpers): HTMLElement {
  const card = h.el('div', 'bw-diff-card')
  const title = h.el('div', 'bw-diff-title')
  h.text(title, (d.pkg_name as string) ?? (d.prod_oid as string))
  card.appendChild(title)
  const row = h.el('div', 'bw-diff-row')
  const cur = h.el('span'); h.text(cur, d.current_is_active == null ? '—' : (d.current_is_active ? '上架' : '下架'))
  const arrow = h.el('span', 'bw-diff-arrow'); h.text(arrow, '→')
  const tgt = h.el('span', 'bw-diff-target'); h.text(tgt, d.target_is_active ? '上架' : '下架')
  row.appendChild(cur); row.appendChild(arrow); row.appendChild(tgt)
  card.appendChild(row)
  return card
}

export const shelfToggleProductWizard: WizardDescriptor = {
  label: '批次商品上下架',
  itemKey,
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[] {
    const active = opts.target === 'on'
    // product 層：以 prod_oid 去重；rows 需帶 is_bundle=false 且無 pkg（或標記 product-level）
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const r of rows) {
      if (!r.checked) continue
      if (r.pkg_oid) continue          // 只收商品層（無 pkg）
      if (seen.has(r.prod_oid)) continue
      seen.add(r.prod_oid)
      out.push({ prod_oid: r.prod_oid, target_is_active: active })
    }
    return out
  },
  renderDiffCard: renderShelfCard,
}

export const shelfTogglePlanWizard: WizardDescriptor = {
  label: '批次方案上下架',
  itemKey,
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[] {
    const active = opts.target === 'on'
    return rows.filter(r => r.checked && r.pkg_oid && !r.is_bundle).map(r => ({ prod_oid: r.prod_oid, pkg_oid: r.pkg_oid, target_is_active: active }))
  },
  renderDiffCard: renderShelfCard,
}
