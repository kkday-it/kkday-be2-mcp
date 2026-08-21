import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope } from './envelope.js'

// model-visible 入口，開啟公告專用面板（ui://be2/announcement-wizard.html）。prod_oids 僅 prefill，
// 無 scope 權威——§6.2 read-scope gate 只由面板的 app_get_announcement_view server 端讀取滿足。
const inputShape = { prod_oids: z.array(z.string().min(1)).max(10).optional() }

export const openAnnouncementWizardTool: ToolDef<typeof inputShape> = {
  name: 'be2_open_announcement_wizard',
  description:
    'Open the announcement wizard panel to create a product announcement across multiple products in one ' +
    'guided flow (select products -> fill announcement -> approve). prod_oids only prefill the panel; they do ' +
    'NOT satisfy the server-side read-scope gate — only the panel\'s app_get_announcement_view call does. On a ' +
    'host without MCP Apps (e.g. Claude Code), use be2_create_changeset (action_type=announcement) plus the ' +
    'confirm-page flow instead.',
  inputShape,
  uiResourceUri: 'ui://be2/announcement-wizard.html',
  annotations: { title: 'Open announcement wizard', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args) {
    return makeEnvelope([{ prod_oids: args.prod_oids ?? [] }])
  },
}
