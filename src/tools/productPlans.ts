import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope, toEnvelopeError } from './envelope.js'

export function normalizePackageConfigs(raw: unknown): Map<string, { is_active?: boolean }> {
  const map = new Map<string, { is_active?: boolean }>()
  const r = raw as Record<string, any>
  const cd = r?.config_data ?? r
  if (Array.isArray(cd)) {
    for (const row of cd) if (row?.pkg_oid) map.set(String(row.pkg_oid), { is_active: row.is_active })
  } else if (cd && typeof cd === 'object') {
    for (const [k, v] of Object.entries(cd)) {
      if (v && typeof v === 'object' && 'is_active' in (v as object)) map.set(k, { is_active: (v as any).is_active })
    }
  }
  return map
}

function extractPackages(raw: unknown): Array<{ pkg_oid: string; item_oid?: string; name?: string }> {
  const list = Array.isArray(raw) ? raw : (raw as Record<string, any>)?.packages ?? (raw as Record<string, any>)?.data ?? []
  return (list as any[]).filter(p => p?.pkg_oid).map(p => ({
    pkg_oid: String(p.pkg_oid),
    item_oid: p.item_oid ? String(p.item_oid) : undefined,
    // Real SIT shape (drafts/products/{oid}/packages) uses `pkg_name`; `name` kept as a fallback.
    name: typeof p.pkg_name === 'string' ? p.pkg_name : (typeof p.name === 'string' ? p.name : undefined),
  }))
}

const inputShape = {
  prod_oid: z.string().min(1).describe('be2 product oid whose plans (packages) to list'),
}

export const productPlansTool: ToolDef<typeof inputShape> = {
  name: 'be2_get_product_plans',
  description:
    'List a be2 product\'s plans (packages) with each plan\'s on/off-shelf state: pkg_oid, item_oid, plan name, is_active. ' +
    'Read-only, no side effects. Use to inspect plan-level shelf status before/without any change.',
  inputShape,
  uiResourceUri: 'ui://be2/products-panel.html',
  async handler(args, ctx) {
    const oid = encodeURIComponent(args.prod_oid)
    const [pkgsResult, cfgResult] = await Promise.allSettled([
      ctx.gateway.get(`/product/api/v1/drafts/products/${oid}/packages`, ctx.accessToken),
      ctx.gateway.get(`/product/api/v1/products/${oid}/package-configs`, ctx.accessToken),
    ])
    if (pkgsResult.status === 'rejected') {
      return makeEnvelope([], [toEnvelopeError(args.prod_oid, pkgsResult.reason)])
    }
    const cfg = cfgResult.status === 'fulfilled' ? normalizePackageConfigs(cfgResult.value) : new Map()
    const items = extractPackages(pkgsResult.value).map(p => ({
      pkg_oid: p.pkg_oid, item_oid: p.item_oid, name: p.name,
      is_active: cfg.get(p.pkg_oid)?.is_active,
    }))
    const readOids = [args.prod_oid, ...items.flatMap(i => [i.pkg_oid, i.item_oid].filter((x): x is string => !!x))]
    const errors = cfgResult.status === 'rejected' ? [toEnvelopeError(args.prod_oid, cfgResult.reason)] : []
    return makeEnvelope(items, errors, readOids)
  },
}
