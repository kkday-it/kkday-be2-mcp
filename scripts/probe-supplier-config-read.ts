import { loadConfig } from '../src/config.js'
import { AuthServiceClient } from '../src/auth/authServiceClient.js'
import { writeFileSync, mkdirSync } from 'node:fs'

// Probes SIT be2-220: item-level READ endpoint for the two inventory-platform booleans
// (is_external_inventory, is_inventory_mgmt), keyed by (item_oid, supplier_oid).
// Phase 4a Task 1 — see docs/superpowers/plans/2026-08-14-be2-mcp-baa-wizard.md Task 1
// and docs/superpowers/specs/2026-08-14-be2-mcp-baa-wizard-design.md §4.1.
//
// Manual run only: npx tsx --env-file=.env scripts/probe-supplier-config-read.ts [prodOid]
// Read-only, fully reversible (no PUT/write of any kind). NEVER prints or writes token values.
//
// Resolves a non-bundle plan's item_oid/supplier_oid via
// GET /product/api/v1/products/{prodOid}/packages?locale=zh-tw&show_supplier=1, then tries
// three read candidates in priority order for the two booleans:
//   1. GET items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting
//   2. GET items/{itemOid}/supplier-configs/{supplierOid}
//   3. GET items/{itemOid}/supplier-mappings (known 200 from Phase 4a design; check element shape)

const prodOid = process.argv[2] ?? '34133'
const cfg = loadConfig()
const auth = new AuthServiceClient({ baseUrl: cfg.authsvcUrl, serviceKey: cfg.serviceKey })

function shape(v: unknown, depth = 0): unknown {
  if (depth > 5) return '...'
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `(+${v.length - 1} more)`] : []
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]))
  return typeof v
}

function saveFixture(name: string, body: unknown) {
  mkdirSync('tests/fixtures', { recursive: true })
  // Save UNWRAPPED, matching what GatewayClient.get() actually hands to tools (body.data ?? body).
  const unwrapped = (body as { data?: unknown })?.data ?? body
  const json = JSON.stringify(unwrapped, null, 2)
  if (/eyJ[A-Za-z0-9_-]{20,}/.test(json)) throw new Error(`fixture ${name} appears to contain a JWT — refusing to write`)
  writeFileSync(`tests/fixtures/${name}.json`, json)
  console.log(`fixture written: tests/fixtures/${name}.json`)
}

async function gatewayGet(accessToken: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${cfg.gatewayUrl}${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'x-auth-id': 'be2' },
  })
  const body = await res.json().catch(() => ({}))
  console.log(`GET ${path} -> ${res.status}`)
  return { status: res.status, body }
}

function unwrap(body: unknown): unknown {
  return (body as { data?: unknown })?.data ?? body
}

function hasBothBooleans(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.is_external_inventory === 'boolean' && typeof o.is_inventory_mgmt === 'boolean'
}

async function main() {
  const { authorizationCode } = await auth.login(process.env.AUTH_email!, process.env.AUTH_pwd!)
  const tokens = await auth.exchangeCode(authorizationCode)
  const at = tokens.accessToken
  console.log('login+exchange OK')

  // 1) packages?show_supplier=1 — resolve a non-bundle item_oid/supplier_oid + record full field shape.
  const pkgPath = `/product/api/v1/products/${prodOid}/packages?locale=zh-tw&show_supplier=1`
  const pkgRes = await gatewayGet(at, pkgPath)
  if (pkgRes.status !== 200) {
    console.log('BLOCKED: packages?show_supplier=1 did not return 200 — cannot resolve item_oid/supplier_oid.')
    console.log('  body shape:', JSON.stringify(shape(pkgRes.body)))
    return
  }
  const pkgBody = unwrap(pkgRes.body)
  saveFixture('packages-show-supplier', pkgBody)
  console.log('packages?show_supplier=1 field shape (sanitized, values masked by type):')
  console.log(JSON.stringify(shape(pkgBody), null, 2))

  const packages = (Array.isArray(pkgBody) ? pkgBody : ((pkgBody as { packages?: unknown[] })?.packages ?? [])) as Array<Record<string, unknown>>
  const candidate = packages.find(p => p.is_bundle !== true)
  if (!candidate) {
    console.log('BLOCKED: no non-bundle package found in packages response — cannot resolve item_oid/supplier_oid.')
    return
  }

  const itemOid = candidate.item_oid as string | number | undefined
  // Supplier info shape under show_supplier=1 is unknown ahead of time — try common shapes defensively.
  // CONFIRMED (this probe, be2-220): the field is `supplier_mapping` (array of {supplier_oid, supplier_name, is_default, ...}).
  const supplierList =
    (candidate.supplier_mapping as Array<{ supplier_oid?: string | number; is_default?: boolean }> | undefined) ??
    (candidate.suppliers as Array<{ supplier_oid?: string | number; is_default?: boolean }> | undefined)
  const supplierOid =
    (candidate.supplier_oid as string | number | undefined) ??
    (candidate.supplier as { supplier_oid?: string | number } | undefined)?.supplier_oid ??
    supplierList?.find(s => s.is_default)?.supplier_oid ??
    supplierList?.[0]?.supplier_oid

  console.log(`resolved candidate: pkg_oid=${candidate.pkg_oid} item_oid=${itemOid} supplier_oid=${supplierOid}`)
  if (!itemOid) {
    console.log('BLOCKED: could not resolve item_oid from packages response.')
    return
  }
  if (supplierOid === undefined) {
    console.log('WARNING: could not resolve supplier_oid from packages response — supplier-scoped candidates (#1, #2) will be skipped.')
  }

  const results: Array<{ name: string; path: string; status: number; hasBooleans: boolean }> = []

  if (supplierOid !== undefined) {
    const p1 = `/product/api/v1/items/${itemOid}/supplier-configs/${supplierOid}/inventory-setting`
    const r1 = await gatewayGet(at, p1)
    const b1 = unwrap(r1.body)
    if (r1.status === 200) { saveFixture('supplier-config-inventory-setting', b1); console.log(JSON.stringify(shape(b1), null, 2)) }
    else console.log('  body shape:', JSON.stringify(shape(r1.body)))
    results.push({ name: 'supplier-configs/{supplierOid}/inventory-setting', path: p1, status: r1.status, hasBooleans: hasBothBooleans(b1) })

    const p2 = `/product/api/v1/items/${itemOid}/supplier-configs/${supplierOid}`
    const r2 = await gatewayGet(at, p2)
    const b2 = unwrap(r2.body)
    if (r2.status === 200) { saveFixture('supplier-config', b2); console.log(JSON.stringify(shape(b2), null, 2)) }
    else console.log('  body shape:', JSON.stringify(shape(r2.body)))
    results.push({ name: 'supplier-configs/{supplierOid}', path: p2, status: r2.status, hasBooleans: hasBothBooleans(b2) })
  }

  const p3 = `/product/api/v1/items/${itemOid}/supplier-mappings`
  const r3 = await gatewayGet(at, p3)
  const b3 = unwrap(r3.body)
  if (r3.status === 200) { saveFixture('supplier-mappings', b3); console.log(JSON.stringify(shape(b3), null, 2)) }
  else console.log('  body shape:', JSON.stringify(shape(r3.body)))
  // supplier-mappings returns an array of supplier entries — check each element for the two booleans.
  const mappingEl = Array.isArray(b3) ? b3.find(el => hasBothBooleans(el)) ?? b3[0] : b3
  results.push({ name: 'supplier-mappings', path: p3, status: r3.status, hasBooleans: hasBothBooleans(mappingEl) })

  console.log('\n=== SUMMARY ===')
  for (const r of results) console.log(`${r.status}${r.hasBooleans ? ' [HAS is_external_inventory + is_inventory_mgmt]' : ''}  ${r.name}`)
  if (!results.some(r => r.hasBooleans)) {
    console.log('\nBLOCKED: no candidate returned both is_external_inventory and is_inventory_mgmt.')
    console.log('Record all statuses/shapes in docs/be2-mcp/sit-write-contracts.md — do NOT assume defaults (spec §4.1 DiffError path).')
  } else {
    console.log('\nDECIDED: use the first [HAS ...] candidate above as readSupplierInventorySetting() source (Task 3).')
  }
}
main().catch(e => { console.error('probe failed:', e.code ?? '', e.message); process.exit(1) })
