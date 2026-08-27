import { describe, it, expect } from 'vitest'
import '../src/core/changeset/diff.js'
import { shelfTogglePlanWizard } from '../src/modules/product/shelfToggle/ui.js'

function fakeDom() {
  const h = {
    el: (tag: string, cls?: string) => { const n: any = { tag, cls, children: [] as any[], txt: '' }; n.appendChild = (c: any) => n.children.push(c); return n },
    text: (n: any, v: unknown) => { n.txt = String(v) },
    renderQueueLines: () => {},
  }
  return h as any
}

describe('shelfTogglePlanWizard', () => {
  it('buildItems: target=off → target_is_active false，只收 checked', () => {
    const items = shelfTogglePlanWizard.buildItems(
      [{ checked: true, is_bundle: false, prod_oid: '1', pkg_oid: 'a', pkg_name: 'A', queue: [], cleared: false },
       { checked: false, is_bundle: false, prod_oid: '1', pkg_oid: 'b', pkg_name: 'B', queue: [], cleared: false }] as never,
      { target: 'off' })
    expect(items).toEqual([{ prod_oid: '1', pkg_oid: 'a', target_is_active: false }])
  })
  it('renderDiffCard: 顯示方案名與目標', () => {
    const card = shelfTogglePlanWizard.renderDiffCard({ prod_oid: '1', pkg_oid: 'a', pkg_name: 'A方案', current_is_active: true, target_is_active: false } as never, fakeDom())
    expect(JSON.stringify(card)).toContain('A方案')
  })
})
