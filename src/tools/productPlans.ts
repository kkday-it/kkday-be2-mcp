import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope, toEnvelopeError, toEnvelopeErrorWithMidHint } from './envelope.js'
import { resolveProdOid } from '../gateway/prodOidResolver.js'

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
  prod_mid: z.string().min(1).optional()
    .describe('be2-web URL product number (mid). Provide this OR prod_oid — pick whichever you have.'),
  prod_oid: z.string().min(1).optional()
    .describe('be2 product internal oid whose plans (packages) to list.'),
}

export const productPlansTool: ToolDef<typeof inputShape> = {
  name: 'be2_get_product_plans',
  description:
    'List a be2 product\'s plans (packages) with each plan\'s on/off-shelf state: pkg_oid, item_oid, plan name, is_active. ' +
    'Read-only, no side effects. Use to inspect plan-level shelf status before/without any change. ' +
    'When asked about multiple products, call this for each prod_oid, then combine results into a single markdown table (columns: prod_oid, plan name, pkg_oid, is_active). Note that bundle plans cannot be scheduled individually. After presenting, ask the user which plans to modify; do not guess.',
  inputShape,
  uiResourceUri: 'ui://be2/products-panel.html',
  annotations: {
    title: 'Get product plans',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(args, ctx) {
    if (!args.prod_mid && !args.prod_oid) {
      return makeEnvelope([], [{ key: 'input', code: 'MISSING_ID', message: 'Provide prod_mid or prod_oid.' }])
    }
    let canonical = args.prod_oid
    let resolvedIds: Array<{ mid: string; oid: string }> | undefined
    if (args.prod_mid) {
      try {
        const r = await resolveProdOid(args.prod_mid, ctx.gateway, ctx.accessToken)
        // 兩者都給時驗證一致,不悄悄以其中一個為準。
        if (canonical && canonical !== r) {
          return makeEnvelope([], [{ key: 'input', code: 'MID_OID_MISMATCH',
            message: `prod_mid ${args.prod_mid} resolves to oid ${r}, which conflicts with prod_oid ${canonical}.` }])
        }
        canonical = r
        resolvedIds = [{ mid: args.prod_mid, oid: r }]
      } catch (e) {
        return makeEnvelope([], [toEnvelopeError(args.prod_mid, e)])
      }
    }
    // 僅在使用者確實用 prod_oid 欄位查詢(非 mid)時,對商品查詢 404 附「你可能誤用 mid」提示。
    const fatalErr = (args.prod_oid && !args.prod_mid) ? toEnvelopeErrorWithMidHint : toEnvelopeError
    const oid = encodeURIComponent(canonical!)
    const [pkgsResult, cfgResult] = await Promise.allSettled([
      ctx.gateway.get(`/product/api/v1/drafts/products/${oid}/packages`, ctx.accessToken),
      ctx.gateway.get(`/product/api/v1/products/${oid}/package-configs`, ctx.accessToken),
    ])
    if (pkgsResult.status === 'rejected') {
      return makeEnvelope([], [fatalErr(canonical!, pkgsResult.reason)])
    }
    const cfg = cfgResult.status === 'fulfilled' ? normalizePackageConfigs(cfgResult.value) : new Map()
    const items = extractPackages(pkgsResult.value).map(p => ({
      pkg_oid: p.pkg_oid, item_oid: p.item_oid, name: p.name,
      is_active: cfg.get(p.pkg_oid)?.is_active,
    }))
    const readOids = [canonical!, ...items.flatMap(i => [i.pkg_oid, i.item_oid].filter((x): x is string => !!x))]
    const errors = cfgResult.status === 'rejected' ? [toEnvelopeError(canonical!, cfgResult.reason)] : []
    return makeEnvelope(items, errors, readOids, resolvedIds)
  },
}
