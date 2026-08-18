import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope } from './envelope.js'

// Task 6 (design doc §5.5): model-visible entry point that opens the batch wizard panel
// (ui://be2/batch-wizard.html, built in Task 7 — the resource does not exist yet; that is fine,
// registerAppResources (src/server/appResources.ts) skips-and-warns on a missing file rather than
// failing, same as every other panel-backed tool before its panel existed). Deliberately NOT
// added to src/server/appResources.ts's PANELS array yet — that would make the (as-yet-absent)
// dist/ui/batch-wizard.html file load-bearing for this tool's own tests/build, which Task 7 alone
// should introduce.
//
// prod_oids here are PANEL PREFILL ONLY — they carry no scope authority. The §6.2 read-scope
// gate that be2_create_changeset's SCOPE_NOT_READ check enforces is satisfied ONLY by the
// server-side reads app_get_batch_view performs once the panel actually loads those oids; passing
// prod_oids to this tool records nothing into ReadOidStore.
const inputShape = {
  action_type: z.enum(['inventory_platform', 'shelf_schedule']),
  prod_oids: z.array(z.string().min(1)).max(10).optional(),
}

export const openBatchWizardTool: ToolDef<typeof inputShape> = {
  name: 'be2_open_batch_wizard',
  description:
    'Open the batch wizard panel to stage inventory_platform (switch which platform manages inventory: ' +
    'BE2/BE2_SCM/EXTERNAL) or shelf_schedule (reserve-date on/off-shelf schedule) changes across multiple ' +
    'products and plans in one guided flow. prod_oids only prefill the panel selection — they do NOT ' +
    'satisfy the server-side read-scope gate; only the panel\'s own app_get_batch_view call (server-side ' +
    'reads) establishes that. On a host that does not support MCP Apps (e.g. Claude Code), this tool cannot ' +
    'render a panel — use be2_create_changeset plus the confirm-page flow instead.',
  inputShape,
  uiResourceUri: 'ui://be2/batch-wizard.html',
  annotations: {
    title: 'Open batch wizard',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  async handler(args) {
    return makeEnvelope([{ action_type: args.action_type, prod_oids: args.prod_oids ?? [] }])
  },
}
