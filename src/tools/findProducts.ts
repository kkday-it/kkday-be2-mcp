import { z } from 'zod'
import type { ToolDef, ToolContext } from './types.js'
import { makeEnvelope, toEnvelopeError, toEnvelopeErrorWithMidHint, type EnvelopeError } from './envelope.js'
import { resolveProdOids } from '../gateway/prodOidResolver.js'

// Adjust extraction against tests/fixtures/product-info.json (Task 4). Defensive
// fallback chain covers documented shape: name lives in description_module[master_lang].
export function extractProductInfo(raw: unknown): { name?: string; workflow_status?: string } {
  const r = raw as Record<string, any>
  const dm = r?.description_module ?? r?.product?.description_module
  const master = r?.master_lang ?? r?.product?.master_lang
  let name: string | undefined = typeof r?.name === 'string' ? r.name : undefined
  if (!name && dm && typeof dm === 'object') {
    const entry = (master && dm[master]) || Object.values(dm)[0]
    if (entry && typeof (entry as any).name === 'string') name = (entry as any).name
  }
  return { name, workflow_status: r?.workflow_status ?? r?.product?.workflow_status }
}

const inputShape = {
  prod_mids: z.array(z.string().min(1)).max(20).optional()
    .describe('be2-web URL product numbers (mid). Resolved to canonical oid and merged with prod_oids.'),
  prod_oids: z.array(z.string().min(1)).max(20).optional()
    .describe('be2 product internal oids to look up (exact match). Provide prod_mids and/or prod_oids, ≥1 total.'),
}

async function lookupOne(oid: string, ctx: ToolContext, fromMid: boolean): Promise<{ item?: unknown; error?: EnvelopeError }> {
  const [info, sw] = await Promise.allSettled([
    ctx.gateway.get(`/product/api/v1/drafts/products/${encodeURIComponent(oid)}/info`, ctx.accessToken),
    ctx.gateway.get(`/product/api/v1/product-configs/${encodeURIComponent(oid)}/switch`, ctx.accessToken),
  ])
  if (info.status === 'rejected' && sw.status === 'rejected') {
    // 原始 prod_oid 輸入的 404 → 附 mid 提示;mid 解析出的 oid → 普通錯誤(使用者本來就用 mid 欄位)。
    const errFn = fromMid ? toEnvelopeError : toEnvelopeErrorWithMidHint
    return { error: errFn(oid, info.reason) }
  }
  const base = info.status === 'fulfilled' ? extractProductInfo(info.value) : {}
  const swVal = sw.status === 'fulfilled' ? (sw.value as Record<string, unknown>) : {}
  return {
    item: {
      prod_oid: oid,
      name: base.name,
      workflow_status: base.workflow_status,
      is_active: swVal.is_active,
      is_locked_for_active: swVal.is_locked_for_active,
    },
  }
}

export const findProductsTool: ToolDef<typeof inputShape> = {
  name: 'be2_find_products',
  description:
    'Look up be2 products by exact prod_oid list (max 20): returns each product\'s name, workflow status, ' +
    'and on/off-shelf state (is_active). Read-only, no side effects. Use when the user gives product oids; ' +
    'keyword search is NOT supported in this phase. Per-oid failures are reported in `errors` without failing the batch. ' +
    'Accepts prod_mids (be2-web URL numbers) and/or prod_oids.',
  inputShape,
  uiResourceUri: 'ui://be2/products-panel.html',
  annotations: {
    title: 'Find products',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(args, ctx) {
    const { resolved, resolutions, errors: resolveErrors } =
      await resolveProdOids(args.prod_mids ?? [], args.prod_oids ?? [], ctx.gateway, ctx.accessToken)
    if (resolved.length === 0 && resolveErrors.length === 0) {
      return makeEnvelope([], [{ key: 'input', code: 'MISSING_ID', message: 'Provide prod_mids or prod_oids (≥1 total).' }])
    }
    const midOids = new Set(resolutions.map(r => r.oid))
    // Max 5 oids in flight (2 requests each) — never burst the gateway with 40 concurrent GETs.
    const results: Array<{ item?: unknown; error?: EnvelopeError }> = []
    for (let i = 0; i < resolved.length; i += 5) {
      results.push(...await Promise.all(resolved.slice(i, i + 5).map(oid => lookupOne(oid, ctx, midOids.has(oid)))))
    }
    return makeEnvelope(
      results.filter(r => r.item).map(r => r.item),
      [...resolveErrors, ...results.filter(r => r.error).map(r => r.error!)],
      results.filter(r => r.item).map(r => (r.item as { prod_oid: string }).prod_oid),
      resolutions,
    )
  },
}
