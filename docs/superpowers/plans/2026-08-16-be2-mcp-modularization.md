# be2 MCP Phase 5 模組化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **本 repo 分工鐵則（memory `agy-work-allocation`）**：每個 task 的實作由 **agy**（`--mode accept-edits`）執行；Claude 只負責編排、下 task brief、review agy 產出、跑驗證、commit。

**Goal:** 把 5 個既有 action_type 的 domain 邏輯收進「每 action_type 一包」的 module + registry，core 對 item/diff 不再做任何欄位判別——行為不變、428 tests 全綠。

**Architecture:** 依 spec `docs/superpowers/specs/2026-08-16-be2-mcp-modularization-design.md`（agy APPROVED rounds=2）。core（store/CAS/nonce/scope/budget/audit/pipeline/approveAndExecute）已是 type-agnostic；本計畫把 5 個熱點（create if 鏈、diffVersionHash、itemKeysOf、executeChangeSet、confirmRoutes.render + UI itemKeyOf）改為 registry lookup，並把 per-type 實作搬進 `src/modules/product/<action>/`。

**Tech Stack:** TypeScript、zod、vitest、esbuild（`scripts/build-ui.mjs` 面板 bundle）。

## Global Constraints

- **行為不變**：MCP 工具介面、確認頁行為、面板 wire 契約（`app_get_batch_view`/`app_create_changeset`/`app_confirm_changeset`）、audit event shape、錯誤碼（`INVALID_ITEMS`/`SCOPE_NOT_READ`/`ACTION_NOT_ALLOWED`/`ACTION_CODE_UNVERIFIED`/`CONFIRMED_KEYS_MISMATCH`…）全部不變。
- 每個 task 結尾 `npm run ci`（typecheck + test）**全綠**才 commit；任一步紅燈回退修復，不帶病前進。
- 既有測試**語義不改**，只允許 import path 搬移。
- module 內**禁止 `Date.now()`**（時間一律注入）；module 不 import OTel（span 經 `ExecCtx.span`）。
- `src/modules/**/keys.ts` 與 `ui.ts` 為 **isomorphic leaf**：不得 import server-only 依賴（db/undici/node:crypto/OTel/gateway）——esbuild bundle 會天然擋 node built-in，但 review 仍須檢查。
- 憑證永不印出/commit（`.env` 規範不變）。
- Commit 訊息照 repo 慣例（繁中、`feat(5):`/`refactor(5):`/`docs(5):` 前綴）。

## File Structure（終態）

```
src/core/changeset/
  module.ts        ActionModule/DiffCtx/ExecCtx/ConfirmView/ValidationResult 介面（新）
  registry.ts      registerModule/getModule/listModules（新）
  store.ts approvalNonce.ts confirmService.ts executor.ts tools.ts types.ts
                   ↑ 自 src/changeset/ 搬入（Task 7），per-type 分支已在 Task 3-6 移除
src/modules/index.ts                 唯一註冊入口（新）
src/modules/product/
  common.ts                          extractPackagesWithSupplier 等跨 action helper（自 batchView.ts 抽）
  shelfToggle/{keys,module,diff,executor,renderer}.ts        （含 product/plan 兩個 registry 條目）
  inventorySetting/{keys,module,validate,diff,executor,renderer}.ts
  inventoryPlatform/{keys,module,validate,diff,executor,renderer,ui}.ts
  shelfSchedule/{keys,module,validate,diff,executor,renderer,ui}.ts
tests/core/registry.test.ts          registry 行為（新）
tests/core/moduleConformance.test.ts conformance harness（新）
docs/be2-mcp/module-catalog.md       module 目錄（新）
docs/be2-mcp/module-onboarding.md    新 action_type 上車 checklist（新）
```

**keys.ts 的存在理由（bundle 安全）**：`module.ts` 會 import executor（→ gateway/OTel，server-only），面板 bundle 不能碰；`itemKey`（server 與 UI 的單一事實來源）必須住在 pure leaf `keys.ts`，`module.ts` 與 `ui.ts` 各自 import 它。

---

### Task 1: core 介面 + registry

**Files:**
- Create: `src/core/changeset/module.ts`
- Create: `src/core/changeset/registry.ts`
- Test: `tests/core/registry.test.ts`

**Interfaces（Produces——後續所有 task 依賴，簽名以此為準）：**

```ts
// src/core/changeset/module.ts
import type { z } from 'zod'
import type { ToolContext } from '../../tools/types.js'
import type { ChangeSetRecord, ItemResult } from '../../changeset/types.js'

// diff 計算的 ctx = 既有 diff 函式實際吃的 ToolContext（src/tools/types.ts:5
// {gateway, accessToken, userLabel}）——純重構：不縮水、不重造。
export type DiffCtx = ToolContext

// 執行期 ctx：批准當下才存在的身分欄位（spec §3；accessToken 為 spec 落地補充——
// 既有 executor 全部用它打 gateway，缺了無法通編譯）。
export interface ExecCtx {
  gateway: import('../../gateway/client.js').GatewayClient
  accessToken: string
  modifyUser: string
  userLabel: string
  sessionId: string
  channel?: 'panel' | 'confirm_page'
  span<T>(name: string, fn: (traceId: string) => Promise<T>): Promise<T>
  now: () => number
}

export interface ValidationResult { key: string; message: string }   // null = 通過（沿用現有慣例）

export interface ConfirmView {
  intro: string          // 表格上方說明段（含 module 高風險警語），HTML 字串
  tableHtml: string      // <table …> 本體（含 data-diff-version 屬性）
}

export interface ActionModule<Item = unknown, DiffI = unknown> {
  actionType: string
  itemSchema: z.ZodType<Item>
  authz: { codes: string[]; onMissing: 'block' | 'warn' }
  invalidItemsMessage: string          // INVALID_ITEMS envelope 的既有文案（per-type，逐字保留）
  scopeNotReadMessage: string          // SCOPE_NOT_READ envelope 的既有文案（per-type，逐字保留）
  isItem(i: unknown): i is Item        // 既有 runtime type-guard 搬入（zod 驗過形仍需窄化）
  scopeOids(item: Item): string[]      // scope gate 查的 oids；同時是 readOidsOut 來源
  scopeErrorKey(item: Item): string    // SCOPE_NOT_READ 的 key 欄位值（既有 per-type 規則逐字保留）
  validate(items: Item[], nowMs: number): ValidationResult | null
  computeDiff(ctx: DiffCtx, items: Item[]): Promise<DiffI[]>
  diffVersion(diff: DiffI[]): string
  itemKey(d: Item | DiffI): string
  execute(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]>
  renderConfirm(rec: ChangeSetRecord, diff: DiffI[], diffVersion: string, banner: string): ConfirmView
                                       // banner = route 層動態紅字（stale/CAS），module 當不透明字串
                                       // 放在自己現行頁面的精確位置（Task 6 說明）
  wizard?: unknown                     // 佔位型別；Task 8 定為 WizardDescriptor（僅 batch 型）
}
```

```ts
// src/core/changeset/registry.ts
import type { ActionModule } from './module.js'
import { AppError } from '../../errors.js'

const modules = new Map<string, ActionModule>()

export function registerModule(m: ActionModule): void {
  if (modules.has(m.actionType)) throw new Error(`duplicate module: ${m.actionType}`)
  modules.set(m.actionType, m)
}
export function getModule(actionType: string): ActionModule {
  const m = modules.get(actionType)
  if (!m) throw new AppError('UNKNOWN_ACTION_TYPE', `no module registered for ${actionType}`, 400)
  return m
}
export function listModules(): ActionModule[] { return [...modules.values()] }
export function resetRegistryForTest(): void { modules.clear() }   // 僅測試用
```

- [ ] **Step 1: 寫失敗測試** `tests/core/registry.test.ts`：(a) `registerModule` 重複註冊 throw `duplicate module`；(b) `getModule` 未註冊 throw `AppError` code `UNKNOWN_ACTION_TYPE`；(c) `listModules` 回註冊順序；(d) `resetRegistryForTest` 清空。用最小 fake module（只填 `actionType` 與必要欄位、其餘 `as unknown as ActionModule`）。
- [ ] **Step 2: 跑測試確認失敗**（模組不存在）：`npx vitest run tests/core/registry.test.ts` → FAIL（cannot find module）。
- [ ] **Step 3: 實作** 上方兩檔逐字落地。
- [ ] **Step 4: 驗證** `npx vitest run tests/core/registry.test.ts` → PASS；`npm run ci` 全綠。
- [ ] **Step 5: Commit** `refactor(5): core ActionModule 介面 + registry（dup/miss fail-fast）`

---

### Task 2: 五個 module 骨架（metadata + validate + keys）+ 註冊入口

**Files:**
- Create: `src/modules/product/shelfToggle/keys.ts`、`src/modules/product/shelfToggle/module.ts`
- Create: `src/modules/product/inventorySetting/keys.ts`、`.../inventorySetting/module.ts`
- Create: `src/modules/product/inventoryPlatform/keys.ts`、`.../inventoryPlatform/module.ts`
- Create: `src/modules/product/shelfSchedule/keys.ts`、`.../shelfSchedule/module.ts`
- Create: `src/modules/index.ts`
- Test: `tests/core/moduleConformance.test.ts`（第一版）

**Interfaces:**
- Consumes: Task 1 的 `ActionModule`/`registerModule`。
- Produces: 5 個已註冊 module（`shelf_toggle_product`、`shelf_toggle_plan` 是兩個條目、同目錄共用實作）；本 task 先填 metadata 欄位（`itemSchema`/`authz`/`invalidItemsMessage`/`scopeNotReadMessage`/`isItem`/`scopeOids`/`scopeErrorKey`/`validate`/`itemKey`），`computeDiff`/`diffVersion`/`execute`/`renderConfirm` 先以「委派既有函式」的 thin wrapper 填上（Task 3-6 逐一實化、core 才改呼叫）。

各 module 欄位值 = 既有 code 逐字搬（來源明確，不是新寫）：

| 欄位 | shelfToggle(product/plan) | inventorySetting | inventoryPlatform | shelfSchedule |
|---|---|---|---|---|
| `itemSchema` | `tools.ts:62-63` 兩個 z.object | `invItemShape`（`tools.ts:38-44`） | `invPlatformItemShape`（`:50-55`） | `shelfScheduleItemShape`（`:56-60`） |
| `authz.codes` | `ACTION_CODES` 對應列（`tools.ts:17-30`，含註解） | 同左 | 同左 | 同左 |
| `authz.onMissing` | `'block'` | `'block'` | `'warn'` | `'warn'` |
| `isItem` | `!isInventoryItem`（shelf 反向檢查，`tools.ts:152`）→ 改寫成正向 guard：`typeof prod_oid==='string' && typeof target_is_active==='boolean'`（plan 另要求 pkg_oid）——**行為以既有 createChangeset 測試 pin** | `isInventoryItem`（`:78-79`） | `isInventoryPlatformItem`（`:81-85`） | `isShelfScheduleItem`（`:87-90`） |
| `scopeOids` | **product 與 plan 皆為** `[prod_oid, ...(pkg_oid ? [pkg_oid] : [])]`（`tools.ts:156` 對兩型一體適用——product 帶了多餘 pkg_oid 時現行也會檢查並可 SCOPE_NOT_READ 擋下，行為逐字保留、勿「邏輯上更乾淨」地丟掉 pkg_oid） | `[item_oid]`（`:111`） | `[item_oid]`（`:127`） | `[prod_oid, pkg_oid]`（`:143`） |
| `scopeErrorKey` | `pkg_oid ?? prod_oid`（`:159`） | `item_oid`（`:114`） | `item_oid`（`:130`） | `pkg_oid`（`:146`） |
| `validate` | 無語義驗證 → `() => null` | `validateInventoryItems(items, nowMs)`（inventoryValidate.ts:8） | `validateInventoryPlatformItems(items)`（batchValidate.ts:37；忽略 nowMs） | `validateShelfScheduleItems(items, () => nowMs)`（batchValidate.ts:66 原簽名吃 `() => number`，wrapper 包一層） |
| `itemKey`（keys.ts） | `pkg_oid ? \`${prod_oid}:${pkg_oid}\` : prod_oid`（executor.ts:184-186） | `\`${item_oid}:${supplier_oid}\``（confirmService.ts:57） | 同 inventorySetting（confirmService.ts:57） | `\`${prod_oid}:${pkg_oid}\``（confirmService.ts:66） |
| `invalidItemsMessage`/`scopeNotReadMessage` | `tools.ts:153/:161` 逐字 | `:105/:116` 逐字 | `:121/:132` 逐字 | `:137/:148` 逐字 |

`validate` 注意：`validateInventoryItems` 回 `{key,message}` 或 falsy、`validateInventoryPlatformItems`/`validateShelfScheduleItems` 回 `string | null`——module wrapper 統一成 `ValidationResult | null`，**string 版包成 `{ key: actionType, message }`**（= `tools.ts:125/:141` 現行 envelope key 用 actionType 的行為，逐字保留）。

```ts
// src/modules/index.ts
import { registerModule } from '../core/changeset/registry.js'
import { shelfToggleProductModule, shelfTogglePlanModule } from './product/shelfToggle/module.js'
// …（4 檔 5 條目）
export function registerAllModules(): void {
  registerModule(shelfToggleProductModule)
  registerModule(shelfTogglePlanModule)
  registerModule(inventorySettingModule)
  registerModule(inventoryPlatformModule)
  registerModule(shelfScheduleModule)
}
```

`tests/core/moduleConformance.test.ts` 第一版（對 `listModules()` 每個 module 自動跑）：

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { listModules, resetRegistryForTest } from '../../src/core/changeset/registry.js'
import { registerAllModules } from '../../src/modules/index.js'

// 各 module 一筆合法 item 樣本（從既有測試 fixture 取值）
const SAMPLES: Record<string, unknown> = {
  shelf_toggle_product: { prod_oid: '546965', target_is_active: false },
  shelf_toggle_plan: { prod_oid: '546965', pkg_oid: '888', target_is_active: false },
  inventory_setting: { item_oid: '1713281', supplier_oid: '0', op: 'set', quantity: 5, dates: ['2027-01-01'] },
  inventory_platform: { item_oid: '1713281', supplier_oid: '0', target: 'BE2_SCM', affected_pkgs: [{ prod_oid: '34133', pkg_oid: '1', pkg_name: 'x' }] },
  shelf_schedule: { prod_oid: '34133', pkg_oid: '1', queue: [{ reserve_date_utc: '2027-01-01 00:00:00', reserve_status: true }] },
}

beforeAll(() => { resetRegistryForTest(); registerAllModules() })

describe('module conformance', () => {
  it('union 成員 ⇔ registry 一一對應', () => {
    expect(listModules().map(m => m.actionType).sort()).toEqual(Object.keys(SAMPLES).sort())
  })
  for (const [type, sample] of Object.entries(SAMPLES)) {
    it(`${type}: itemSchema 接受自己的樣本`, () => { /* getModule(type).itemSchema.parse(sample) 不 throw */ })
    it(`${type}: itemSchema+isItem 拒絕其他 module 的樣本`, () => { /* 對每個他型樣本：schema.safeParse 失敗 或 isItem=false（互斥性） */ })
    it(`${type}: itemKey(item) 非空且不含 undefined`, () => { /* expect(key).toBeTruthy(); expect(key).not.toMatch(/undefined/) */ })
    it(`${type}: scopeOids 非空且全為非空字串`, () => { /* … */ })
  }
})
```

（註：`shelf_toggle_plan` 樣本對 `shelf_toggle_product` 的 schema 是**合法**的——product schema 不排斥多餘欄位與否取決於 zod strict 設定；互斥性測試以「`isItem` 或 schema 至少一者拒絕」為判準，兩個 shelf 條目彼此豁免、以既有 create 測試 pin 行為。）

- [ ] **Step 1: 寫 conformance 測試**（上方骨架補完整，先 FAIL：modules 不存在）。
- [ ] **Step 2: 實作 4 個 keys.ts + 4 個 module.ts + index.ts**。metadata 逐字搬表格所列來源；`computeDiff`/`diffVersion`/`execute`/`renderConfirm` 此階段為 thin wrapper：`computeDiff: (ctx, items) => computeChangesetDiff(actionType, items, ctx)`、`diffVersion: diffVersionHash`、`execute: () => { throw new Error('not wired until Task 5') }`、`renderConfirm: () => { throw new Error('not wired until Task 6') }`（core 尚未呼叫，不影響行為）。
- [ ] **Step 3: 驗證** `npx vitest run tests/core/moduleConformance.test.ts` PASS；`npm run ci` 全綠（既有測試不受影響——core 尚未改）。
- [ ] **Step 4: Commit** `refactor(5): 五個 action module 骨架（metadata/validate/keys）+ registry 註冊 + conformance 第一版`

---

### Task 3: create 路徑改 registry

**Files:**
- Modify: `src/changeset/tools.ts`（`createChangesetCore` `:100-220`、`itemShape` `:61-67`、`businessListAllowsAction` `:32-36`、`ACTION_CODES` `:17-30`）
- Modify: `src/modules/index.ts`（註冊時機修正，見下）

**註冊時機（agy plan-review round 1 issue 1——不修會 import 時 crash）**：ESM import 求值先於 `app.ts` 的啟動碼；若 `tools.ts` 在模組頂層用 `listModules()` 組 zod union，當下 registry 是空的（`z.union` 至少要兩元素，直接 throw）。修法：**註冊改為 `src/modules/index.ts` 的 import 副作用**——該檔頂層直接執行 `registerAllModules()`（函式內冪等：已註冊同名即 skip），`tools.ts` 檔頭 `import '../modules/index.js'` 觸發註冊後才求值 union；`app.ts` 與測試 harness 照樣 import（冪等、無害）。**循環依賴守則**：`src/modules/**` 永不 import `tools.ts`/`createChangesetCore`（方向恆為 core→module 的 registry lookup 與 tools→modules/index 的註冊觸發；`INVENTORY_ACTION_CODES` 的 re-export 是 tools→module 方向，合規）。`action_type` 的 `z.enum` 同樣改由 registry 生成：`z.enum(listModules().map(m => m.actionType) as [string, ...string[]])`——否則加新 module 仍要碰 core，違反目標。

**Interfaces:**
- Consumes: Task 2 的 registry（`getModule`）與各 module metadata。
- Produces: `createChangesetCore` 內不再有 per-type if 鏈；`ACTION_CODES`/`isXxxItem`/散落訊息常數自 `tools.ts` 刪除（搬進 module）。`INVENTORY_ACTION_CODES` export 保留（測試引用），改 re-export 自 inventorySetting module。

`createChangesetCore` 改寫核心（完整新流程）：

```ts
export async function createChangesetCore(args: Record<string, unknown>, ctx: L2ToolContext) {
  const actionType = args.action_type as ActionType
  const mod = getModule(actionType)
  const rawItems = args.items as unknown[]
  if (!rawItems.every(i => mod.isItem(i))) {
    return makeEnvelope([], [{ key: actionType, code: 'INVALID_ITEMS', message: mod.invalidItemsMessage }])
  }
  const items = rawItems as AnyChangeSetItem[]
  const bad = mod.validate(items, ctx.now())
  if (bad) return makeEnvelope([], [{ key: bad.key, code: 'INVALID_ITEMS', message: bad.message }])
  // §6.2 scope-binding gate（規則統一：任一 scopeOid 未讀過即擋，key 用 module.scopeErrorKey）
  const notRead = items.filter(i => mod.scopeOids(i).some(oid => !ctx.readOids.has(ctx.sessionId, oid)))
  if (notRead.length) {
    return makeEnvelope([], [{
      key: notRead.map(i => mod.scopeErrorKey(i)).join(','),
      code: 'SCOPE_NOT_READ',
      message: mod.scopeNotReadMessage,
    }])
  }
  // businessList fail-fast：block/warn 由 module.authz.onMissing 決定，文案逐字沿用 tools.ts:175-181。
  // businessListAllows = 既有 businessListAllowsAction（tools.ts:32-36）重構版：第二參數改吃
  // codes: string[]（不再內部查 ACTION_CODES 表），其餘逐字保留；留在 tools.ts 並維持 export
  // （既有測試若引用 businessListAllowsAction 名稱，保留同名 thin wrapper 委派之）。
  const warnings: EnvelopeError[] = []
  if (!businessListAllows(ctx.businessList, mod.authz.codes)) {
    if (mod.authz.onMissing === 'warn') warnings.push({ key: actionType, code: 'ACTION_CODE_UNVERIFIED', message: /* :178 逐字 */ })
    else return makeEnvelope([], [{ key: actionType, code: 'ACTION_NOT_ALLOWED', message: /* :181 逐字 */ }])
  }
  try {
    ctx.rateBudget.consumeChangeset(ctx.userLabel)
    const diff = await mod.computeDiff({ gateway: ctx.gateway, accessToken: ctx.accessToken, userLabel: ctx.userLabel }, items)
    const diffVersion = mod.diffVersion(diff)
    /* store.create 段照舊（tools.ts:189-202 原樣） */
    const readOidsOut = [...new Set(items.flatMap(i => mod.scopeOids(i)))]
    ctx.emitConfirmUrl(id, `${ctx.baseUrl}/confirm/${id}`)
    return makeEnvelope([{ changeset_id: id, status: 'pending_approval', diff: { items: diff } }], warnings, readOidsOut)
  } catch (e) { return makeEnvelope([], [toEnvelopeError('create_changeset', e)]) }
}
```

行為差異檢查點（必須為零差異，靠既有測試 pin）：
- shelf 的 SCOPE_NOT_READ key 規則 `pkg_oid ?? prod_oid`、schedule 用 `pkg_oid`、inventory 系用 `item_oid` → 全在 `scopeErrorKey` 保留。
- `readOidsOut` 原規則（`tools.ts:203-205`）：inventory 系=item_oid 去重、shelf 系=prod+pkg 去重 → `scopeOids` flatMap 去重後**逐 type 等價**（inventory 系 scopeOids=[item_oid]、shelf 系=[prod_oid,(pkg_oid)]、schedule=[prod_oid,pkg_oid]——schedule 原本 readOidsOut 走 shelf 分支同樣輸出 prod+pkg，等價）。
- `itemShape`（zod union）維持不變（`createChangesetInputShape` 是 wire 契約、appTools 亦引用）；本 task 改由 `z.union(listModules().map(m => m.itemSchema))` 組裝——順序照註冊順序（product、plan、inv、platform、schedule = 現行 union 順序，zod union 逐一嘗試、順序敏感，**必須保持現行順序**）。

- [ ] **Step 1:** agy 改寫 `tools.ts` 如上；`app.ts` 啟動註冊。
- [ ] **Step 2: 驗證** `npm run ci` 全綠——特別看 `createChangeset*.test.ts` 4 檔、`appCreateChangeset.test.ts`、`capabilityGate.test.ts`。
- [ ] **Step 3: Commit** `refactor(5): createChangesetCore 改 registry——if 鏈/ACTION_CODES/type-guards 收進 module`

---

### Task 4: diff 路徑改 registry（computeDiff / diffVersion / itemKey）

**Files:**
- Modify: `src/changeset/diff.ts`（刪 `diffVersionHash` `:16-51` 與 `computeChangesetDiff` 的 dispatcher `:64-71`；`computeShelfDiff` 與 `DiffError` 保留待 Task 7 搬）
- Modify: `src/changeset/confirmService.ts`（`:95-96` 改 `mod.computeDiff`/`mod.diffVersion`；刪 `itemKeysOf` `:55-69` 改 `rec.items.map(i => mod.itemKey(i))`）
- Modify: `src/server/confirmRoutes.ts`（GET 的 liveDiff `:178` 同改）
- Modify: 各 module.ts：`computeDiff` 指向自己的 diff 函式（shelfToggle→`computeShelfDiff`、inventorySetting→`computeInventoryDiff`、…）；`diffVersion` 實化為**自己那段 hash canon**（自 `diff.ts:16-51` 對應分支逐字拆出，含註解），`sha256(canon.sort().join('|'))` 的外殼在各 module 內各自做（hash 值必須與現行完全相同——同輸入同輸出，`confirmService.test.ts`/`changesetDiff.test.ts` 的既有 stale 測試 pin）。

**Interfaces:**
- Consumes: Task 2 module 骨架。
- Produces: `diffVersionHash`/`itemKeysOf` 兩個熱點消滅；`computeChangesetDiff(actionType, items, ctx)` 保留為 deprecated thin wrapper `getModule(actionType).computeDiff(ctx, items)`（呼叫點多，Task 7 收尾時 inline 刪除）。

hash 等價性關鍵（**逐字拆、不重設計**）：現行 `diffVersionHash` 是「全 diff 陣列 map 出 canon 字串 → sort → join('|') → sha256」。單一 change-set 的 diff 全部同型，故把對應分支的 canon 規則搬進該 module 的 `diffVersion`、外殼不變，輸出 bit-for-bit 相同。各 module canon 來源：platform=`diff.ts:25-27`、schedule=`:35-38`、inventory=`:40-45`（含 op 分支）、shelf=`:47-48`。

- [ ] **Step 1:** agy 實作上述搬移。
- [ ] **Step 2: 驗證** `npm run ci` 全綠——特別看 `changesetDiff/inventoryDiff/platformDiff/scheduleDiff/confirmService/appConfirm` 測試（stale/hash pin 全在這幾檔）。
- [ ] **Step 3: Commit** `refactor(5): diffVersion/itemKey 判別權下放 module——order-sensitive duck-typing 熱點消滅`

---

### Task 5: executor 收斂（core 外殼 + module.execute）

**Files:**
- Modify: `src/changeset/executor.ts`（`executeChangeSet` `:33-179` 改 core 外殼；`execProduct`/`execPlan`/`configEntries`/`SWITCH_READONLY`/`PLAN_PKG_READONLY` `:184-251` 搬去 `src/modules/product/shelfToggle/executor.ts`）
- Modify: `src/modules/product/*/executor.ts`（自 `executorInventory.ts`/`executorPlatform.ts`/`executorSchedule.ts` 原樣搬入 + 以 `ExecCtx` 重接）
- Delete: `src/changeset/executorInventory.ts`、`executorPlatform.ts`、`executorSchedule.ts`（搬空後刪）

**Interfaces:**
- Consumes: Task 1 `ExecCtx`；Task 4 後 module 已持 diff 能力。
- Produces: core `executeChangeSet` 唯一版本（下方完整 code）；各 module `execute(ctx, rec)` 回 `ItemResult[]`。

core 外殼（完整——這是四段樣板收斂成的一份）：

```ts
export async function executeChangeSet(deps: ExecutorDeps, changesetId: string, who: ExecutorIdentity): Promise<{ status: 'done' | 'partial' | 'failed'; results: ItemResult[] }> {
  const rec = deps.changeSets.get(changesetId)
  if (!rec) throw new AppError('NOT_FOUND', 'change-set not found', 404)
  if (rec.status !== 'approved') throw new AppError('BAD_STATE', `change-set is ${rec.status}, not approved`, 409)
  deps.changeSets.setStatus(changesetId, 'executing')
  const mod = getModule(rec.actionType)
  const tracer = trace.getTracer('be2-mcp')
  const ctx: ExecCtx = {
    gateway: deps.gateway, accessToken: who.accessToken, modifyUser: who.modifyUser,
    userLabel: who.userLabel, sessionId: who.sessionId, channel: who.channel, now: deps.now,
    span: (name, fn) => tracer.startActiveSpan(name, async span => {
      try { return await fn(span.spanContext().traceId) } finally { span.end() }
    }),
  }
  let results: ItemResult[]
  try {
    results = await mod.execute(ctx, rec)
  } catch (e) {
    // 整批兜底（與現行三個 batch 分支的 .catch 等價）：每 item 一筆 failed
    results = rec.items.map(it => ({
      item_key: mod.itemKey(it), status: 'failed' as const,
      error_code: 'EXEC_ERROR', error_message: (e as Error).message, trace_id: 'n/a',
    }))
  }
  deps.changeSets.recordResults(changesetId, results)
  for (const r of results) {
    deps.audit.record({
      userLabel: who.userLabel, sessionId: who.sessionId, clientInfo: clientInfoFor(who), tool: 'changeset.execute',
      params: { changeset_id: changesetId, item: r.item_key },
      status: (r.status === 'done' || r.status === 'skipped_noop') ? 'ok' : 'error',
      errorMessage: r.error_message, traceId: r.trace_id, durationMs: 0,
    })
  }
  const status = results.every(r => r.status === 'done' || r.status === 'skipped_noop') ? 'done'
    : results.every(r => r.status === 'failed') ? 'failed' : 'partial'
  deps.changeSets.setStatus(changesetId, status, deps.now())
  return { status, results }
}
```

各 module `execute` 的搬法（語義零改動的關鍵細節）：
- **inventorySetting**：`executor.ts:43-72` 的「逐 item 序列 + 每 item 一個 span + 單 item .catch → failed」整段搬進 module：`for (const it of rec.items) { const r = await ctx.span('changeset.execute/inventory_setting', tid => execInventory({gateway: ctx.gateway}, ctx.accessToken, ctx.modifyUser, it, tid)).catch(e => ({…failed…})); results.push(r) }`。**per-item .catch 在 module 內保留**（單 item 失敗不吞整批——core 兜底只接「整個 execute throw」的情境，兩層語義與現行相同）。in-process per-key mutex（executorInventory.ts:23）原樣搬。
- **inventoryPlatform / shelfSchedule**：`executor.ts:74-98/:100-124` 的「單 span 包整批 + .catch → 全 failed」搬進 module（.catch 移除亦可——core 兜底等價；**保留原樣以求零行為差**：module 內自 .catch）。
- **shelfToggle**：`executor.ts:126-162` 的 byOid 分組、逐 group span、group .catch → 該組 failed，整段搬進 module（`execProduct`/`execPlan` 同檔搬入）。
- `ExecutorIdentity`/`clientInfoFor`/`ExecutorDeps` 留在 core executor.ts（audit 樣板是 core 職責）。

- [ ] **Step 1:** agy 實作。
- [ ] **Step 2: 驗證** `npm run ci` 全綠——特別看 `changesetExecutor/inventoryExecutor/executorPlatform/executorSchedule` 4 檔（測試檔照舊、只改 import path 指向 module）。
- [ ] **Step 3: Commit** `refactor(5): executor 四段樣板收斂 core 外殼——module.execute + ExecCtx.span 粒度不變`

---

### Task 6: renderConfirm（ConfirmView + core 頁殼）

**Files:**
- Modify: `src/server/confirmRoutes.ts`（刪四個 renderXxxPage `:35-114` 與 `render` `:116-123`；新增 `renderShell`）
- Modify: 各 module.ts / 新增各 `renderer.ts`：四個 renderer 的 intro+table 邏輯搬入，回 `ConfirmView`

**Interfaces:**
- Consumes: Task 1 `ConfirmView`。
- Produces: `renderShell(id, view: ConfirmView, diffVersion, banner)` in confirmRoutes.ts。

core 頁殼（完整——四頁共通部分逐字合一；**banner 傳入 module**，見下）：

```ts
function renderShell(id: string, view: ConfirmView, diffVersion: string): string {
  return `<!doctype html><meta charset=utf-8><title>確認變更 ${esc(id)}</title>
<style>body{font-family:sans-serif;max-width:820px;margin:2rem auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px}button{padding:8px 16px;font-size:1rem}</style>
<h1>確認 change-set ${esc(id)}</h1>${view.intro}
${view.tableHtml}
<form method=post action="/confirm/${esc(id)}/approve" style="margin-top:1rem">
  <input type=hidden name=diff_version value="${esc(diffVersion)}">
  <button type=submit>批准並執行</button></form>
<form method=post action="/confirm/${esc(id)}/reject"><button type=submit>拒絕</button></form>`
}
```

**banner 傳遞（agy plan-review round 1 issue 2——spec §3「core 保留注入點」的落地修正）**：現行四頁的 banner 相對位置不一致（shelf/platform 在 h1 後、inventory/schedule 在警語後），單一固定注入點無法在「不改測試」約束下滿足全部既有斷言。落地改為：`renderConfirm(rec, diff, diffVersion, banner: string)`——core 把 banner 當**不透明字串**傳入，module 把它放在**自己現行頁面的精確位置**（intro 內嵌），`ConfirmView.intro` 已含 banner。banner 語義（stale/CAS 紅字）仍由 route 層產生、module 不解讀——spec 的安全意圖（route 層狀態不外洩給 module 邏輯）不變，僅注入位置的所有權下放。Task 1 的 `ActionModule.renderConfirm` 簽名同步定為四參數版（實作 Task 1 時即用此簽名，本 plan 為準）。

module 拆分規則：`intro` = 各頁 `<h1>` 之後、`<table>` 之前的說明段 + banner（shelf=`confirmRoutes.ts:39-40`、inventory=`:61-62`、platform=`:85-86`、schedule=`:107-108`——**逐字，含 banner 的現行相對位置**）；`tableHtml` = `<table data-diff-version=…>…</table>` 整段（rows 邏輯逐字搬）。`esc()` 搬到 `src/core/changeset/html.ts` export，confirmRoutes 與各 module renderer 共用。

- [ ] **Step 1:** agy 實作。
- [ ] **Step 2: 驗證** `npm run ci` 全綠——特別看 `confirmRoutes/confirmRoutesInventory/confirmRoutesPlatform/confirmRoutesSchedule` 4 檔。
- [ ] **Step 3: Commit** `refactor(5): 確認頁 renderer 收進 module（ConfirmView）+ core 頁殼統一 banner 注入點`

---

### Task 7: 搬檔定位（core/ 與 modules/ 目錄成形）

**Files:**
- Move: `src/changeset/{store,approvalNonce,confirmService,executor,tools,types}.ts` → `src/core/changeset/`（`types.ts` 中 per-type Item/Diff interface 各自搬到所屬 module 的 `types.ts` 或 `keys.ts` 旁；`ActionType`/`ChangeSetStatus`/`ItemResult`/`ChangeSetRecord`/`AnyChangeSetItem`/`AnyDiffItem` union 留 core——union 由 core 以 module 型別組裝或維持顯式 union 均可，以 `tsc` 與測試綠為準）
- Move: `src/changeset/{diff→shelfToggle/diff, inventoryDiff, inventoryValidate, platformDiff, platformRead, scheduleDiff}.ts` 與 `batchValidate.ts` → 對應 `src/modules/product/<action>/`；`batchValidate.ts` 拆兩半（platform 段→inventoryPlatform/validate.ts、schedule 段→shelfSchedule/validate.ts、`sanitizeQueue`/`platformToBooleans` 跟隨使用者）
- Move: `src/tools/batchView.ts` 的 `extractPackagesWithSupplier`/`extractPackageConfigMap`/`resolveCurrentPlatform`（`:44-119`）→ `src/modules/product/common.ts`（batchView 改 import；platformDiff 已 import 者同步改）
- Modify: 全 repo import path（`src/`、`tests/`、`scripts/`、`eval/`）
- Delete: `src/changeset/`（清空後移除）

**Interfaces:** 純搬移，無新介面。`DiffError` 留 core（envelope 對它有依賴）。

- [ ] **Step 1:** agy 執行搬移 + import 全面修正（`git mv` 保留歷史）。
- [ ] **Step 2: 驗證** `npm run ci` 全綠 + `npm run dev` 可啟動（smoke：`curl 127.0.0.1:8787/healthz`）。
- [ ] **Step 3: Commit** `refactor(5): 目錄定位——core/changeset 與 modules/product/<action> 成形`

---

### Task 8: UI 單一事實來源（itemKey + per-type UI 片段）

**Files:**
- Modify: `src/ui/batch-wizard.ts`（刪 `itemKeyOf` `:66-68`、`ACTION_LABELS` `:29-32`；per-type 純函式抽到 module ui.ts 後 import 回來）
- Modify: `src/ui/changeset-panel.ts`（`itemKeyOf` `:19-24` 同改）
- Create: `src/modules/product/inventoryPlatform/ui.ts`、`src/modules/product/shelfSchedule/ui.ts`
- Modify: `scripts/build-ui.mjs`（如 bundle entry 需要 alias/檢查——esbuild 對 node built-in 引用會 fail，天然守門）

**Interfaces:**
- Consumes: 各 module `keys.ts` 的 `itemKey`（isomorphic leaf）。
- Produces: `WizardDescriptor`（Task 1 佔位型別在此定案）：

```ts
// src/core/changeset/module.ts（更新 wizard 欄位型別）
export interface WizardDescriptor {
  label: string                                     // ACTION_LABELS 對應值
  itemKey(d: Record<string, unknown>): string       // = keys.ts 的 itemKey（同一份 re-export）
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[]
                                                    // buildInventoryPlatformItems(:790-801)/
                                                    // buildShelfScheduleItems(:803-806) 重參數化：
                                                    // 吃 plain data、不碰 DOM（isomorphic 純函式）
  renderDiffCard(d: Record<string, unknown>, h: DomHelpers): HTMLElement
                                                    // renderDiffCard 的該型分支（:916-943/:944-971）
  step2WarningText?: string                         // schedule 的整組取代警語（:985）
}
export interface WizardRowInput {
  checked: boolean; is_bundle: boolean
  prod_oid: string; pkg_oid: string; pkg_name: string
  item_oid?: string; supplier_oid?: string
  queue: Array<{ reserve_date_utc: string; reserve_status: boolean }>; cleared: boolean
}
export interface DomHelpers {
  el(tag: string, className?: string): HTMLElement
  text(node: HTMLElement, v: unknown): void         // = panelShared renderText
  renderQueueLines(el: HTMLElement, q: unknown[], emptyLabel?: string): void
}
```

搬移約束：
- `buildItems` 重參數化後，wizard 內 `doNext()`（`:808-809`）改為「把 DOM rows map 成 `WizardRowInput[]` → 呼叫 descriptor.buildItems」——輸出陣列必須與現行 bit-for-bit 相同（`tests/ui/batchWizard.test.ts` 1186 行 pin）。
- `renderDiffCard` 的 fallback 分支（`:972-974` unknown shape raw dump）留在 wizard 本體。
- module 的 `wizard` 欄位只在 `module.ts` 掛上時**經由獨立 entry**：`ui.ts` 不 import `module.ts`（會拉進 server-only）；wizard bundle 直接 `import { inventoryPlatformWizard } from '.../inventoryPlatform/ui.js'`。`module.ts` 的 `wizard` 欄位同樣 import 自 `ui.ts`（方向：module→ui，永不反向）。
- `changeset-panel.ts` 的 `itemKeyOf` 改為依 diff 形狀選 module keys（它服務 shelf+inventory_setting 單筆面板）：`import { itemKey as invKey } from '.../inventorySetting/keys.js'` 等，判別條件維持現行 `'item_oid' in d`（UI 端判別留著，但 key 規則本體已是同一份函式——手工對齊耦合消滅）。

- [ ] **Step 1:** agy 實作。
- [ ] **Step 2: 驗證** `npm run ci` 全綠（`tests/ui/batchWizard.test.ts`、`tests/ui/panel.smoke.test.ts`）+ `node scripts/build-ui.mjs` 成功產 bundle。
- [ ] **Step 3: Commit** `refactor(5): wizard/panel per-type UI 片段進 module ui.ts——itemKey 單一事實來源`

---

### Task 9: conformance 補完 + 文件 + 全量驗證

**Files:**
- Modify: `tests/core/moduleConformance.test.ts`（補 diffVersion 契約）
- Create: `docs/be2-mcp/module-catalog.md`、`docs/be2-mcp/module-onboarding.md`
- Modify: `CLAUDE.md`（開發指令節補一行 module 結構指引）、`docs/be2-mcp/module-architecture.md`（頂部加「已落地，見 spec/catalog」狀態）

conformance 補測（對每個 module，用該 module 的 diff 樣本——從既有測試 fixture 取）：

```ts
it(`${type}: diffVersion 對相同輸入穩定`, () => { expect(mod.diffVersion(diffSample)).toBe(mod.diffVersion(structuredClone(diffSample))) })
it(`${type}: diffVersion 對 live 現況變動敏感（非恆定 hash）`, () => {
  const mutated = structuredClone(diffSample) /* 改 current/current_queue/current_is_active 任一 live 欄位 */
  expect(mod.diffVersion(mutated)).not.toBe(mod.diffVersion(diffSample))
})
it(`${type}: itemKey(item) === itemKey(對應 diff item)`, () => { /* 同一筆資料 item 與 diff 兩形算出同 key */ })
```

（註：inventory `adjust` 的 hash 刻意**不綁** current——該樣本用 `op:'set'` 測敏感性、另補一筆 `adjust` 樣本斷言「current 變動 hash 不變、dates/quantity 變動 hash 變」，把 op-aware 語義 pin 進 conformance。）

`module-catalog.md` 內容：5 條目表（actionType、item shape、key 形狀、authz codes+onMissing、diff hash 綁什麼、executor 形狀（序列/批次/分組）、renderer 警語、wizard 有無）。
`module-onboarding.md` 內容：正式化 module-architecture.md §4 checklist——(1) 外部依賴（可寫帳號/businessList 碼/contract probe）→ (2) `src/modules/<domain>/<action>/` 一包（keys/module/validate/diff/executor/renderer/(ui)）→ (3) `registerModule` + union 加值 → (4) conformance 自動繼承 + per-type 測試檔慣例 → (5) eval + 安全測試 → (6) catalog 登記。

- [ ] **Step 1:** agy 實作測試與文件。
- [ ] **Step 2: 全量驗證**：`npm run ci` 全綠（**總數 ≥ 428 + 新增**、0 skipped）；`tsc` clean；`node scripts/build-ui.mjs` 成功；`npm run dev` 啟動 + `/healthz` 200；`npm run eval` 為文件化 SKIP（無 `ANTHROPIC_API_KEY`）。
- [ ] **Step 3: Commit** `refactor(5): conformance 補完（diffVersion/op-aware pin）+ module catalog/onboarding 文件`
- [ ] **Step 4:（Claude 收尾）** live SIT 讀取 smoke（`.env` bearer 跑 L0 三工具 + wizard 面板開啟）——非阻擋，環境不可用時記錄 PENDING。

---

## Self-Review 紀錄

1. **Spec coverage**：§3 介面（Task 1/8）、§4 五熱點（Task 3/4/5/6 + UI Task 8）、§5 目錄與 UI（Task 7/8）、§6 遷移步驟（任務順序即之；adapter 期壓縮為 Task 2 的 thin wrapper、同 PR 內收斂）、§7 conformance（Task 2/9）、§8 文件（Task 9）、§9 風險對策（每 task 驗證步驟 + Task 9 全量）。無缺。
2. **Placeholder 掃描**：無 TBD/TODO；「搬移」步驟皆附來源 file:line 與行為 pin 測試清單（refactor 的 code 真身在 repo，plan 指明出處與零差異檢查點）。
3. **型別一致性**：`ActionModule` 簽名 Task 1 定稿、Task 2-8 全部引用同名欄位；`ExecCtx.span` 簽名 Task 1 與 Task 5 一致（`(name, fn(traceId))`——spec 的 `attrs` 參數在落地時省略，現行 code 未用 span attrs，YAGNI）；`ConfirmView` Task 1/6 一致（spec 的 `tableHtml`+`moduleWarning` 落地為 `intro`+`tableHtml`，`intro` 涵蓋警語與 banner——語義同、命名以四頁實際結構為準）。
4. **對 approved spec 的落地偏差（agy plan-review 修正後彙整）**：(a) `ExecCtx` 增 `accessToken`（executor 打 gateway 必需）；(b) `span` 省略 attrs 參數；(c) `ConfirmView` 欄位改名 + **banner 改為傳入 `renderConfirm`、由 module 決定精確位置**（spec「core 保留注入點」在四頁 banner 位置不一致 + 不改測試的雙約束下不可行——banner 仍為 route 層產生的不透明字串，安全語義不變）；(d) zod union 與 `action_type` enum 由 registry 生成、註冊為 `modules/index.ts` import 副作用（避免 ESM 求值時序 crash）。
