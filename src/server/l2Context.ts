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
  genToken: () => string
  now: () => number
}

export interface L2ToolDef {
  name: string
  description: string
  inputShape: z.ZodRawShape
  handler(args: any, ctx: L2ToolContext): Promise<Envelope>
}
