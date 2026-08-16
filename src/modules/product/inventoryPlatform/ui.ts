import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../../../core/changeset/module.js'
import { itemKey } from './keys.js'

export const inventoryPlatformWizard: WizardDescriptor = {
  label: '批次庫存平台調整',
  itemKey,
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[] {
    const target = opts.target ?? 'BE2'
    const groups = new Map<string, { item_oid: string; supplier_oid: string; target: string; affected_pkgs: Array<{ prod_oid: string; pkg_oid: string; pkg_name: string }> }>()
    for (const r of rows) {
      if (!r.checked || !r.item_oid || !r.supplier_oid) continue
      const key = `${r.item_oid}:${r.supplier_oid}`
      let g = groups.get(key)
      if (!g) { g = { item_oid: r.item_oid, supplier_oid: r.supplier_oid, target, affected_pkgs: [] }; groups.set(key, g) }
      g.affected_pkgs.push({ prod_oid: r.prod_oid, pkg_oid: r.pkg_oid, pkg_name: r.pkg_name })
    }
    return [...groups.values()]
  },
  renderDiffCard(d: Record<string, unknown>, h: DomHelpers): HTMLElement {
    const card = h.el('div', 'bw-diff-card')
    const affected = Array.isArray(d.affected_pkgs) ? (d.affected_pkgs as any[]) : []
    const title = h.el('div', 'bw-diff-title')
    h.text(title, affected.length ? affected.map(p => p.pkg_name).join('、') : `${d.item_oid}:${d.supplier_oid}`)
    card.appendChild(title)

    const row = h.el('div', 'bw-diff-row')
    const curSpan = h.el('span')
    h.text(curSpan, d.current != null ? String(d.current) : '—')
    const arrow = h.el('span', 'bw-diff-arrow')
    h.text(arrow, '→')
    const targetSpan = h.el('span', 'bw-diff-target')
    h.text(targetSpan, d.target != null ? String(d.target) : '—')
    row.appendChild(curSpan); row.appendChild(arrow); row.appendChild(targetSpan)
    card.appendChild(row)

    if (d.noop) {
      const noop = h.el('div', 'bw-noop-badge')
      h.text(noop, '此筆現況與目標相同，將不產生實際變更')
      card.appendChild(noop)
    }
    return card
  }
}
