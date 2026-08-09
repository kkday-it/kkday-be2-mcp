import { loadConfig } from '../src/config.js'
import { AuthServiceClient } from '../src/auth/authServiceClient.js'
import { decodeJwtExpMs } from '../src/auth/jwt.js'
import { writeFileSync, mkdirSync } from 'node:fs'

// Probes SIT be2-220 contracts. Manual run only: npm run probe-sit -- <prodOid> [itemOid]
// Prints STRUCTURE (keys/types) to stdout, writes full sanitized bodies to tests/fixtures/.
// NEVER prints or writes token values.

const [prodOid, itemOid] = process.argv.slice(2)
if (!prodOid) { console.error('usage: npm run probe-sit -- <prodOid> [itemOid]'); process.exit(1) }

const cfg = loadConfig()
const auth = new AuthServiceClient({ baseUrl: cfg.authsvcUrl, serviceKey: cfg.serviceKey })

function saveFixture(name: string, body: unknown) {
  mkdirSync('tests/fixtures', { recursive: true })
  const json = JSON.stringify(body, null, 2)
  if (/eyJ[A-Za-z0-9_-]{20,}/.test(json)) throw new Error(`fixture ${name} appears to contain a JWT — refusing to write`)
  writeFileSync(`tests/fixtures/${name}.json`, json)
  console.log(`fixture written: tests/fixtures/${name}.json`)
}

function shape(v: unknown, depth = 0): unknown {
  if (depth > 3) return '...'
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `(+${v.length - 1} more)`] : []
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]))
  return typeof v
}

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
      ['inventory', `/be2/api/v1/product/item/${itemOid}/inventory`],
      ['inventory-status', `/be2/api/v1/product/item/${itemOid}/inventory/status`],
    )
  }
  for (const [name, path] of probes) {
    const { status, body } = await gatewayGet(at, path)
    if (status === 200) { saveFixture(name, body); console.log(JSON.stringify(shape(body), null, 2)) }
    else console.log('  body shape:', JSON.stringify(shape(body)))
  }
}
main().catch(e => { console.error('probe failed:', e.code ?? '', e.message); process.exit(1) })
