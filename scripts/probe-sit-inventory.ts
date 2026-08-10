import { loadConfig } from '../src/config.js'
import { AuthServiceClient } from '../src/auth/authServiceClient.js'
import { writeFileSync, mkdirSync } from 'node:fs'

// Manual only: npm run probe-sit-inventory -- <itemOid> <supplierOid> [yearMonth]
// Answers spec §8 Q1–Q8 for the per-date inventory quantity write. REVERSIBLE:
// reads a future date's quantity, writes +1, verifies, restores the original.
// NEVER prints or writes token values.
const [itemOid, supplierOid, yearMonthArg] = process.argv.slice(2)
if (!itemOid || !supplierOid) { console.error('usage: npm run probe-sit-inventory -- <itemOid> <supplierOid> [yearMonth]'); process.exit(1) }
const cfg = loadConfig()
const auth = new AuthServiceClient({ baseUrl: cfg.authsvcUrl, serviceKey: cfg.serviceKey })

function decodeJwtClaims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
}
function save(name: string, body: unknown) {
  mkdirSync('tests/fixtures', { recursive: true })
  const json = JSON.stringify(body, null, 2)
  if (/eyJ[A-Za-z0-9_-]{20,}/.test(json)) throw new Error(`fixture ${name} contains a JWT — refusing`)
  writeFileSync(`tests/fixtures/${name}.json`, json)
  console.log(`fixture: tests/fixtures/${name}.json`)
}
async function gw(at: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${cfg.gatewayUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${at}`, accept: 'application/json', 'x-auth-id': 'be2', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  console.log(`${method} ${path} -> ${res.status}`)
  return { status: res.status, body: (j as { data?: unknown }).data ?? j }
}

async function main() {
  const { authorizationCode } = await auth.login(process.env.AUTH_email!, process.env.AUTH_pwd!)
  const tokens = await auth.exchangeCode(authorizationCode)
  const at = tokens.accessToken
  const claims = decodeJwtClaims(at)
  console.log('modify_user candidate (platformId):', JSON.stringify(claims.platformId))

  // Open #3: the REAL businessList action code for inventory (grep, don't guess)
  const invCodes = (tokens.businessList as unknown[])
    .map(b => (typeof b === 'string' ? b : (b as { action?: string; code?: string }).action ?? (b as { code?: string }).code))
    .filter(c => typeof c === 'string' && /invent/i.test(c))
  console.log('businessList inventory-related codes:', JSON.stringify(invCodes))

  // Q5 baseline: status flags BEFORE any write
  const st0 = await gw(at, 'GET', `/product/api/v1/items/${itemOid}/inventories/status`)
  console.log('status before:', JSON.stringify(st0.body))

  // Q1/Q4/Q6: real quantities GET shape (never observed — every Phase 1a supplier read 403'd)
  const ym = yearMonthArg ?? new Date().toISOString().slice(0, 7)
  const q = await gw(at, 'GET', `/product/api/v1/items/${itemOid}/inventories/${supplierOid}?year_month=${ym}`)
  if (q.status !== 200) { console.log('BLOCKED: quantities read denied — record blocker in sit-write-contracts.md and stop.'); return }
  save('inventory-quantities', q.body)
  console.log('RECORD Q1/Q4/Q6: full GET shape above — which field is the writable per-date quantity (total vs remaining)? is quantity per sku?')

  // Q2/Q3/Q7: REVERSIBLE write — echo the FULL month payload back, bump ONE future date by +1
  console.log('\n=== reversible write probe: PUT items/{itemOid}/inventories (candidate endpoint) ===')
  console.log('Manually inspect the GET body printed above, then edit the block below ONCE the row/field')
  console.log('names are known — first run is read-only discovery; second run does the +1/restore cycle:')
  console.log(`  1. clone GET body; find the row for a FUTURE date; +1 its quantity field`)
  console.log(`  2. PUT /product/api/v1/items/${itemOid}/inventories with { <cloned+bumped month payload>, modify_user: platformId }`)
  console.log(`  3. re-GET: did unmentioned dates survive (merge vs replace)? did the bump land? re-check /status (is_processing => async, poll until false and time it)`)
  console.log(`  4. PUT the original payload back (restore); re-GET to verify`)
  console.log(`  5. retry step 2 with a MINIMAL body (only the bumped date row) — accepted? other dates wiped? => merge-vs-replace verdict`)
  console.log(`  6. try a payload spanning two months — accepted? => cross-month verdict; try >62 dates => cap`)
  console.log('RECORD every answer in docs/be2-mcp/sit-write-contracts.md §inventory (Q1–Q8 of spec §8).')
}
main().catch(e => { console.error('probe failed:', (e as { code?: string }).code ?? '', (e as Error).message); process.exit(1) })
