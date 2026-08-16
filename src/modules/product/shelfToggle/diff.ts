import type { ToolContext } from '../../../tools/types.js'
import { findProductsTool } from '../../../tools/findProducts.js'
import { productPlansTool } from '../../../tools/productPlans.js'
import type { ActionType, ChangeSetItem, DiffItem } from '../../../core/changeset/types.js'
import { DiffError } from '../../../core/changeset/diff.js'

export async function computeShelfDiff(actionType: Exclude<ActionType, 'inventory_setting'>, items: ChangeSetItem[], ctx: ToolContext): Promise<DiffItem[]> {
  if (actionType === 'shelf_toggle_product') {
    const oids = [...new Set(items.map(i => i.prod_oid))]
    const env = await findProductsTool.handler({ prod_oids: oids }, ctx)
    if (env.errors.length) throw new DiffError(env.errors.map(e => e.key), `could not read products: ${env.errors.map(e => `${e.key}(${e.code ?? e.status ?? 'err'})`).join(', ')}`)
    const byOid = new Map((env.items as Array<{ prod_oid: string; name?: string; is_active?: boolean }>).map(p => [p.prod_oid, p]))
    const unresolved = items.filter(i => byOid.get(i.prod_oid)?.is_active === undefined).map(i => i.prod_oid)
    if (unresolved.length) throw new DiffError(unresolved, `no current shelf state for: ${unresolved.join(', ')}`)
    return items.map(i => {
      const cur = byOid.get(i.prod_oid)!
      return { prod_oid: i.prod_oid, name: cur.name, current_is_active: cur.is_active,
        target_is_active: i.target_is_active, no_op: cur.is_active === i.target_is_active }
    })
  }
  // shelf_toggle_plan: group by prod_oid, one productPlansTool call each
  const out: DiffItem[] = []
  for (const oid of [...new Set(items.map(i => i.prod_oid))]) {
    const env = await productPlansTool.handler({ prod_oid: oid }, ctx)
    if (env.errors.length) throw new DiffError(env.errors.map(e => e.key), `could not read plans for ${oid}: ${env.errors.map(e => e.code ?? e.status ?? 'err').join(', ')}`)
    const byPkg = new Map((env.items as Array<{ pkg_oid: string; name?: string; is_active?: boolean }>).map(p => [p.pkg_oid, p]))
    for (const i of items.filter(x => x.prod_oid === oid)) {
      const cur = byPkg.get(i.pkg_oid!)
      if (!cur || cur.is_active === undefined) throw new DiffError([`${oid}:${i.pkg_oid}`], `plan ${i.pkg_oid} not found under product ${oid}`)
      out.push({ prod_oid: oid, pkg_oid: i.pkg_oid, name: cur.name, current_is_active: cur.is_active,
        target_is_active: i.target_is_active, no_op: cur.is_active === i.target_is_active })
    }
  }
  return out
}
