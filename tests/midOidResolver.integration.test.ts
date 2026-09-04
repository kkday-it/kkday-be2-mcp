import { describe, it, expect } from 'vitest'
import { productPlansTool } from '../src/tools/productPlans.js'
import { findProductsTool } from '../src/tools/findProducts.js'
import { GatewayClient } from '../src/gateway/client.js'
import { loadConfig } from '../src/config.js'
import type { ToolContext } from '../src/tools/types.js'

// Live SIT be2-220 integration tests for the mid→oid resolver (Task 7 / spec §8 "整合測試").
//
// Gated on APP_LIVE_BEARER — a real be2 access token, valid on the target gateway (default
// be2-220), for an account with read access to the fixture product below. This var is NEVER set
// in CI, so this whole describe block SKIPS (0 run, not failed) in every automated run — same
// convention as this repo's other live-only verification, which runs as a manual, documented,
// out-of-band step rather than inline in `npm run ci` (see scripts/live-4a-acceptance.ts and
// docs/be2-mcp/sit-write-contracts.md).
//
// Fixture: the known old-product mid/oid pair recorded in docs/be2-mcp/sit-write-contracts.md
// "## mid→oid resolver fixture" (spec §2.3 candidate: mid-10759 -> oid 38352). That doc section
// also flags this pair as UNVERIFIED live as of this task — running this file with a real bearer
// is exactly how a human closes that PENDING item. Do NOT swap in a coincidental-equality product
// (mid == oid, e.g. 2358) — the resolver not being wired up would pass unnoticed against those.
const KNOWN_MID = process.env.APP_LIVE_MID_FIXTURE ?? '10759'
const KNOWN_OID = process.env.APP_LIVE_OID_FIXTURE ?? '38352'

function liveCtx(): ToolContext {
  const cfg = loadConfig()
  return {
    accessToken: process.env.APP_LIVE_BEARER!, traceId: 'liveinteg'.padEnd(32, '0'),
    userLabel: process.env.APP_LIVE_USER_LABEL ?? 'live-integration-test',
    gateway: new GatewayClient({ baseUrl: cfg.gatewayUrl }),
  }
}

describe.skipIf(!process.env.APP_LIVE_BEARER)('live SIT: mid→oid resolver integration', () => {
  // 整合 11:用 prod_mid 呼叫 get_product_plans,底層確實查 canonical oid。
  it('live: prod_mid 解析後查到 canonical oid 的方案資料', async () => {
    const env = await productPlansTool.handler({ prod_mid: KNOWN_MID } as never, liveCtx())
    expect(env.resolved_ids?.[0]).toMatchObject({ mid: KNOWN_MID, oid: KNOWN_OID })
    expect(env.read_oids).toContain(KNOWN_OID)
  })

  // 整合 12:把 mid 誤當 prod_oid 丟給 find_products → errors 含對稱提示。
  it('live: mid 誤當 prod_oid → 錯誤訊息含 prod_mid 提示', async () => {
    const env = await findProductsTool.handler({ prod_oids: [KNOWN_MID] } as never, liveCtx())
    expect(env.errors.some(e => (e.message ?? '').includes('prod_mid'))).toBe(true)
  })
})
