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
// read candidates for the two booleans (live results on be2-220, 2026-08-14):
//   1. GET items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting   → 404 (route not registered)
//   2. GET items/{itemOid}/supplier-configs/{supplierOid}                      → 404 (route not registered)
//   3. GET items/{itemOid}/supplier-mappings                                   → 200 but no booleans
//   4. GET items/{itemOid}/configs  ← the SOURCE OF TRUTH (product-service; supplier_configs[]
//      carries the two booleans per supplier — verified through the be2-web UI chain:
//      EditDetail.vue activeItemSupplierConfigMappingList ← item_config.supplier_configs ←
//      be2-api ProductApiService::getItemConfig → product-service items/{itemOid}/configs).
//      Live: 403 on be2-220 for this account (gateway/verify per-URI deny, empty body — same
//      class as the Phase 3a quantity-PUT AU9403 blocker; works via stage / 220 grant).
//   5. GET /be2/api/v1/product/item/{itemOid}/inventory[?supplier_oid=] and
//      GET /be2/api/v1/product/item/{itemOid}/inventory/basic-info  ← be2-web's actual routes
//      (aggregate #4 + supplier-mappings + spec). Live: systematic 500 on be2-220
//      («Trying to access array offset on value of type null», status 9999) — the same
//      be2-api-prefix inventory 500s documented since Phase 1a. NOT account-specific.

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

  // 4) product-service items/{itemOid}/configs — the SOURCE OF TRUTH for the two booleans
  //    (supplier_configs[] per-supplier rows; inventory_setting at item level). be2-api reads
  //    this S2S and be2-web renders supplier_configs[].{is_external_inventory,is_inventory_mgmt}.
  //    Expect 403 on be2-220 for this account (verify per-URI deny); 200 where authorized.
  const pCfg = `/product/api/v1/items/${itemOid}/configs`
  const rCfg = await gatewayGet(at, pCfg)
  const bCfg = unwrap(rCfg.body) as Record<string, unknown> | null
  if (rCfg.status === 200) {
    saveFixture('item-configs', bCfg)
    console.log(JSON.stringify(shape(bCfg), null, 2))
    const scs = bCfg?.supplier_configs as Array<Record<string, unknown>> | undefined
    if (scs?.length) {
      const sanitized = Object.fromEntries(Object.entries(scs[0]).map(([k, v]) =>
        [k, typeof v === 'boolean' || /oid/i.test(k) || v === null ? v : shape(v)]))
      console.log('supplier_configs[0] sanitized:', JSON.stringify(sanitized, null, 2))
    }
    const scRow = scs?.find(el => hasBothBooleans(el)) ?? scs?.[0]
    results.push({ name: 'items/{itemOid}/configs → supplier_configs[]', path: pCfg, status: rCfg.status, hasBooleans: hasBothBooleans(scRow) })
  } else {
    console.log('  body shape:', JSON.stringify(shape(rCfg.body)))
    results.push({ name: 'items/{itemOid}/configs', path: pCfg, status: rCfg.status, hasBooleans: false })
  }

  // 5) be2-api-prefixed inventory reads — the endpoints be2-web's inventory page ACTUALLY calls
  //    (kkday-be2-web: store/modules/product/inventory/editDetail.js requestGetInventory /
  //     requestGetInventoryBasicInfo → apis/product/*.js). Expected data:
  //    inventory:   { item_inventory: {..is_inventory_mgmt, inventory_setting..}, item_supplier_mapping, ... }
  //    basic-info:  { item_config: { inventory_setting, supplier_configs[] }, item_supplier_mapping, ... }
  const be2Paths: Array<[string, string]> = [
    ['be2 item/{itemOid}/inventory', `/be2/api/v1/product/item/${itemOid}/inventory`],
    ['be2 item/{itemOid}/inventory/basic-info', `/be2/api/v1/product/item/${itemOid}/inventory/basic-info`],
  ]
  if (supplierOid !== undefined) {
    be2Paths.push(['be2 item/{itemOid}/inventory?supplier_oid', `/be2/api/v1/product/item/${itemOid}/inventory?supplier_oid=${supplierOid}`])
  }
  for (const [name, p4] of be2Paths) {
    const r4 = await gatewayGet(at, p4)
    const b4 = unwrap(r4.body) as Record<string, unknown> | null
    if (r4.status !== 200) {
      console.log('  body shape:', JSON.stringify(shape(r4.body)))
      results.push({ name, path: p4, status: r4.status, hasBooleans: false })
      continue
    }
    if (name.endsWith('/inventory')) saveFixture('be2-item-inventory', b4)
    console.log(JSON.stringify(shape(b4), null, 2))
    const itemInv = b4?.item_inventory as Record<string, unknown> | undefined
    const itemCfg = b4?.item_config as Record<string, unknown> | undefined
    const supplierCfgs = itemCfg?.supplier_configs as Array<Record<string, unknown>> | undefined
    const mappings = b4?.item_supplier_mapping as Array<Record<string, unknown>> | undefined
    console.log('item_inventory keys:', itemInv ? JSON.stringify(Object.keys(itemInv)) : '(absent)')
    for (const [label, rows] of [['item_supplier_mapping', mappings], ['item_config.supplier_configs', supplierCfgs]] as const) {
      if (!rows?.length) continue
      console.log(`${label}[0] keys:`, JSON.stringify(Object.keys(rows[0])))
      // Sanitized values: booleans and oids are printable; everything else masked by type.
      const sanitized = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) =>
        [k, typeof v === 'boolean' || /oid/i.test(k) || v === null ? v : shape(v)]))
      console.log(`${label}[0] sanitized:`, JSON.stringify(sanitized, null, 2))
    }
    const perSupplier = [...(supplierCfgs ?? []), ...(mappings ?? [])].find(el => hasBothBooleans(el))
    results.push({ name: `${name} → per-supplier rows`, path: p4, status: r4.status, hasBooleans: hasBothBooleans(perSupplier) })
    if (itemInv) results.push({ name: `${name} → item_inventory`, path: p4, status: r4.status, hasBooleans: hasBothBooleans(itemInv) })
  }

  console.log('\n=== SUMMARY ===')
  for (const r of results) console.log(`${r.status}${r.hasBooleans ? ' [HAS is_external_inventory + is_inventory_mgmt]' : ''}  ${r.name}`)
  if (!results.some(r => r.hasBooleans)) {
    console.log('\nNo candidate returned a live 200 with both booleans on this env/account.')
    console.log('Contract-level verdict (source-verified, see sit-write-contracts.md §inventory-platform read):')
    console.log('  readSupplierInventorySetting() = GET items/{itemOid}/configs → supplier_configs[]')
    console.log('  (403 here = per-env verify authz, same unblock path as the Phase 3a quantity-PUT blocker.)')
    console.log('Do NOT assume defaults when the read fails — spec §4.1 DiffError path.')
  } else {
    console.log('\nDECIDED: use the first [HAS ...] candidate above as readSupplierInventorySetting() source (Task 3).')
  }
}
main().catch(e => { console.error('probe failed:', e.code ?? '', e.message); process.exit(1) })
