import type { GatewayClient } from '../gateway/client.js'
import { extractProductInfo } from './findProducts.js'
import { booleansToPlatform } from '../modules/product/inventoryPlatform/validate.js'
import { sanitizeQueue } from '../modules/product/shelfSchedule/validate.js'
import type { ScheduleEntry } from '../core/changeset/types.js'
import { toEnvelopeError, type EnvelopeError } from './envelope.js'
import { extractPackagesWithSupplier } from '../modules/product/common.js'
import { readCurrentFullday, readItemMode, isItemByAmount } from './inventoryShape.js'

const MODE_LABEL: Record<string, string> = { '1:0': 'item_by_amount', '2:0': 'sku_by_amount', '1:1': 'item_by_date', '2:1': 'sku_by_date' }
function modeLabel(m: { control_type?: number; inventory_type?: number | null }): string | undefined {
  return m.control_type === undefined ? undefined : (MODE_LABEL[`${m.control_type}:${m.inventory_type}`] ?? 'unsupported')
}

export type BatchViewActionType = 'inventory_platform' | 'shelf_schedule' | 'inventory_setting'

export interface BatchPlan {
  pkg_oid: string
  name?: string
  item_oid?: string
  supplier_oid?: string
  supplier_name?: string
  is_active?: boolean
  is_bundle?: boolean
  current_platform?: 'BE2' | 'BE2_SCM' | 'EXTERNAL' | null
  inventory_mode?: string
  reserve_queue?: ScheduleEntry[]
  current_quantity?: number | null
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

import { readSupplierInventorySetting, parseInventoryMode } from '../modules/product/inventoryPlatform/platformRead.js'

// Per docs/be2-mcp/sit-write-contracts.md Phase 4a read section: basic-info (carries both the
// inventory_platform supplier_configs and the inventory_setting mode).
async function getBasicInfoCached(
  gateway: GatewayClient, accessToken: string, itemOid: string, cache: Map<string, Promise<unknown>>,
): Promise<unknown> {
  let p = cache.get(itemOid)
  if (!p) {
    p = gateway.get(`/product/api/v1/items/${encodeURIComponent(itemOid)}/basic-info`, accessToken)
    cache.set(itemOid, p)
  }
  return p
}

async function resolveCurrentPlatform(
  gateway: GatewayClient, accessToken: string, itemOid: string, supplierOid: string, cache: Map<string, Promise<unknown>>,
): Promise<{ platform: 'BE2' | 'BE2_SCM' | 'EXTERNAL' | null; mode?: string; warning?: EnvelopeError }> {
  const key = `${itemOid}:${supplierOid}`
  try {
    const raw = await getBasicInfoCached(gateway, accessToken, itemOid, cache)
    const mode = parseInventoryMode(raw)
    const booleans = await readSupplierInventorySetting(gateway, accessToken, itemOid, supplierOid, raw)
    const platform = booleansToPlatform(booleans) ?? null
    return { platform, mode }
  } catch (e: any) {
    // If readSupplierInventorySetting throws DiffError, we catch it here to degrade gracefully.
    // DiffError doesn't have an exact matching shape for EnvelopeError, but toEnvelopeError handles it.
    if (e.name === 'DiffError') {
      return {
        platform: null,
        warning: { key, code: 'PLATFORM_READ_UNAVAILABLE', message: `current inventory-platform config not readable for ${key}; shown as unknown (view is display-only, not a diff).` },
      }
    }
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
          const { platform, mode, warning } = await resolveCurrentPlatform(gateway, accessToken, plan.item_oid, plan.supplier_oid, configsCache)
          plan.current_platform = platform
          if (mode !== undefined) plan.inventory_mode = mode
          if (warning) errors.push(warning)
        } else {
          plan.current_platform = null
          errors.push({ key: p.pkg_oid, code: 'SUPPLIER_UNRESOLVED', message: `pkg_oid=${p.pkg_oid} has no default supplier_mapping entry; current_platform left unknown.` })
        }
      }
      if (actionType === 'inventory_setting') {
        if (plan.item_oid && plan.supplier_oid) {
          try {
            const basic = await getBasicInfoCached(gateway, accessToken, plan.item_oid, configsCache) // basic-info, cached per item
            const mode = readItemMode(basic)
            plan.inventory_mode = modeLabel(mode)
            if (isItemByAmount(mode)) {
              plan.current_quantity = await readCurrentFullday(gateway, accessToken, plan.item_oid, plan.supplier_oid)
            }
          } catch (e) {
            errors.push({ key: `${plan.item_oid}:${plan.supplier_oid}`, code: 'INVENTORY_READ_UNAVAILABLE', message: `庫存現況讀取失敗（${(e as Error).message}）；此列顯示為未知，view 為唯讀展示不阻擋。` })
          }
        } else {
          errors.push({ key: p.pkg_oid, code: 'SUPPLIER_UNRESOLVED', message: `pkg_oid=${p.pkg_oid} 無 default supplier；current_quantity 留空。` })
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
