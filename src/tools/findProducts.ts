import { z } from 'zod'
import type { ToolDef, ToolContext } from './types.js'
import { makeEnvelope, toEnvelopeError, type EnvelopeError } from './envelope.js'

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
  prod_oids: z.array(z.string().min(1)).min(1).max(20)
    .describe('be2 product oids to look up (exact match, max 20 per call)'),
}

async function lookupOne(oid: string, ctx: ToolContext): Promise<{ item?: unknown; error?: EnvelopeError }> {
  const [info, sw] = await Promise.allSettled([
    ctx.gateway.get(`/product/api/v1/drafts/products/${encodeURIComponent(oid)}/info`, ctx.accessToken),
    ctx.gateway.get(`/product/api/v1/product-configs/${encodeURIComponent(oid)}/switch`, ctx.accessToken),
  ])
  if (info.status === 'rejected' && sw.status === 'rejected') return { error: toEnvelopeError(oid, info.reason) }
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
    'keyword search is NOT supported in this phase. Per-oid failures are reported in `errors` without failing the batch.',
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
    // Max 5 oids in flight (2 requests each) — never burst the gateway with 40 concurrent GETs.
    const results: Array<{ item?: unknown; error?: EnvelopeError }> = []
    const oids: string[] = args.prod_oids
    for (let i = 0; i < oids.length; i += 5) {
      results.push(...await Promise.all(oids.slice(i, i + 5).map(oid => lookupOne(oid, ctx))))
    }
    return makeEnvelope(
      results.filter(r => r.item).map(r => r.item),
      results.filter(r => r.error).map(r => r.error!),
      results.filter(r => r.item).map(r => (r.item as { prod_oid: string }).prod_oid),
    )
  },
}
