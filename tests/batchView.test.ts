import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildBatchView } from '../src/tools/batchView.js'
import { appGetBatchViewTool } from '../src/tools/appTools.js'
import { wrapAppTool, type AppPipelineDeps } from '../src/server/appPipeline.js'
import { requestContext } from '../src/server/requestContext.js'
import { openDb } from '../src/store/db.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { AppRateBudget } from '../src/limits/appRateBudget.js'
import { ApprovalNonceStore } from '../src/changeset/approvalNonce.js'
import { GatewayError } from '../src/errors.js'

// Fixtures per docs/be2-mcp/sit-write-contracts.md Phase 4a Task 1 §"packages?show_supplier=1
// 完整欄位形狀" (live-verified against SIT be2-220, prod_oid 34133-shaped).
const PACKAGES_34133 = [
  {
    pkg_oid: 1936562, pkg_name: 'Plan A', item_oid: 1682339, is_active: true, sales_deadline: '3',
    supplier_mapping: [
      { supplier_oid: 38028, supplier_name: 'Supplier X', is_default: true },
      { supplier_oid: 38029, supplier_name: 'Supplier Y', is_default: false },
    ],
  },
  {
    // no is_bundle field on this endpoint (per contract doc) — defensive, is_bundle comes from
    // package-configs below.
    pkg_oid: 1936563, pkg_name: 'Plan B', item_oid: 1682340, is_active: false, sales_deadline: '3',
    supplier_mapping: [{ supplier_oid: 38030, supplier_name: 'Supplier Z', is_default: true }],
  },
]

const PACKAGE_CONFIGS_34133 = [
  {
    pkg_oid: 1936562, name: 'Plan A', is_active: true, is_bundle: false,
    reserve_date: null, reserve_status: false,
    reserve_queue: [
      { reserve_date: '2099-01-02 00:00:00', reserve_status: true, created_at: 'x', created_by: 'y' },
      { reserve_date: '2099-01-01 00:00:00', reserve_status: false, created_at: 'x', created_by: 'y' },
    ],
  },
  { pkg_oid: 1936563, name: 'Plan B', is_active: false, is_bundle: true, reserve_queue: [] },
]

const PRODUCT_INFO_34133 = { description_module: { 'zh-tw': { name: 'Demo Product' } }, master_lang: 'zh-tw' }

const BASIC_INFO_1682339 = {
  data: {
    item_config: {
      inventory_setting: { control_type: 2, inventory_type: 1 }, // 21 -> 'SKU依日期'
      supplier_configs: [
        { supplier_oid: 38028, is_external_inventory: false, is_inventory_mgmt: true },  // BE2_SCM
        { supplier_oid: 38029, is_external_inventory: true, is_inventory_mgmt: false },  // EXTERNAL
      ],
    }
  }
}

function fakeGateway(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/product/api/v1/drafts/products/34133/info': PRODUCT_INFO_34133,
    '/product/api/v1/products/34133/packages': PACKAGES_34133,
    '/product/api/v1/products/34133/package-configs': PACKAGE_CONFIGS_34133,
    '/product/api/v1/items/1682339/basic-info': BASIC_INFO_1682339,
    ...overrides,
  }
  return {
    get: async (path: string) => {
      const v = routes[path]
      if (v === undefined) throw new Error(`no fixture for GET ${path}`)
      if (v instanceof Error) throw v
      return v
    },
  } as never
}

describe('buildBatchView — inventory_platform 模式', () => {
  it('輸出形狀：每商品 {prod_oid,name,plans:[{pkg_oid,name,item_oid,supplier_oid,supplier_name,is_active,is_bundle,current_platform,inventory_mode}]}', async () => {
    const out = await buildBatchView(fakeGateway(), 'AT', 'inventory_platform', ['34133'])
    expect(out.products).toHaveLength(1)
    const prod = out.products[0]
    expect(prod).toMatchObject({ prod_oid: '34133', name: 'Demo Product' })
    expect(prod.plans).toHaveLength(2)
    const planA = prod.plans.find(p => p.pkg_oid === '1936562')!
    expect(planA).toMatchObject({
      pkg_oid: '1936562', name: 'Plan A', item_oid: '1682339',
      supplier_oid: '38028', supplier_name: 'Supplier X', // is_default:true entry
      is_active: true, is_bundle: false, current_platform: 'BE2_SCM',
      inventory_mode: 'SKU依日期'
    })
    expect(planA.reserve_queue).toBeUndefined() // 非 shelf_schedule 模式不附
  })

  it('current_platform 讀不到（配置端點無此帳號權限/找不到列）時降級為 null + warning，不擋整批', async () => {
    // item 1682340 (Plan B) 沒有配置 fixture -> gateway.get 對它丟 404-like GatewayError
    const out = await buildBatchView(
      fakeGateway({ '/product/api/v1/items/1682340/basic-info': new GatewayError('AU9403', 'forbidden', 403) }),
      'AT', 'inventory_platform', ['34133'],
    )
    const planB = out.products[0].plans.find(p => p.pkg_oid === '1936563')!
    expect(planB.current_platform).toBeNull()
    expect(planB.inventory_mode).toBeUndefined()
    expect(planB.is_bundle).toBe(true) // package-configs 仍成功，is_bundle 照樣帶出
    expect(out.errors.some(e => e.key === '1682340:38030')).toBe(true)
  })

  it('package-configs 讀取失敗仍不擋商品顯示（best-effort：is_bundle 缺席、is_active 退回 packages 端點的值）', async () => {
    const out = await buildBatchView(
      fakeGateway({ '/product/api/v1/products/34133/package-configs': new GatewayError('HTTP_500', 'boom', 500) }),
      'AT', 'inventory_platform', ['34133'],
    )
    expect(out.products).toHaveLength(1)
    const planA = out.products[0].plans.find(p => p.pkg_oid === '1936562')!
    expect(planA.is_active).toBe(true)          // 退回 packages 端點自帶的 is_active
    expect(planA.is_bundle).toBeUndefined()      // 沒有權威來源，寧可缺席不可亂猜
    expect(out.errors.some(e => e.key === '34133')).toBe(true)
  })

  it('該商品 packages 讀取失敗 -> 整商品跳過（不進 products），回報錯誤', async () => {
    const out = await buildBatchView(
      fakeGateway({ '/product/api/v1/products/34133/packages': new GatewayError('HTTP_404', 'not found', 404) }),
      'AT', 'inventory_platform', ['34133'],
    )
    expect(out.products).toHaveLength(0)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].key).toBe('34133')
    expect(out.read_oids).toHaveLength(0)
  })

  it('測試:不存在商品 (packages [] + info rejects) -> not_found true + warning', async () => {
    const out = await buildBatchView(
      fakeGateway({
        '/product/api/v1/products/574779/packages': [],
        '/product/api/v1/drafts/products/574779/info': new GatewayError('HTTP_404', 'not found', 404),
        '/product/api/v1/products/574779/package-configs': [],
      }),
      'AT', 'inventory_platform', ['574779'],
    )
    expect(out.products).toHaveLength(1)
    expect(out.products[0]).toEqual({ prod_oid: '574779', not_found: true, plans: [] })
    expect(out.errors.some(e => e.code === 'PRODUCT_NOT_FOUND')).toBe(true)
  })

  it('測試:合法但0方案商品 -> 無 warning, not_found 不為 true', async () => {
    const out = await buildBatchView(
      fakeGateway({
        '/product/api/v1/products/574779/packages': [],
        '/product/api/v1/drafts/products/574779/info': { description_module: { 'zh-tw': { name: 'Empty Product' } }, master_lang: 'zh-tw' },
        '/product/api/v1/products/574779/package-configs': [],
      }),
      'AT', 'inventory_platform', ['574779'],
    )
    expect(out.products).toHaveLength(1)
    expect(out.products[0]).toEqual({ prod_oid: '574779', name: 'Empty Product', plans: [] })
    expect(out.errors.some(e => e.code === 'PRODUCT_NOT_FOUND')).toBe(false)
  })
})

describe('buildBatchView — shelf_schedule 模式', () => {
  it('帶 reserve_queue（淨化＋依日期排序）與 is_bundle，不解 current_platform', async () => {
    const out = await buildBatchView(fakeGateway(), 'AT', 'shelf_schedule', ['34133'])
    const planA = out.products[0].plans.find(p => p.pkg_oid === '1936562')!
    expect(planA.current_platform).toBeUndefined()
    expect(planA.reserve_queue).toEqual([
      { reserve_date_utc: '2099-01-01 00:00:00', reserve_status: false },
      { reserve_date_utc: '2099-01-02 00:00:00', reserve_status: true },
    ])
    const planB = out.products[0].plans.find(p => p.pkg_oid === '1936563')!
    expect(planB.is_bundle).toBe(true)
    expect(planB.reserve_queue).toEqual([])
  })
})

describe('buildBatchView — read_oids 三層登記', () => {
  it('回傳的 read_oids 含 prod_oid + 每個 plan 的 pkg_oid + item_oid（不重複）', async () => {
    const out = await buildBatchView(fakeGateway(), 'AT', 'inventory_platform', ['34133'])
    expect(new Set(out.read_oids)).toEqual(new Set(['34133', '1936562', '1682339', '1936563', '1682340']))
  })
})

// app_get_batch_view 的 zod inputShape 邊界（同 findProductsTool/createChangesetTool 的驗法：
// 直接對 inputShape 跑 z.object(...).safeParse，不經 SDK）。
describe('app_get_batch_view — inputShape 邊界', () => {
  const schema = z.object(appGetBatchViewTool.inputShape as never)
  it('1..10 個 prod_oids 合法', () => {
    expect(schema.safeParse({ action_type: 'inventory_platform', prod_oids: ['1'] }).success).toBe(true)
    expect(schema.safeParse({ action_type: 'inventory_platform', prod_oids: Array.from({ length: 10 }, (_, i) => String(i)) }).success).toBe(true)
  })
  it('11 個 prod_oids 拒絕', () => {
    const r = schema.safeParse({ action_type: 'inventory_platform', prod_oids: Array.from({ length: 11 }, (_, i) => String(i)) })
    expect(r.success).toBe(false)
  })
  it('0 個 prod_oids 拒絕', () => {
    expect(schema.safeParse({ action_type: 'inventory_platform', prod_oids: [] }).success).toBe(false)
  })
  it('action_type 只接受 inventory_platform|shelf_schedule', () => {
    expect(schema.safeParse({ action_type: 'shelf_toggle_product', prod_oids: ['1'] }).success).toBe(false)
  })
})

// 全鏈路（透過 wrapAppTool，真實 ReadOidStore + RateBudget）：Step 1 (b)(d)。
describe('app_get_batch_view — 全鏈路：read-oids 登記 + budget 計數', () => {
  function realDeps(): { deps: AppPipelineDeps; readOids: ReadOidStore; rateBudget: RateBudget } {
    const db = openDb(':memory:')
    const readOids = new ReadOidStore(db)
    const rateBudget = new RateBudget(db, { perSession: 5, perUserDay: 100 })
    const deps: AppPipelineDeps = {
      tokenManager: { getFreshAccessToken: async () => ({ accessToken: 'AT', userLabel: 'alice', businessList: [] }) } as never,
      appRateBudget: new AppRateBudget(),
      readOids, rateBudget,
      audit: { record() {} } as never,
      gateway: fakeGateway(),
      changeSets: {} as never,
      nonces: new ApprovalNonceStore(),
      now: Date.now, genId: () => 'id1',
      baseUrl: 'http://127.0.0.1:8787',
      emitConfirmUrl: () => {},
      modifyUserFrom: () => 'MU',
    }
    return { deps, readOids, rateBudget }
  }

  it('(b) 呼叫後 prod_oid/pkg_oid/item_oid 三層全被記入 readOidStore（供 be2_create_changeset scope-gate 讀）', async () => {
    const { deps, readOids } = realDeps()
    const wrapped = wrapAppTool(appGetBatchViewTool, deps)
    const out = await requestContext.run(
      { bearer: 'b', sessionId: 's1', clientInfo: 'test' },
      () => wrapped({ action_type: 'inventory_platform', prod_oids: ['34133'] }),
    )
    expect(out.isError).toBeUndefined()
    for (const oid of ['34133', '1936562', '1682339', '1936563', '1682340']) {
      expect(readOids.has('s1', oid)).toBe(true)
    }
  })

  it('(d) 每次呼叫對全域 RateBudget 計一次讀取額度（超額回 denied_rate）', async () => {
    const { deps } = realDeps()
    deps.rateBudget = new RateBudget(openDb(':memory:'), { perSession: 1, perUserDay: 100 })
    const wrapped = wrapAppTool(appGetBatchViewTool, deps)
    const call = () => requestContext.run(
      { bearer: 'b', sessionId: 's2', clientInfo: 'test' },
      () => wrapped({ action_type: 'inventory_platform', prod_oids: ['34133'] }),
    )
    const first = await call()
    expect(first.isError).toBeUndefined()
    const second = await call()
    expect(second.isError).toBe(true)
    expect(second.content[0].text).toContain('RATE_SESSION')
  })

  it('成功路徑：structuredContent.items[0].products 與 text 同源', async () => {
    const { deps } = realDeps()
    const wrapped = wrapAppTool(appGetBatchViewTool, deps)
    const out = await requestContext.run(
      { bearer: 'b', sessionId: 's3', clientInfo: 'test' },
      () => wrapped({ action_type: 'inventory_platform', prod_oids: ['34133'] }),
    )
    expect(out.isError).toBeUndefined()
    expect(JSON.stringify(out.structuredContent)).toBe(out.content[0].text)
    const body = out.structuredContent as { items: Array<{ products: unknown[] }> }
    expect(body.items[0].products).toHaveLength(1)
  })
})
