import type { z } from 'zod'
import type { GatewayClient } from '../gateway/client.js'
import type { ReadOidStore } from '../store/readOidStore.js'
import type { ChangeSetStore } from '../changeset/store.js'
import type { RateBudget } from '../limits/rateBudget.js'
import type { Envelope } from '../tools/envelope.js'

// L2 (change-set) tools need more than the L0 read ToolContext (src/tools/types.ts):
// the read-oid scope substrate, the change-set store, the rate budget, and the bits
// needed to mint a confirm_url. Identity (userLabel/sessionId/bearerHash) still comes
// from the token only — never from tool input.
export interface L2ToolContext {
  gateway: GatewayClient
  accessToken: string
  userLabel: string
  sessionId: string
  bearerHash: string
  businessList: unknown[]
  readOids: ReadOidStore
  changeSets: ChangeSetStore
  rateBudget: RateBudget
  baseUrl: string // for confirm_url, e.g. http://127.0.0.1:8787
  genId: () => string
  now: () => number
  // Delivers the confirm_url OUT-OF-BAND to a human — never through the tool response, which
  // lands in the model's context. In Claude Code the agent also has Bash/curl on loopback, so
  // returning a clickable link in-band would let it try to self-approve by curling the confirm
  // route itself; app.ts wires this to the be2-mcp server's own stdout (the terminal the human
  // runs `npm run dev` in). The URL itself carries no secret (Phase 2b: approval is gated by a
  // be2-auth SSO session cookie on the confirm page, not a capability token in the URL) — the
  // out-of-band delivery is defense in depth, not the security boundary.
  emitConfirmUrl: (changesetId: string, url: string) => void
}

export interface L2ToolDef {
  name: string
  description: string
  inputShape: z.ZodRawShape
  uiResourceUri?: string // 有值 → 走 registerAppTool，面板綁此 ui:// 資源
  outputShape?: z.ZodRawShape // structuredContent 的 outputSchema（MCP 規範需宣告）
  handler(args: any, ctx: L2ToolContext): Promise<Envelope>
}
