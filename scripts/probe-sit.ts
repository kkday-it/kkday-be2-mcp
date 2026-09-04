import { loadConfig } from '../src/config.js'
import { AuthServiceClient } from '../src/auth/authServiceClient.js'
import { decodeJwtExpMs } from '../src/auth/jwt.js'
import { saveFixture, shape } from './probeShared.js'

// Probes SIT be2-220 contracts. Manual run only: npm run probe-sit -- <prodOid> [itemOid]
// Prints STRUCTURE (keys/types) to stdout, writes full sanitized bodies to tests/fixtures/.
// NEVER prints or writes token values.

const [prodOid, itemOid] = process.argv.slice(2)
if (!prodOid) { console.error('usage: npm run probe-sit -- <prodOid> [itemOid]'); process.exit(1) }

const cfg = loadConfig()
const auth = new AuthServiceClient({ baseUrl: cfg.authsvcUrl, serviceKey: cfg.serviceKey })

// Save UNWRAPPED, matching what GatewayClient.get() actually hands to tools (body.data ?? body).
const save = (name: string, body: unknown) =>
  saveFixture(`${name}.json`, (body as { data?: unknown })?.data ?? body)

async function gatewayGet(accessToken: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${cfg.gatewayUrl}${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'x-auth-id': 'be2' },
  })
  const body = await res.json().catch(() => ({}))
  console.log(`GET ${path} -> ${res.status}`)
  return { status: res.status, body }
}

async function main() {
  // 1) login — expect possible CSRF block (web middleware). Record the outcome either way.
  let tokens
  const code = process.env.PROBE_AUTH_CODE // fallback: paste code from browser POPUP login
  if (code) {
    tokens = await auth.exchangeCode(code)
  } else {
    const { authorizationCode } = await auth.login(process.env.AUTH_email!, process.env.AUTH_pwd!)
    console.log('login OK (headless REST worked — no CSRF block)')
    tokens = await auth.exchangeCode(authorizationCode)
  }
  console.log('exchange OK; businessList length:', (tokens.businessList as unknown[]).length)
  console.log('access exp (min from now):', Math.round((decodeJwtExpMs(tokens.accessToken) - Date.now()) / 60000))

  // 2) refresh — verify rotation + fresh businessList
  const rotated = await auth.refresh(tokens.refreshToken)
  console.log('refresh OK; rotated:', rotated.refreshToken !== tokens.refreshToken)
  const at = rotated.accessToken

  // 3) product-service prefix reads
  const probes: Array<[string, string]> = [
    ['product-info', `/product/api/v1/drafts/products/${prodOid}/info`],
    ['product-switch', `/product/api/v1/product-configs/${prodOid}/switch`],
    ['packages', `/product/api/v1/drafts/products/${prodOid}/packages`],
    ['package-configs', `/product/api/v1/products/${prodOid}/package-configs`],
  ]
  if (itemOid) {
    probes.push(
      ['inventory-status', `/product/api/v1/items/${itemOid}/inventories/status`],
    )
  }
  for (const [name, path] of probes) {
    const { status, body } = await gatewayGet(at, path)
    if (status === 200) { save(name, body); console.log(JSON.stringify(shape(body, 0, 3), null, 2)) }
    else console.log('  body shape:', JSON.stringify(shape(body, 0, 3)))
  }
}
main().catch(e => { console.error('probe failed:', e.code ?? '', e.message); process.exit(1) })
