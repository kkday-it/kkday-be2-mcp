import { loadConfig } from '../src/config.js'
import { AuthServiceClient } from '../src/auth/authServiceClient.js'
import { decodeJwtExpMs } from '../src/auth/jwt.js'
import { writeFileSync, mkdirSync } from 'node:fs'

// Manual only: npm run probe-sit-write -- <managedProdOid> [pkgOid]
// Resolves modify_user, merge-vs-replace, required fields, gateway-403 behavior.
// NEVER prints or writes token values. Does a REVERSIBLE toggle then restores.
const [prodOid, pkgOid] = process.argv.slice(2)
if (!prodOid) { console.error('usage: npm run probe-sit-write -- <managedProdOid> [pkgOid]'); process.exit(1) }
const cfg = loadConfig()
const auth = new AuthServiceClient({ baseUrl: cfg.authsvcUrl, serviceKey: cfg.serviceKey })

function decodeJwtClaims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
}
function save(name: string, body: unknown) {
  mkdirSync('tests/fixtures/write', { recursive: true })
  const json = JSON.stringify(body, null, 2)
  if (/eyJ[A-Za-z0-9_-]{20,}/.test(json)) throw new Error(`fixture ${name} contains a JWT — refusing`)
  writeFileSync(`tests/fixtures/write/${name}.json`, json)
  console.log(`fixture: tests/fixtures/write/${name}.json`)
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
  // Open #1: candidate modify_user values from JWT claims (print keys only, not the token)
  const claims = decodeJwtClaims(at)
  console.log('JWT claim candidates for modify_user:',
    JSON.stringify({ authKey: claims.authKey, subAuthOid: claims.subAuthOid, platformId: claims.platformId }))
  console.log('access exp (min):', Math.round((decodeJwtExpMs(at) - Date.now()) / 60000))

  // Read current state (diff baseline) — product + plan
  const sw = await gw(at, 'GET', `/product/api/v1/product-configs/${prodOid}/switch`)
  if (sw.status === 200) save('product-switch', sw.body)
  const cfgs = await gw(at, 'GET', `/product/api/v1/products/${prodOid}/package-configs`)
  if (cfgs.status === 200) save('package-configs', cfgs.body)

  console.log('\n=== Open #2/#3/#5: REVERSIBLE plan toggle, preserving each pkg\'s FULL config object ===')
  if (pkgOid && cfgs.status === 200) {
    // The GET body's per-pkg objects may carry MORE than is_active (reserve settings etc.).
    // Read-merge-write MUST preserve those. Build config_data from the FULL per-pkg objects,
    // flipping only pkgOid's is_active — do NOT strip to {is_active}. This probe's job is to
    // discover (a) the exact accepted PUT body shape, (b) whether unmentioned pkgs are preserved,
    // (c) whether echoing full per-pkg objects 400s on any read-only field.
    const arr = (Array.isArray(cfgs.body) ? cfgs.body : (cfgs.body as { config_data?: unknown[] }).config_data) as Array<Record<string, unknown>>
    console.log('current package-configs raw per-pkg keys:', JSON.stringify(Object.keys(arr[0] ?? {})))
    const buildConfigData = (flip: string, val: boolean) => {
      const cd: Record<string, Record<string, unknown>> = {}
      for (const p of arr) { const k = String(p.pkg_oid); cd[k] = { ...p }; delete cd[k].pkg_oid; if (k === flip) cd[k].is_active = val }
      return cd
    }
    const original = !!arr.find(p => String(p.pkg_oid) === pkgOid)?.is_active
    for (const mu of [claims.authKey, claims.subAuthOid, claims.platformId]) {
      const r = await gw(at, 'PUT', `/product/api/v1/products/${prodOid}/package-configs`, { config_data: buildConfigData(pkgOid, !original), modify_user: mu })
      console.log(`  PUT full-object config_data, modify_user=${JSON.stringify(mu)} -> ${r.status}`, JSON.stringify(r.body).slice(0, 200))
      if (r.status === 200) {
        const after = await gw(at, 'GET', `/product/api/v1/products/${prodOid}/package-configs`)
        console.log('  after: other pkgs preserved? full shape:', JSON.stringify(after.body).slice(0, 400))
        await gw(at, 'PUT', `/product/api/v1/products/${prodOid}/package-configs`, { config_data: buildConfigData(pkgOid, original), modify_user: mu })
        console.log('  restored. RECORD: does config_data need full per-pkg objects or only {is_active}? merge or replace? which read-only fields (if any) had to be dropped?')
        break
      }
    }
  } else {
    console.log('  (skipped — pass a pkgOid and use a MANAGED product with plans)')
  }
  console.log('\n=== product switch: probe writable vs read-only fields ===')
  if (sw.status === 200) {
    const body = sw.body as Record<string, unknown>
    console.log('  switch raw keys:', JSON.stringify(Object.keys(body)), '(is_locked_for_active is READ-ONLY — expect it must be dropped from PUT)')
    console.log('  RECORD: minimal accepted PUT body for /switch (is_active + modify_user + which other writable fields?), merge vs replace.')
  }
}
main().catch(e => { console.error('probe failed:', e.code ?? '', e.message); process.exit(1) })
