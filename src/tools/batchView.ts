import type { GatewayClient } from '../gateway/client.js'
import { extractProductInfo } from './findProducts.js'
import { booleansToPlatform } from '../changeset/batchValidate.js'
import { sanitizeQueue } from '../changeset/batchValidate.js'
import type { ScheduleEntry } from '../changeset/types.js'
import { toEnvelopeError, type EnvelopeError } from './envelope.js'

export type BatchViewActionType = 'inventory_platform' | 'shelf_schedule'

export interface BatchPlan {
  pkg_oid: string
  name?: string
  item_oid?: string
  supplier_oid?: string
  supplier_name?: string
  is_active?: boolean
  is_bundle?: boolean
  current_platform?: 'BE2' | 'BE2_SCM' | 'EXTERNAL' | null
  reserve_queue?: ScheduleEntry[]
}

export interface BatchProduct {
  prod_oid: string
  name?: string
  not_found?: boolean
  plans: BatchPlan[]
}

export interface BatchViewResult {
  products: BatchProduct[]
  errors: EnvelopeError[]
  read_oids: string[]
}

// docs/be2-mcp/sit-write-contracts.md Phase 4a Task 1 §"packages?show_supplier=1 完整欄位形狀":
// supplier info lives under `supplier_mapping[]` (NOT `supplier`/`suppliers`); the response may
// be missing `is_bundle` entirely (defensive: absent -> treated as "unknown", not "false" — the
// authoritative is_bundle source is package-configs below, merged in by pkg_oid).
// Exported (final whole-branch review Important 3): src/changeset/platformDiff.ts reuses this
// exact parser to recompute affected_pkgs server-side — same wire-shape knowledge (supplier info
// under supplier_mapping[], is_bundle possibly absent), one implementation instead of a
// hand-copied second parser that could silently drift from this one.
export function extractPackagesWithSupplier(raw: unknown): Array<{
  pkg_oid: string; name?: string; item_oid?: string; is_active?: boolean; supplier_oid?: string; supplier_name?: string
}> {
  const list = Array.isArray(raw) ? raw : (raw as Record<string, any>)?.data ?? (raw as Record<string, any>)?.packages ?? []
  return (list as any[]).filter(p => p?.pkg_oid != null).map(p => {
    const mapping = Array.isArray(p.supplier_mapping) ? (p.supplier_mapping as any[]) : []
    const dflt = mapping.find(m => m?.is_default === true) ?? mapping[0]
    return {
      pkg_oid: String(p.pkg_oid),
      name: typeof p.pkg_name === 'string' ? p.pkg_name : (typeof p.name === 'string' ? p.name : undefined),
      item_oid: p.item_oid != null ? String(p.item_oid) : undefined,
      is_active: typeof p.is_active === 'boolean' ? p.is_active : undefined,
      supplier_oid: dflt?.supplier_oid != null ? String(dflt.supplier_oid) : undefined,
      supplier_name: typeof dflt?.supplier_name === 'string' ? dflt.supplier_name : undefined,
    }
  })
}

interface PackageConfigRow { is_active?: boolean; is_bundle?: boolean; reserve_queue: ScheduleEntry[] }

// GET /product/api/v1/products/{prodOid}/package-configs -> array (design doc §4.2 / scheduleDiff.ts
// already established this shape). Authoritative source for is_bundle and reserve_queue; also
// carries is_active, preferred over the packages endpoint's copy when present.
function extractPackageConfigMap(raw: unknown): Map<string, PackageConfigRow> {
  const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
  const map = new Map<string, PackageConfigRow>()
  for (const row of rows) {
    if (row?.pkg_oid == null) continue
    map.set(String(row.pkg_oid), {
      is_active: typeof row.is_active === 'boolean' ? row.is_active : undefined,
      is_bundle: typeof row.is_bundle === 'boolean' ? row.is_bundle : undefined,
      reserve_queue: sanitizeQueue((row.reserve_queue as Array<{ reserve_date?: unknown; reserve_status?: unknown }>) ?? []),
    })
  }
  return map
}

// Per docs/be2-mcp/sit-write-contracts.md §"定案:兩布林的 wire 來源" (also src/changeset/
// platformDiff.ts#readSupplierInventorySetting): GET items/{itemOid}/configs -> supplier_configs[]
// carries {supplier_oid, is_external_inventory, is_inventory_mgmt} per supplier. Unlike the
// change-set diff path (which throws DiffError on any read failure — 嚴禁盲寫), this is a
// best-effort DISPLAY read for the wizard's step-1 view: a 403/500/missing-row here degrades to
// current_platform: null + a warning entry, never blocks the rest of the batch view (spec: "view
// 是展示用途,不是 diff;diff 那條已在 Task 3 fail-closed,view 不需要擋死整個載入").
async function getConfigsCached(
  gateway: GatewayClient, accessToken: string, itemOid: string, cache: Map<string, Promise<unknown>>,
): Promise<unknown> {
  let p = cache.get(itemOid)
  if (!p) {
    p = gateway.get(`/product/api/v1/items/${encodeURIComponent(itemOid)}/configs`, accessToken)
    cache.set(itemOid, p)
  }
  return p
}

async function resolveCurrentPlatform(
  gateway: GatewayClient, accessToken: string, itemOid: string, supplierOid: string, cache: Map<string, Promise<unknown>>,
): Promise<{ platform: 'BE2' | 'BE2_SCM' | 'EXTERNAL' | null; warning?: EnvelopeError }> {
  const key = `${itemOid}:${supplierOid}`
  try {
    const raw = await getConfigsCached(gateway, accessToken, itemOid, cache)
    const rows = (raw as { supplier_configs?: unknown[] })?.supplier_configs
    const row = Array.isArray(rows)
      ? (rows as Array<Record<string, unknown>>).find(r => String(r?.supplier_oid) === supplierOid)
      : undefined
    const isExternal = row?.is_external_inventory
    const isMgmt = row?.is_inventory_mgmt
    if (typeof isExternal !== 'boolean' || typeof isMgmt !== 'boolean') {
      return {
        platform: null,
        warning: { key, code: 'PLATFORM_READ_UNAVAILABLE', message: `current inventory-platform config not readable for ${key}; shown as unknown (view is display-only, not a diff).` },
      }
    }
    const platform = booleansToPlatform({ is_external_inventory: isExternal, is_inventory_mgmt: isMgmt }) ?? null
    return { platform }
  } catch (e) {
    return { platform: null, warning: toEnvelopeError(key, e) }
  }
}

// design doc §5.1 / .superpowers/sdd/task-5-brief.md. One product at a time (allSettled would
// obscure per-product errors' association with the plans that DID load), but bounded to ≤10
// prod_oids by the tool's zod inputShape.
export async function buildBatchView(
  gateway: GatewayClient, accessToken: string, actionType: BatchViewActionType, prodOids: string[],
): Promise<BatchViewResult> {
  const products: BatchProduct[] = []
  const errors: EnvelopeError[] = []
  const readOidSet = new Set<string>()
  const configsCache = new Map<string, Promise<unknown>>()

  for (const prodOid of prodOids) {
    const oid = encodeURIComponent(prodOid)
    const [infoR, pkgsR, cfgR] = await Promise.allSettled([
      gateway.get(`/product/api/v1/drafts/products/${oid}/info`, accessToken),
      gateway.get(`/product/api/v1/products/${oid}/packages`, accessToken, { locale: 'zh-tw', show_supplier: '1' }),
      gateway.get(`/product/api/v1/products/${oid}/package-configs`, accessToken),
    ])
    if (pkgsR.status === 'rejected') {
      // 沒有方案清單就沒有任何可展示/可登記的 pkg/item — 整個商品跳過（不落入 products/
      // read_oids），但錯誤仍回報，讓面板知道哪個 prod_oid 讀取失敗。
      errors.push(toEnvelopeError(prodOid, pkgsR.reason))
      continue
    }
    readOidSet.add(prodOid)
    const name = infoR.status === 'fulfilled' ? extractProductInfo(infoR.value).name : undefined
    const configMap = cfgR.status === 'fulfilled' ? extractPackageConfigMap(cfgR.value) : new Map<string, PackageConfigRow>()
    if (cfgR.status === 'rejected') errors.push(toEnvelopeError(prodOid, cfgR.reason)) // best-effort: is_bundle/reserve_queue/is_active fall back, product still shown

    const plans: BatchPlan[] = []
    const extractedPkgs = extractPackagesWithSupplier(pkgsR.value)

    if (extractedPkgs.length === 0 && infoR.status === 'rejected') {
      errors.push({ key: prodOid, code: 'PRODUCT_NOT_FOUND', message: `PRODUCT_NOT_FOUND: 找不到商品 ${prodOid}` })
      products.push({ prod_oid: prodOid, not_found: true, plans: [] })
      continue
    }

    for (const p of extractedPkgs) {
      const cfg = configMap.get(p.pkg_oid)
      const plan: BatchPlan = {
        pkg_oid: p.pkg_oid,
        name: p.name,
        item_oid: p.item_oid,
        supplier_oid: p.supplier_oid,
        supplier_name: p.supplier_name,
        is_active: cfg?.is_active ?? p.is_active,
        is_bundle: cfg?.is_bundle,
      }
      if (actionType === 'shelf_schedule') {
        plan.reserve_queue = cfg?.reserve_queue ?? []
      }
      if (actionType === 'inventory_platform') {
        if (plan.item_oid && plan.supplier_oid) {
          const { platform, warning } = await resolveCurrentPlatform(gateway, accessToken, plan.item_oid, plan.supplier_oid, configsCache)
          plan.current_platform = platform
          if (warning) errors.push(warning)
        } else {
          plan.current_platform = null
          errors.push({ key: p.pkg_oid, code: 'SUPPLIER_UNRESOLVED', message: `pkg_oid=${p.pkg_oid} has no default supplier_mapping entry; current_platform left unknown.` })
        }
      }
      if (plan.item_oid) readOidSet.add(plan.item_oid)
      readOidSet.add(plan.pkg_oid)
      plans.push(plan)
    }
    products.push({ prod_oid: prodOid, name, plans })
  }

  return { products, errors, read_oids: [...readOidSet] }
}
