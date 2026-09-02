import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope } from './envelope.js'
import { resolveProdOids } from '../gateway/prodOidResolver.js'

const inputShape = {
  feature: z.enum(['shelf', 'inventory', 'announce']).optional(),
  prod_mids: z.array(z.string().min(1)).max(20).optional(),
  prod_oids: z.array(z.string().min(1)).max(20).optional(),
}

export const openWorkbenchTool: ToolDef<typeof inputShape> = {
  name: 'be2_open_workbench',
  description:
    'Open the be2 workbench panel — the single consolidated surface for three product batch tasks: ' +
    '商品上下架 (shelf on/off for products/plans/bundles + reserve-date schedule), 商品庫存 (per-date quantity + platform switch), ' +
    '商品公告 (create multi-locale announcement). Pick a feature from the left nav; no need to switch tools. ' +
    'feature/prod_oids only prefill the panel — they do NOT satisfy the server-side read-scope gate; only the panel\'s own ' +
    'app_get_batch_view / app_get_announcement_view calls establish that. On a host without MCP Apps (e.g. Claude Code), ' +
    'this cannot render a panel — use be2_create_changeset plus the confirm-page flow instead.',
  inputShape,
  uiResourceUri: 'ui://be2/workbench.html',
  annotations: { title: 'Open be2 workbench', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const mids = args.prod_mids ?? []
    const oids = args.prod_oids ?? []
    if (mids.length === 0 && oids.length === 0) return makeEnvelope([{ feature: args.feature ?? null, prod_oids: [] }])
    const { resolved, resolutions, errors } = await resolveProdOids(mids, oids, ctx.gateway, ctx.accessToken)
    return makeEnvelope([{ feature: args.feature ?? null, prod_oids: resolved }], errors, [], resolutions)
  },
}
