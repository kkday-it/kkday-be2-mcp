# be2 MCP 功能彙整工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 be2 MCP 現有 4 個散落面板彙整成單一「be2 工作台」面板（左側 3 功能 + 次模式），三功能（上下架/庫存/公告）走同一面板，取代 `be2_open_batch_wizard` / `be2_open_announcement_wizard`。

**Architecture:** 新增一個 MCP Apps 面板（`ui://be2/workbench.html`）+ 一個 model-visible 入口 tool `be2_open_workbench`；面板 JS 內用左功能列 + 次模式切換組合各 module 的 `WizardDescriptor`。change-set 引擎（registry/store/executor/confirmService/scheduler）、scope-gate、nonce 批准、7 個 module 的 diff/execute **全部重用、不動 core**。上下架三個 module 補 `wizard` descriptor 與單一方向 `validate()`；`buildBatchView` 加 shelf 分支；`app_get_batch_view` 的 Zod enum 同步擴充。

**Tech Stack:** TypeScript（ESM，import 帶 `.js` 副檔名）、zod、vitest、esbuild（build-ui）、MCP SDK Streamable HTTP。

## Global Constraints

- **不動 core changeset 引擎**：`src/core/changeset/{registry,store,executor,confirmService,module,diff}.ts`、scheduler 一律不改。只改 `src/modules/product/*` 與 `src/tools/*`、`src/ui/*`、`src/server/{app,appResources}.ts`、`scripts/build-ui.mjs`。
- **ESM import 帶 `.js`**：所有相對 import 用 `.js` 副檔名（專案慣例，見任一現有檔）。
- **不變式維持**：draft-only（agent 不直接寫）、scope-gate（read_oids 由 `app_get_*_view` server 端登記）、批准 nonce 只在 app-only 回傳發放。不得繞過。
- **UI 文案繁體中文**；程式識別字英文。
- **憑證**：`.env` 讀取，永不印出/commit。
- **驗收指令**：`npm run ci`（= build-ui + typecheck + test，必須全綠）；`npm run build:ui`（面板 bundle）；`npm run eval` 無 `ANTHROPIC_API_KEY` 時為文件化 SKIP、不算失敗。
- **測試框架 vitest**：`describe/it/expect`，registry 相關測試用 `resetRegistryForTest(); registerAllModules()`（見 `tests/core/moduleConformance.test.ts`）。
- **設計視覺來源**：`docs/be2-mcp/prototypes/workbench-prototype.html` 是工作台 UX/行為的權威參考（mock 資料版）；`src/ui/batch-wizard.ts` 是面板結構樣板。
- **面板檔前置關係**：`registerAppResources` 對缺檔 warn+skip（`src/server/appResources.ts:19`），故 tool 可先於面板落地；`scripts/build-ui.mjs` 需 `src/ui/<name>.ts` + `.html` 兩者都在才 bundle。

---

### Task 1: 上下架 module 單一方向 validate（3 個 module）

一批 shelf toggle 不可同時含上架與下架（業務規則）。在 `shelfToggleProductModule` / `shelfTogglePlanModule` / `shelfToggleBundleModule` 的 `validate()` 實作（目前都是 `validate: () => null`）。

**Files:**
- Modify: `src/modules/product/shelfToggle/module.ts`（`shelfToggleProductModule` 與 `shelfTogglePlanModule` 的 `validate`）
- Modify: `src/modules/product/shelfToggleBundle/module.ts`（`shelfToggleBundleModule` 的 `validate`）
- Test: `tests/shelfToggleValidate.test.ts`（新建）

**Interfaces:**
- Consumes: `ActionModule.validate(items, nowMs) => ValidationResult | null`（`src/core/changeset/module.ts:63`；`ValidationResult = {key,message}`，module.ts:18）。items 為該 module 的 item（含 `target_is_active: boolean`）。
- Produces: 三個 module 的 `validate` 會拒絕混方向；key = `'mixed_direction'`。

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/shelfToggleValidate.test.ts
import { describe, it, expect } from 'vitest'
import { shelfToggleProductModule, shelfTogglePlanModule } from '../src/modules/product/shelfToggle/module.js'
import { shelfToggleBundleModule } from '../src/modules/product/shelfToggleBundle/module.js'

describe('shelf single-direction validate', () => {
  it('product: 混上下架 → mixed_direction', () => {
    const r = shelfToggleProductModule.validate(
      [{ prod_oid: '1', target_is_active: true }, { prod_oid: '2', target_is_active: false }] as never, 0)
    expect(r?.key).toBe('mixed_direction')
  })
  it('product: 同方向 → null', () => {
    expect(shelfToggleProductModule.validate(
      [{ prod_oid: '1', target_is_active: true }, { prod_oid: '2', target_is_active: true }] as never, 0)).toBeNull()
  })
  it('plan: 混上下架 → mixed_direction', () => {
    expect(shelfTogglePlanModule.validate(
      [{ prod_oid: '1', pkg_oid: 'a', target_is_active: true }, { prod_oid: '1', pkg_oid: 'b', target_is_active: false }] as never, 0)?.key)
      .toBe('mixed_direction')
  })
  it('bundle: 混上下架 → mixed_direction', () => {
    expect(shelfToggleBundleModule.validate(
      [{ prod_oid: '1', bundle_pkg_oid: 'a', target_is_active: true }, { prod_oid: '1', bundle_pkg_oid: 'b', target_is_active: false }] as never, 0)?.key)
      .toBe('mixed_direction')
  })
  it('空陣列 / 單筆 → null', () => {
    expect(shelfToggleProductModule.validate([] as never, 0)).toBeNull()
    expect(shelfToggleProductModule.validate([{ prod_oid: '1', target_is_active: false }] as never, 0)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/shelfToggleValidate.test.ts`
Expected: FAIL（現況 `validate: () => null`，混方向那幾筆得到 null）。

- [ ] **Step 3: 實作 validate**

在 `src/modules/product/shelfToggle/module.ts` 頂部（其他 helper 之後）加共用函式，並把兩個 module 的 `validate: () => null` 換掉：

```ts
function singleDirection(items: Array<{ target_is_active: boolean }>) {
  const dirs = new Set(items.map(i => i.target_is_active))
  if (dirs.size > 1) return { key: 'mixed_direction', message: '一批上下架不可同時含上架與下架，請分兩批送出。' }
  return null
}
```
`shelfToggleProductModule`：`validate: (items) => singleDirection(items as Array<{ target_is_active: boolean }>),`
`shelfTogglePlanModule`：同上。

在 `src/modules/product/shelfToggleBundle/module.ts` 加同一個 `singleDirection`（複製，兩檔不共用 import 以免跨 module 耦合），`shelfToggleBundleModule.validate` 換成 `(items) => singleDirection(items as Array<{ target_is_active: boolean }>),`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/shelfToggleValidate.test.ts`
Expected: PASS（5 個 it 全綠）。

- [ ] **Step 5: Commit**

```bash
git add src/modules/product/shelfToggle/module.ts src/modules/product/shelfToggleBundle/module.ts tests/shelfToggleValidate.test.ts
git commit -m "feat(shelf): 上下架 module 單一方向 validate(拒絕一批混上下架)"
```

---

### Task 2: 上下架 WizardDescriptor（ui.ts）並掛上 module

上下架三個 module 目前無 `wizard`，無法進工作台殼。新增 ui.ts 導出 `WizardDescriptor`（`renderDiffCard` + `itemKey` + `buildItems`），並在 module.ts import 掛到 `wizard` 欄位。以 `src/modules/product/inventoryPlatform/ui.ts` 為樣板。

**Files:**
- Create: `src/modules/product/shelfToggle/ui.ts`（導出 `shelfToggleProductWizard`、`shelfTogglePlanWizard`）
- Create: `src/modules/product/shelfToggleBundle/ui.ts`（導出 `shelfToggleBundleWizard`）
- Modify: `src/modules/product/shelfToggle/module.ts`（import + `wizard:` 兩個 module）
- Modify: `src/modules/product/shelfToggleBundle/module.ts`（import + `wizard:`）
- Test: `tests/shelfToggleWizardUi.test.ts`（新建；仿 `tests/inventorySettingWizardUi.test.ts` 的 fakeDom `DomHelpers` 模式）

**Interfaces:**
- Consumes: `WizardDescriptor`（module.ts:39-46）、`WizardRowInput`（module.ts:25-31，含 `checked/prod_oid/pkg_oid/pkg_name/is_bundle` + 我們要用的 `target?`）、`DomHelpers`（module.ts:33-37）、各自 `./keys.js` 的 `itemKey`。
- Produces: 三個 `WizardDescriptor`；`buildItems(rows, {target})` 回傳對應 module 的 item 陣列（product：`{prod_oid, target_is_active}`；plan：`{prod_oid, pkg_oid, target_is_active}`；bundle：`{prod_oid, bundle_pkg_oid, target_is_active}`），其中 `target` 為 `'on'|'off'` → `target_is_active = target === 'on'`。

- [ ] **Step 1: 寫失敗測試（renderDiffCard + buildItems）**

```ts
// tests/shelfToggleWizardUi.test.ts
import { describe, it, expect } from 'vitest'
import { shelfTogglePlanWizard } from '../src/modules/product/shelfToggle/ui.js'

function fakeDom() {
  const h = {
    el: (tag: string, cls?: string) => { const n: any = { tag, cls, children: [] as any[], txt: '' }; n.appendChild = (c: any) => n.children.push(c); return n },
    text: (n: any, v: unknown) => { n.txt = String(v) },
    renderQueueLines: () => {},
  }
  return h as any
}

describe('shelfTogglePlanWizard', () => {
  it('buildItems: target=off → target_is_active false，只收 checked', () => {
    const items = shelfTogglePlanWizard.buildItems(
      [{ checked: true, is_bundle: false, prod_oid: '1', pkg_oid: 'a', pkg_name: 'A', queue: [], cleared: false },
       { checked: false, is_bundle: false, prod_oid: '1', pkg_oid: 'b', pkg_name: 'B', queue: [], cleared: false }] as never,
      { target: 'off' })
    expect(items).toEqual([{ prod_oid: '1', pkg_oid: 'a', target_is_active: false }])
  })
  it('renderDiffCard: 顯示方案名與目標', () => {
    const card = shelfTogglePlanWizard.renderDiffCard({ prod_oid: '1', pkg_oid: 'a', pkg_name: 'A方案', current_is_active: true, target_is_active: false } as never, fakeDom())
    expect(JSON.stringify(card)).toContain('A方案')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/shelfToggleWizardUi.test.ts`
Expected: FAIL（`../ui.js` 不存在 / `shelfTogglePlanWizard` undefined）。

- [ ] **Step 3: 實作 ui.ts（product + plan）**

```ts
// src/modules/product/shelfToggle/ui.ts
import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../../../core/changeset/module.js'
import { itemKey } from './keys.js'

function renderShelfCard(d: Record<string, unknown>, h: DomHelpers): HTMLElement {
  const card = h.el('div', 'bw-diff-card')
  const title = h.el('div', 'bw-diff-title')
  h.text(title, (d.pkg_name as string) ?? (d.prod_oid as string))
  card.appendChild(title)
  const row = h.el('div', 'bw-diff-row')
  const cur = h.el('span'); h.text(cur, d.current_is_active == null ? '—' : (d.current_is_active ? '上架' : '下架'))
  const arrow = h.el('span', 'bw-diff-arrow'); h.text(arrow, '→')
  const tgt = h.el('span', 'bw-diff-target'); h.text(tgt, d.target_is_active ? '上架' : '下架')
  row.appendChild(cur); row.appendChild(arrow); row.appendChild(tgt)
  card.appendChild(row)
  return card
}

export const shelfToggleProductWizard: WizardDescriptor = {
  label: '批次商品上下架',
  itemKey,
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[] {
    const active = opts.target === 'on'
    // product 層：以 prod_oid 去重；rows 需帶 is_bundle=false 且無 pkg（或標記 product-level）
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const r of rows) {
      if (!r.checked) continue
      if (r.pkg_oid) continue          // 只收商品層（無 pkg）
      if (seen.has(r.prod_oid)) continue
      seen.add(r.prod_oid)
      out.push({ prod_oid: r.prod_oid, target_is_active: active })
    }
    return out
  },
  renderDiffCard: renderShelfCard,
}

export const shelfTogglePlanWizard: WizardDescriptor = {
  label: '批次方案上下架',
  itemKey,
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[] {
    const active = opts.target === 'on'
    return rows.filter(r => r.checked && r.pkg_oid && !r.is_bundle).map(r => ({ prod_oid: r.prod_oid, pkg_oid: r.pkg_oid, target_is_active: active }))
  },
  renderDiffCard: renderShelfCard,
}
```

```ts
// src/modules/product/shelfToggleBundle/ui.ts
import type { WizardDescriptor, WizardRowInput, DomHelpers } from '../../../core/changeset/module.js'
import { itemKey } from './keys.js'

export const shelfToggleBundleWizard: WizardDescriptor = {
  label: '批次套裝上下架',
  itemKey,
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[] {
    const active = opts.target === 'on'
    return rows.filter(r => r.checked && r.is_bundle && r.pkg_oid)
      .map(r => ({ prod_oid: r.prod_oid, bundle_pkg_oid: r.pkg_oid, target_is_active: active }))
  },
  renderDiffCard(d: Record<string, unknown>, h: DomHelpers): HTMLElement {
    const card = h.el('div', 'bw-diff-card')
    const title = h.el('div', 'bw-diff-title'); h.text(title, (d.bundle_pkg_oid as string) ?? (d.prod_oid as string))
    card.appendChild(title)
    const row = h.el('div', 'bw-diff-row')
    const cur = h.el('span'); h.text(cur, d.current_is_active == null ? '—' : (d.current_is_active ? '上架' : '下架'))
    const arrow = h.el('span', 'bw-diff-arrow'); h.text(arrow, '→')
    const tgt = h.el('span', 'bw-diff-target'); h.text(tgt, d.target_is_active ? '上架' : '下架')
    row.appendChild(cur); row.appendChild(arrow); row.appendChild(tgt); card.appendChild(row)
    return card
  },
}
```

- [ ] **Step 4: 掛到 module**

`src/modules/product/shelfToggle/module.ts`：頂部加 `import { shelfToggleProductWizard, shelfTogglePlanWizard } from './ui.js'`；`shelfToggleProductModule` 物件末尾加 `wizard: shelfToggleProductWizard`；`shelfTogglePlanModule` 加 `wizard: shelfTogglePlanWizard`。
`src/modules/product/shelfToggleBundle/module.ts`：加 `import { shelfToggleBundleWizard } from './ui.js'`；`shelfToggleBundleModule` 加 `wizard: shelfToggleBundleWizard`。

- [ ] **Step 5: 跑測試 + typecheck**

Run: `npx vitest run tests/shelfToggleWizardUi.test.ts && npx tsc --noEmit`
Expected: PASS + 無型別錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/modules/product/shelfToggle/ui.ts src/modules/product/shelfToggleBundle/ui.ts src/modules/product/shelfToggle/module.ts src/modules/product/shelfToggleBundle/module.ts tests/shelfToggleWizardUi.test.ts
git commit -m "feat(shelf): 上下架三 module 補 WizardDescriptor(ui.ts)並掛上"
```

---

### Task 3: buildBatchView 加 shelf 分支 + 商品層 is_active

工作台的「立即上/下架」次模式要顯示**商品整體現況**與**各方案現況**。`buildBatchView` 目前 `BatchPlan.is_active` 是方案層（來自 package-configs），**沒有商品層** on/off 狀態。加：`BatchViewActionType` 納入三個 shelf action_type；shelf 分支對商品加讀 `/product-configs/{oid}/switch`（`be2_find_products` 用的那支）並在 `BatchProduct` 補 `is_active`。

**Files:**
- Modify: `src/tools/batchView.ts`（`BatchViewActionType`、`BatchProduct`、`buildBatchView` 迴圈）
- Test: `tests/batchView.test.ts`（新增 shelf 分支案例；若無此檔則新建，仿 §9 gateway mock）

**Interfaces:**
- Consumes: `GatewayClient.get(path, accessToken, query?)`。商品層現況端點：`/product/api/v1/product-configs/{oid}/switch`（回 `{ is_active }` 形狀，同 `be2_find_products`；實作前用 `grep -rn "product-configs" src/tools/findProducts.ts` 確認確切路徑與 extractor）。
- Produces: `BatchViewActionType` 新增 `'shelf_toggle_product' | 'shelf_toggle_plan' | 'shelf_toggle_bundle'`；`BatchProduct.is_active?: boolean`（商品整體現況）；shelf 分支下每個 `BatchPlan` 已含方案層 `is_active` 與 `is_bundle`（現況已有）。

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/batchView.test.ts (新增 describe)
import { describe, it, expect } from 'vitest'
import { buildBatchView } from '../src/tools/batchView.js'

function gw(routes: Record<string, unknown>) {
  return { async get(path: string) { const k = Object.keys(routes).find(r => path.includes(r)); if (!k) throw new Error('404 ' + path); return routes[k] }, async put() { throw new Error('no write') } } as never
}

describe('buildBatchView shelf_toggle_product', () => {
  it('回傳商品層 is_active', async () => {
    const res = await buildBatchView(gw({
      'drafts/products/546965/info': { data: { prod_name: '東京' } },
      'products/546965/packages': { data: [{ pkg_oid: '888', pkg_name: '成人' }] },
      'products/546965/package-configs': { data: [{ pkg_oid: '888', is_active: true }] },
      'product-configs/546965/switch': { data: { is_active: false } },
    }), 'tok', 'shelf_toggle_product', ['546965'])
    expect(res.products[0].is_active).toBe(false)
    expect(res.read_oids).toContain('546965')
  })
})
```
（注意：`data` 包裝形狀請以實作前 `grep` 到的真實 extractor 為準；本測試的 routes 內容需對齊 `extractProductInfo` / `extractPackageConfigMap` 實際解析欄位——實作 Step 3 時一併校準測試的 mock 形狀。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/batchView.test.ts`
Expected: FAIL（`BatchViewActionType` 不接受 `shelf_toggle_product` / `is_active` undefined）。

- [ ] **Step 3: 實作**

`src/tools/batchView.ts`：
1. `BatchViewActionType` 改為 `'inventory_platform' | 'shelf_schedule' | 'inventory_setting' | 'shelf_toggle_product' | 'shelf_toggle_plan' | 'shelf_toggle_bundle'`。
2. `BatchProduct` 加 `is_active?: boolean`。
3. 迴圈內：當 `actionType` 以 `shelf_toggle` 開頭時，加讀商品層 switch（併進現有 `Promise.allSettled` 或另發一個 `gateway.get`），解析出 `is_active`，設到 `products.push({ prod_oid, name, is_active, plans })`。方案層 `is_active`/`is_bundle` 已在（不需改）。商品層 oid 已在 `readOidSet`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/batchView.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tools/batchView.ts tests/batchView.test.ts
git commit -m "feat(batchView): 加 shelf_toggle 分支 + 商品層 is_active"
```

---

### Task 4: appGetBatchViewTool Zod enum + announcement view 批次化

`app_get_batch_view` 的 Zod `action_type` enum 需同步納入三個 shelf action_type（否則面板呼叫被工具驗證層擋）。`app_get_announcement_view` 現逐 oid 呼叫 `listByProdOids([oid])`（N+1），改一次帶整個 `prodOids`。

**Files:**
- Modify: `src/tools/appTools.ts`（`appGetBatchViewTool.inputShape.action_type`；`appGetAnnouncementViewTool.handler`）
- Test: `tests/appTools.test.ts`（新增；若已有則加案例）

**Interfaces:**
- Consumes: `makeAnnouncementClient().listByProdOids(accessToken, prodOids: string[]) => Promise<Array<{ prod_oid?: string, ... }>>`（實作前 `grep -rn "listByProdOids" src/modules/announcement` 確認回傳形狀與是否帶 `prod_oid` 以便分組計數）。
- Produces: `app_get_batch_view` 接受 `shelf_toggle_*`；`app_get_announcement_view` 對每個 prod_oid 的 `existing_count` 用「一次查詢後分組」得到（形狀無法分組則退回 null，不報錯）。

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/appTools.test.ts
import { describe, it, expect } from 'vitest'
import { appGetBatchViewTool } from '../src/tools/appTools.js'
import { z } from 'zod'

describe('appGetBatchViewTool zod', () => {
  it('接受 shelf_toggle_product', () => {
    const schema = z.object(appGetBatchViewTool.inputShape as never)
    expect(schema.safeParse({ action_type: 'shelf_toggle_product', prod_oids: ['1'] }).success).toBe(true)
  })
  it('接受 shelf_toggle_bundle', () => {
    const schema = z.object(appGetBatchViewTool.inputShape as never)
    expect(schema.safeParse({ action_type: 'shelf_toggle_bundle', prod_oids: ['1'] }).success).toBe(true)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/appTools.test.ts`
Expected: FAIL（enum 不含 shelf_toggle_*）。

- [ ] **Step 3: 實作**

`appGetBatchViewTool.inputShape.action_type`：`z.enum(['inventory_platform','shelf_schedule','inventory_setting','shelf_toggle_product','shelf_toggle_plan','shelf_toggle_bundle'])`。
`appGetAnnouncementViewTool.handler`：把 for-loop 內的 `client.listByProdOids(ctx.accessToken, [oid])` 抽到迴圈外一次呼叫 `client.listByProdOids(ctx.accessToken, prodOids)`，回傳後依 `prod_oid` 分組計數；若回傳項無法對應 prod_oid 則各商品 `existing_count` 設 null（維持既有 degrade 行為）。名稱查詢（`/drafts/products/{oid}/info`）維持逐 oid（不同端點）。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/appTools.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tools/appTools.ts tests/appTools.test.ts
git commit -m "feat(appTools): batch-view Zod 納入 shelf_toggle_*; announcement view 批次化免 N+1"
```

---

### Task 5: openWorkbench 入口 tool

新 model-visible tool，綁 `ui://be2/workbench.html`。仿 `src/tools/openBatchWizard.ts`。

**Files:**
- Create: `src/tools/openWorkbench.ts`
- Test: `tests/openWorkbench.test.ts`（新建）

**Interfaces:**
- Consumes: `ToolDef`（`src/tools/types.js`）、`makeEnvelope`（`src/tools/envelope.js`）。
- Produces: `openWorkbenchTool`：`name:'be2_open_workbench'`、`uiResourceUri:'ui://be2/workbench.html'`、input `{ feature?: z.enum(['shelf','inventory','announce']).optional(), prod_oids?: z.array(z.string().min(1)).max(20).optional() }`；handler 回 `makeEnvelope([{ feature: args.feature ?? null, prod_oids: args.prod_oids ?? [] }])`。

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/openWorkbench.test.ts
import { describe, it, expect } from 'vitest'
import { openWorkbenchTool } from '../src/tools/openWorkbench.js'

describe('openWorkbenchTool', () => {
  it('綁 workbench 面板、名稱正確', () => {
    expect(openWorkbenchTool.name).toBe('be2_open_workbench')
    expect(openWorkbenchTool.uiResourceUri).toBe('ui://be2/workbench.html')
  })
  it('handler 回 prefill envelope', async () => {
    const env = await openWorkbenchTool.handler({ feature: 'shelf', prod_oids: ['546965'] } as never, {} as never)
    expect(JSON.stringify(env)).toContain('546965')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/openWorkbench.test.ts`　Expected: FAIL（檔不存在）。

- [ ] **Step 3: 實作**（照 `openBatchWizard.ts` 結構）

```ts
// src/tools/openWorkbench.ts
import { z } from 'zod'
import type { ToolDef } from './types.js'
import { makeEnvelope } from './envelope.js'

const inputShape = {
  feature: z.enum(['shelf', 'inventory', 'announce']).optional(),
  prod_oids: z.array(z.string().min(1)).max(20).optional(),
}

export const openWorkbenchTool: ToolDef<typeof inputShape> = {
  name: 'be2_open_workbench',
  description:
    'Open the be2 workbench panel — the single consolidated surface for three product batch tasks: ' +
    '商品上下架 (shelf on/off for products/plans/bundles + reserve-date schedule), 商品庫存 (per-date quantity + platform switch), ' +
    '商品公告 (create multi-locale announcement). Pick a feature from the left nav; no need to switch tools. ' +
    'feature/prod_oids only prefill the panel — they do NOT satisfy the server-side read-scope gate; only the panel\'s own ' +
    'app_get_batch_view / app_get_announcement_view calls establish that. On a host without MCP Apps (e.g. Claude Code), ' +
    'this cannot render a panel — use be2_create_changeset plus the confirm-page flow instead.',
  inputShape,
  uiResourceUri: 'ui://be2/workbench.html',
  annotations: { title: 'Open be2 workbench', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args) {
    return makeEnvelope([{ feature: args.feature ?? null, prod_oids: args.prod_oids ?? [] }])
  },
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/openWorkbench.test.ts && npx tsc --noEmit`　Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tools/openWorkbench.ts tests/openWorkbench.test.ts
git commit -m "feat(tools): be2_open_workbench 入口 tool"
```

---

### Task 6: 工作台面板核心邏輯（可測純函式）

面板 JS 的可測純邏輯先以 TDD 落地，與 DOM 無關：oid 載入解析、change-set 拆批（先按 action_type 分組再按 20 切）、公告 JSON ingest（`lang_code→langCode` + 勾選）。放獨立 module 供面板與測試共用。

**Files:**
- Create: `src/ui/workbenchLogic.ts`（純函式，無 DOM/無 host）
- Test: `tests/workbenchLogic.test.ts`

**Interfaces:**
- Produces:
  - `parseOidInput(text: string): string[]`（逗號/空白/換行分隔、去重、去空、保留輸入順序）。
  - `splitBatches<T extends { action_type: string }>(items: T[], cap = 20): Array<{ action_type: string; items: T[] }>`（先按 `action_type` 穩定分組、每組再切 ≤cap；回傳多個 change-set 分塊，順序＝首次出現 action_type 順序）。
  - `ingestAnnouncement(rawReply: string): { langs: Array<{ langCode: string; content: string }> } | null`（從整段回覆抓 ```json 區塊；驗 `type==='be2-announcement-content'`；把 `langs[].lang_code`→`langCode`；失敗回 null）。

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/workbenchLogic.test.ts
import { describe, it, expect } from 'vitest'
import { parseOidInput, splitBatches, ingestAnnouncement } from '../src/ui/workbenchLogic.js'

describe('parseOidInput', () => {
  it('多分隔 + 去重 + 去空', () => {
    expect(parseOidInput('546965, 546970\n546965  546988')).toEqual(['546965', '546970', '546988'])
  })
})
describe('splitBatches', () => {
  it('先按 action_type 分組、再按 cap 切', () => {
    const items = [
      { action_type: 'shelf_toggle_product', x: 1 }, { action_type: 'shelf_toggle_plan', x: 2 },
      { action_type: 'shelf_toggle_product', x: 3 },
    ]
    const b = splitBatches(items as never, 2)
    expect(b.map(g => g.action_type)).toEqual(['shelf_toggle_product', 'shelf_toggle_plan'])
    expect(b[0].items).toHaveLength(2)
  })
  it('超過 cap 同 action_type 切多塊', () => {
    const items = Array.from({ length: 25 }, () => ({ action_type: 'inventory_setting' }))
    const b = splitBatches(items as never, 20)
    expect(b).toHaveLength(2)
    expect(b[0].items).toHaveLength(20); expect(b[1].items).toHaveLength(5)
  })
})
describe('ingestAnnouncement', () => {
  it('抓 json 區塊、lang_code→langCode', () => {
    const raw = '（可讀版）...\n```json\n{"type":"be2-announcement-content","langs":[{"lang_code":"zh-tw","content":"你好"}]}\n```'
    expect(ingestAnnouncement(raw)).toEqual({ langs: [{ langCode: 'zh-tw', content: '你好' }] })
  })
  it('type 不符 → null', () => {
    expect(ingestAnnouncement('```json\n{"type":"x","langs":[]}\n```')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/workbenchLogic.test.ts`　Expected: FAIL（module 不存在）。

- [ ] **Step 3: 實作 `src/ui/workbenchLogic.ts`**

```ts
export function parseOidInput(text: string): string[] {
  const seen = new Set<string>(); const out: string[] = []
  for (const tok of (text ?? '').split(/[\s,]+/)) { const t = tok.trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t) } }
  return out
}

export function splitBatches<T extends { action_type: string }>(items: T[], cap = 20): Array<{ action_type: string; items: T[] }> {
  const order: string[] = []; const byType = new Map<string, T[]>()
  for (const it of items) { if (!byType.has(it.action_type)) { byType.set(it.action_type, []); order.push(it.action_type) } byType.get(it.action_type)!.push(it) }
  const out: Array<{ action_type: string; items: T[] }> = []
  for (const at of order) { const arr = byType.get(at)!; for (let i = 0; i < arr.length; i += cap) out.push({ action_type: at, items: arr.slice(i, i + cap) }) }
  return out
}

export function ingestAnnouncement(rawReply: string): { langs: Array<{ langCode: string; content: string }> } | null {
  try {
    const m = (rawReply ?? '').match(/```json([\s\S]*?)```/)
    const o = JSON.parse((m ? m[1] : rawReply).trim())
    if (o?.type !== 'be2-announcement-content' || !Array.isArray(o.langs)) return null
    return { langs: o.langs.map((l: { lang_code: string; content: string }) => ({ langCode: l.lang_code, content: l.content })) }
  } catch { return null }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/workbenchLogic.test.ts`　Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ui/workbenchLogic.ts tests/workbenchLogic.test.ts
git commit -m "feat(workbench): 面板純邏輯(oid 解析/拆批/公告 ingest)+測試"
```

---

### Task 7: 工作台面板 UI（workbench.ts + workbench.html）並註冊

移植 prototype 的版型 B 到真面板：左功能列（上下架/庫存/公告）+ 次模式 + 商品載入器 + 多商品 tab + 步驟條 + 拆批檢視 + 批准。以 `src/ui/batch-wizard.ts` 為結構樣板（host bridge `connectApp`、STYLE 常數、mount points）、Task 6 純邏輯、各 module `WizardDescriptor` 組合。行為對照 prototype `docs/be2-mcp/prototypes/workbench-prototype.html`。

**Files:**
- Create: `src/ui/workbench.ts`、`src/ui/workbench.html`（HTML 仿 `batch-wizard.html`，含 `__PANEL_JS__` 佔位與 mount points）
- Modify: `src/server/appResources.ts`（PANELS 加 `{ uri: 'ui://be2/workbench.html', file: 'workbench.html' }`）
- Modify: `scripts/build-ui.mjs`（entries 加 `'workbench'`）

**Interfaces:**
- Consumes: `./panelShared.js`（`connectApp` / `renderText`）、`./workbenchLogic.js`（Task 6）、三功能各 module 的 `WizardDescriptor`（`inventoryPlatformWizard`/`shelfScheduleWizard`/`inventorySettingWizard`/`shelfToggleProductWizard`/`shelfTogglePlanWizard`/`shelfToggleBundleWizard`/announcement 內容處理）、app-only tools 經 host bridge（`app_get_batch_view`/`app_get_announcement_view`/`app_create_changeset`/`app_get_changeset_view`/`app_confirm_changeset`）。
- Produces: `dist/ui/workbench.html`（build 後）。

**面板結構（照 prototype 落地）：**
1. 左功能列 3 功能；點進去出次模式（上下架：立即/套裝/排程；庫存：逐日數量/平台；公告：無）。
2. 商品載入器：`parseOidInput` → 呼 `app_get_batch_view`（對應次模式的 action_type）或 `app_get_announcement_view`（公告）載入 → 多商品 chips + tab。
3. 各次模式編輯器＝重用該 module `WizardDescriptor.buildItems` / `renderDiffCard`；上下架「立即」含商品整體 checkbox（用 Task 3 的 `BatchProduct.is_active`）+ 強制單一方向（UI 只讓單向可選）。
4. 步驟條（選擇→檢視→批准→結果）：檢視用 `splitBatches` 呈現「本次 = N 個 change-set」；每塊呼 `app_create_changeset`（draft）→ `app_get_changeset_view`（diff+nonce）→ `app_confirm_changeset`（nonce 批准）。
5. 公告：`ingestAnnouncement` 貼上 → 15 語系可勾選清單 → `app_create_changeset`（`action_type:'announcement'`，body 帶 name/isEnabled/startTime/endTime/langSettings/勾選語系/prodOids）。prodOids 一次送；未知上限前超量明確報錯。**公告 item 的確切欄位形狀以既有 `src/ui/announcement-wizard.ts` 的 item 建構 + `src/modules/announcement/create/module.ts` 的 `itemSchema` 為準**（我們取代該 wizard 入口，但沿用其 item 形狀與 `execute`；實作前讀這兩檔對齊欄位名）。

- [ ] **Step 1: 建 workbench.html**（仿 batch-wizard.html）

```html
<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>be2 工作台</title>
<style>body{font-family:system-ui;margin:0}.banner{color:#b8281f;background:rgba(255,59,48,.1);border-radius:10px;padding:.625rem .875rem;font-size:.875rem;white-space:pre-wrap}</style>
</head><body>
<div id="nav"></div><div id="status">載入中…</div><div id="workspace"></div>
<pre class="banner" id="fallback" hidden></pre>
<script>__PANEL_JS__</script></body></html>
```

- [ ] **Step 2: 實作 workbench.ts**

移植 prototype 版型 B（左功能列 + 次模式 + 載入器 + tab + 步驟條 + 拆批 + 公告清單）到 `src/ui/workbench.ts`，遵循 `batch-wizard.ts` 的 `connectApp` host bridge 與 STYLE 常數模式；用 `workbenchLogic.ts` 的 `parseOidInput`/`splitBatches`/`ingestAnnouncement`；各次模式組合對應 `WizardDescriptor`。**驗收＝行為對齊 prototype**（載入多商品、tab、單一方向、拆批呈現「N 個 change-set」、公告貼上長出可勾選 15 語系）。

- [ ] **Step 3: 註冊面板**

`src/server/appResources.ts` PANELS 加 workbench 一列；`scripts/build-ui.mjs` entries 加 `'workbench'`。

- [ ] **Step 4: build 面板 + typecheck**

Run: `npm run build:ui && npx tsc --noEmit`
Expected: build 印出含 `workbench`（不再 `skip workbench: missing src`）；`dist/ui/workbench.html` 產出且不含字面 `__PANEL_JS__`；tsc 無錯。

- [ ] **Step 5: Commit**

```bash
git add src/ui/workbench.ts src/ui/workbench.html src/server/appResources.ts scripts/build-ui.mjs
git commit -m "feat(workbench): 統一工作台面板(版型B)+註冊 ui:// resource"
```

---

### Task 8: 接線入口 tool（取代舊 wizard 入口）+ 全綠驗收

把 `be2_open_workbench` 加進 `TOOLS`、移除 `be2_open_batch_wizard` / `be2_open_announcement_wizard`（達成「取代」）。舊面板 HTML（batch-wizard/announcement-wizard）留著無害但 model 不再有入口。

**Files:**
- Modify: `src/server/app.ts`（imports + `TOOLS` 陣列）
- Modify: `tests/serverIntegration.test.ts`（既有測試 `client.listTools()` 斷言精確 TOOLS 清單、含舊兩個 wizard；**必須同步更新**：移除 `be2_open_batch_wizard` / `be2_open_announcement_wizard`、加 `be2_open_workbench`，否則 `npm run ci` 必爆）
- Modify: `tests/toolAnnotations.test.ts`（其 `modelTools` 陣列寫死 `openBatchWizardTool`；換成 `openWorkbenchTool` 以單測新 tool 的 annotations）
- Test: `tests/serverTools.test.ts`（若無則新建；斷言 TOOLS 名單）

**Interfaces:**
- Consumes: `openWorkbenchTool`（Task 5）。
- Produces: `TOOLS` 含 `be2_open_workbench`、不含 `be2_open_batch_wizard` / `be2_open_announcement_wizard`。

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/serverTools.test.ts
import { describe, it, expect } from 'vitest'
import { TOOLS } from '../src/server/app.js'   // 若 TOOLS 未 export，改為 export 它（見 Step 3 備註）

describe('model-visible TOOLS', () => {
  it('含 workbench、不含舊 wizard 入口', () => {
    const names = TOOLS.map(t => t.name)
    expect(names).toContain('be2_open_workbench')
    expect(names).not.toContain('be2_open_batch_wizard')
    expect(names).not.toContain('be2_open_announcement_wizard')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/serverTools.test.ts`　Expected: FAIL（現況相反；或 TOOLS 未 export → 先 Step 3 export）。

- [ ] **Step 3: 實作**

`src/server/app.ts`：加 `import { openWorkbenchTool } from '../tools/openWorkbench.js'`；`TOOLS` 陣列把 `openBatchWizardTool` / `openAnnouncementWizardTool` 兩行換成 `openWorkbenchTool as ToolDef`；移除那兩個 import。若 `TOOLS` 目前非 `export`，加 `export`（僅測試用途，不影響行為）。
同步更新既有測試（否則 CI 爆）：
- `tests/serverIntegration.test.ts`：找 `client.listTools()` 斷言的期望陣列，移除 `be2_open_batch_wizard` / `be2_open_announcement_wizard`、加入 `be2_open_workbench`。
- `tests/toolAnnotations.test.ts`：把 `modelTools` 陣列裡的 `openBatchWizardTool` 換成 `openWorkbenchTool`（import 一併換）。

- [ ] **Step 4: 跑測試 + 全綠 CI + build-ui + healthz 冒煙**

Run: `npx vitest run tests/serverTools.test.ts`　Expected: PASS。
Run: `npm run ci`　Expected: build-ui + typecheck + 全部 vitest 綠。
Run（冒煙）: 啟 dev server 後 `curl -s http://127.0.0.1:$BE2_MCP_PORT/healthz`（預設 8787）→ `ok`；確認啟動 log 無面板缺檔 warn。

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts tests/serverTools.test.ts tests/serverIntegration.test.ts tests/toolAnnotations.test.ts
git commit -m "feat(workbench): TOOLS 換上 be2_open_workbench,移除 batch/announcement 舊入口"
```

---

### Task 9: eval 案例

新增工作台的 agent-eval 案例（仿既有 `eval/` 案例）。無 `ANTHROPIC_API_KEY` 時 `npm run eval` SKIP、不算失敗。

**Files:**
- Modify: `eval/run-eval.ts`（**必先修**：其 `tools` 陣列寫死 `openBatchWizardTool`、`SYSTEM` 提示提及 `be2_open_batch_wizard`；換成 `openWorkbenchTool` / `be2_open_workbench`，否則新案例的 model 拿不到工作台 tool、全數失敗）
- Create/Modify: `eval/`（新增 4 案例；實作前對齊既有案例檔格式）

**Interfaces:**
- Produces: 4 個案例——(1) 上下架混方向被拒（單一方向）、(2) draft-only：未經批准不得宣稱完成、(3) scope-gate：未載入商品即 stage 被擋、(4) 公告：貼上 skill JSON→勾選語系→草稿（不直接寫）。

- [ ] **Step 1: 修 run-eval.ts 的 tool 注入 + 對齊既有 eval 格式**

先讀 `eval/run-eval.ts`：把 `import { openBatchWizardTool }` 換成 `import { openWorkbenchTool }`、`tools` 陣列對應替換、`SYSTEM` 提示裡 `be2_open_batch_wizard` 改 `be2_open_workbench`。再讀既有案例檔了解 schema（案例陣列/斷言形狀）。

- [ ] **Step 2: 新增 4 案例**（照既有格式，內容如上 Interfaces）

- [ ] **Step 3: 跑 eval（文件化 SKIP 亦可）**

Run: `npm run eval`　Expected: 有 key 則案例通過；無 key 則 SKIP（不算失敗）。

- [ ] **Step 4: Commit**

```bash
git add eval/
git commit -m "test(workbench): 新增 4 個工作台 eval 案例"
```

---

## 完成後驗收（whole-branch）

- `npm run ci` 全綠（build-ui + typecheck + 全部 vitest）。
- `npm run build:ui` 產出 `dist/ui/workbench.html`。
- dev server `/healthz` = ok、無面板缺檔 warn。
- Apps host（Claude Desktop）真人冒煙：`be2_open_workbench` 開面板 → 三功能各切一次 → 載入商品 → 各次模式 stage 一筆 → 檢視顯示拆批 → 批准（面板 nonce 或確認頁）→ 結果。（live 寫入受 per-env 403 既知卡點，見 spec §10；能到 draft/檢視即算面板驗收通過。）

## 未竟項（帶進實作、非阻擋）

見 spec §10：公告 startTime/endTime 時區語意、prodOids 陣列上限（若有上限，Task 7 Step 2 的公告送出改「按上限分塊多次 create」）、shelf_toggle_bundle live 寫入契約、live 寫入授權 403、名稱搜尋 v2。

<!-- agy-peer-reviewed: 2026-08-21T17:18:06Z rounds=3 verdict=approved -->
