# be2 MCP — Phase 5 模組化（core / domain module 拆分）設計

日期：2026-08-16　狀態：待 agy review
> 搭配讀：`docs/be2-mcp/module-architecture.md`（規劃草稿）、`docs/be2-mcp/be2-mcp-rd-design.md`（現有 SA/SD）。
> 起點：`main` @ `346f5d1`（Phase 1a→4a 全功能、428 tests 綠、雙 action type live 驗證），分支 `feat/modularization`。

## 1. 目標與完成定義（已拍板）

**目標**：core（change-set 治理 / OAuth / MCP Apps 底座 / 稽核 / budget）與 domain module（**每個 action_type 一包**）拆開，使「加一個 action_type」= 寫一包註冊進 registry、**不碰 core**。這是 3b 價格、3c 方案維護、以及未來訂單/公告等新 domain 的地基——MCP 是平台，module 是插件。

**完成定義（DoD，已拍板為「純重構」）**：
- 既有 5 個 `ActionType`（`shelf_toggle_product`、`shelf_toggle_plan`、`inventory_setting`、`inventory_platform`、`shelf_schedule`）全部收進 module 包。
- **行為不變**：對外 MCP 工具介面、確認頁行為、面板行為、audit event shape、錯誤碼全部不變。
- 既有 428 tests 全綠（測試語義不改；允許搬檔/改 import path），`tsc` clean。
- 新增 module conformance test harness（§7）。
- 產出 module catalog 文件 + onboarding checklist 模板（§8）。

**Non-goals（明確不做，介面不排除但不預先設計）**：
- 不接新 domain（訂單/公告）、不做 3b 價格——那是下一波用 onboarding checklist 驗證介面的事。
- 不做 L1/L2/L3 tier 系統（行為不變原則；庫存高風險紅字 banner 隨 renderer 進 module，天然 per-module）。
- 不做唯讀 module、非 change-set 寫入形狀——union 介面留擴充點，不實作。
- 不做 per-deployment module 開關（rollout gating 是另一波）；registry 為編譯期靜態註冊。
- 不動並發模型（in-process mutex / single-flight 維持單機語義，多實例化另案）。

## 2. 現況問題（重構動機，依 code 證據）

新增一個 action_type 目前要碰 **8 個既有檔 + 2~4 個新檔 + 一組測試**。其中 5 處是「散落且判別方式不一致」的高風險熱點，歷次 review 反覆抓到：

| # | 熱點 | 位置 | 風險 |
|---|---|---|---|
| 1 | `diffVersionHash` | `src/changeset/diff.ts:16-51` | **順序敏感 duck-typing**：platform 分支必須排在 `'item_oid' in d` 前否則 crash；schedule 若 fall-through 到 shelf 會產生**恆定 hash → 靜默停用 stale-drift 防護** |
| 2 | `itemKeysOf` | `src/changeset/confirmService.ts:55-69` | 曾實際壞過：platform fall-through 到 shelf `itemKey()` 讀到 `undefined` → 面板批准永久鎖死（`CONFIRMED_KEYS_MISMATCH`） |
| 3 | `executeChangeSet` | `src/changeset/executor.ts:43-179` | 三段 per-type if，每段自帶 span/audit/status 聚合樣板，重複且易漂移 |
| 4 | `render()` | `src/server/confirmRoutes.ts:116-123` | platform 曾 fall-through 到 shelf renderer（空名稱 + 寫死「→ 下架」） |
| 5 | UI `itemKeyOf` | `src/ui/batch-wizard.ts:66`、`src/ui/changeset-panel.ts:19-24` | 用 duck-typing **手工對齊** server 的 `itemKeysOf`，兩邊判別方式不一致，靠註解互相提醒 |

根因：item/diff union（`types.ts:41,94`）**無顯式 discriminant**，全靠「哪個欄位存在」duck-typing，且多型別共用欄位名（`prod_oid`/`pkg_oid`/`item_oid`）。

另一方面，store/CAS/nonce/scope-binding store/rate budget/audit/toolPipeline/appPipeline/`approveAndExecute` **已經 type-agnostic**——core 已存在，只是沒有名字與邊界。

## 3. Module 介面（本 spec 的核心交付）

```ts
// src/core/changeset/module.ts
export interface ActionModule<Item, DiffI> {
  actionType: string                          // registry key，如 'shelf_toggle_product'
  itemSchema: z.ZodType<Item>                 // strict zod shape；create 入口以各 module schema 組 union
  authz: { codes: string[]; onMissing: 'block' | 'warn' }
                                              // businessList action codes + 缺碼時策略
                                              // （現況：platform/schedule 為 warn，其餘 block——語義照搬）
  scopeOids(item: Item): string[]             // §6.2 scope-binding 要查的 oids；同時是 readOidsOut 來源
  validate(items: Item[]): ValidationResult   // 語義驗證（op/quantity 耦合、過去日期、唯一性…）
  computeDiff(ctx: ModuleCtx, items: Item[]): Promise<DiffI[]>
  diffVersion(diff: DiffI[]): string          // ★ hash 貢獻由 module 算；core 不再對 diff 做欄位判別
  itemKey(d: Item | DiffI): string            // ★ 單一事實來源；server 與 UI bundle 同 import
  execute(ctx: ModuleCtx, items: Item[], diff: DiffI[]): Promise<ItemResult[]>
                                              // read-merge-write；core 負責 span/audit/status 聚合
  renderConfirm(rec: ChangeSetRecord, diff: DiffI[]): string
                                              // 確認頁 HTML 片段；高風險 banner 屬 module
  wizard?: WizardDescriptor                   // 批次精靈分頁描述（僅 batch 型：platform/schedule）
}

// core 注入；module 不自己碰 token / raw db / audit 原生
export interface ModuleCtx {
  identity: Identity          // 由 token 推導（input 永不接身分，鐵則 2 不變）
  gateway: GatewayClient      // 已帶身分的下游呼叫
  scope: ScopeChecker         // readOidStore 查詢（core 執行 gate，module 只宣告 scopeOids）
  traceId: string
}
```

設計原則：
- **core 對 items/diff 一律 opaque**（store 現況即以 JSON blob 存，`store.ts:20-22`）。不設計萬用 `ChangeItem`/`Diff` shape——這是對「訂單形狀不同（狀態機、不可逆）」的保險，module-architecture.md §8 Q1 的答案。
- **判別權下放**：core 只用 `rec.actionType` 查 registry，永不對 item/diff 欄位做 duck-typing。熱點 1/2/4 的 fall-through 風險**結構性消滅**。
- **audit 由 core 記**：module 的 `execute` 回 `ItemResult[]`（含 before/after），core 統一做 per-item audit、span、status 聚合（done/partial/failed 規則收成一份，含 Phase 3a 修過的「partial 不 collapse 成 failed」「非 done/skipped_noop 一律記 error」語義）。
- `wizard` 為選配：僅 `inventory_platform`/`shelf_schedule` 有；單筆確認頁型（shelf/inventory_setting）不提供。

### Registry

```ts
// src/core/changeset/registry.ts
export function registerModule(m: ActionModule<any, any>): void   // 重複註冊 = throw
export function getModule(actionType: string): ActionModule<any, any>  // miss = throw（明確錯誤，不 fall-through）
```

- 編譯期靜態註冊：`src/modules/index.ts` 逐一 `registerModule(...)`，server 啟動時 import。
- `ActionType` union 型別保留（`types.ts:1`），並加 exhaustive 測試鎖「union 成員 ⇔ registry 註冊清單」一一對應。

## 4. Core 收斂（5 熱點的去向）

| 熱點 | 改後 |
|---|---|
| `createChangesetCore` if 鏈（`tools.ts:100-220`） | registry lookup：`getModule(action_type)` → `itemSchema` 驗形 → `validate` → `scopeOids` 逐 oid 過 scope gate → `authz` fail-fast（`onMissing` 決定 block/warn）。`readOidsOut` 同源自 `scopeOids` |
| `diffVersionHash`（`diff.ts:16-51`） | 刪除；`module.diffVersion(diff)`。各 module 保留現有 hash 語義（inventory 的 op-aware：`set` 綁現況、`adjust` 綁操作，防 live drift 誤判 stale——測試 pin 不動） |
| `itemKeysOf`（`confirmService.ts:55-69`） | `module.itemKey`。各 type 的 key 形狀不變（platform=`item_oid:supplier_oid`、schedule=`prod_oid:pkg_oid`…），既有 pin 測試照跑 |
| `executeChangeSet`（`executor.ts:43-179`） | core 外殼：取 module → `execute` → 統一 span/audit/status 聚合。`executorInventory/Platform/Schedule` 與 shelf 的 `execProduct`/`execPlan` 內容**原樣搬**進各 module 的 `execute`（含 inventory in-process per-key mutex、schedule 逐 prod 分組、busy-guard 輪詢——語義零改動） |
| `confirmRoutes.render()`（`confirmRoutes.ts:116-123`） | `module.renderConfirm`。四個 renderer 原樣搬進各 module |

`computeChangesetDiff`（`diff.ts:64-71`）同理改 `module.computeDiff`。approve/reject 流程（CAS、nonce、stale 409、live-diff 重算）**一行治理邏輯都不動**，只把其中的 per-type 呼叫換成 module 方法。

## 5. 目錄結構與 UI 策略

```
src/core/changeset/        module.ts(介面) registry.ts store.ts approvalNonce.ts
                           confirmService.ts(approveAndExecute) executor.ts(外殼) tools.ts(create 外殼)
src/modules/index.ts       全部 registerModule 的唯一入口
src/modules/product/
  common.ts                跨 action 共用 helper（packages 讀取 extractPackagesWithSupplier 等，
                           自 batchView.ts 抽出；batchView 保留 batch 檢視組裝、改 import）
  shelfToggle/             module.ts diff.ts executor.ts renderer.ts   （含 product/plan 兩個 module，共用實作）
  inventorySetting/        module.ts validate.ts diff.ts executor.ts renderer.ts
  inventoryPlatform/       module.ts validate.ts diff.ts executor.ts renderer.ts ui.ts
  shelfSchedule/           module.ts validate.ts diff.ts executor.ts renderer.ts ui.ts
```

- `shelf_toggle_product`/`shelf_toggle_plan` 為**兩個 registry 條目**（core 視角一致，無特例），實作放同一目錄共用。
- **UI**：batch-wizard 與 changeset-panel 維持單一 esbuild bundle（`scripts/build-ui.mjs` 不換架構），但 per-type 分支（`itemKeyOf`、item builder、diff card、reload-diff、警語）改為 build 時從各 module 的 `ui.ts` import 組裝。`ui.ts` 是 isomorphic 純函式（不 import server-only 依賴：db/undici/node API），bundle 得進去；`itemKey` 與 server **同一份函式**——熱點 5 的手工對齊耦合消滅。
- 面板↔server 的 wire 契約（`app_get_batch_view`/`app_create_changeset`/`app_confirm_changeset` 的 shape、nonce 通道、app-only gating）**不變**。

## 6. 遷移步驟（每步 `npm run ci` 全綠才走下一步）

1. **立介面 + registry + adapter**：新增 `ActionModule`/registry，先用 adapter 包既有函式註冊 5 個 module（不搬檔、不改行為）。
2. **core 熱點逐一改 registry lookup**（一熱點一 commit）：create → diff/diffVersion → itemKeys → executor 外殼 → confirm renderer。每步刪掉對應的 per-type 分支。
3. **搬檔進 `src/modules/product/<action>/`**，UI 改 import module 的 `itemKey`/UI 片段；`tests/` 對應搬位、改 import path（測試語義不改）。
4. **conformance harness + catalog 文件 + onboarding checklist**（§7/§8）。

風險控制：全程行為不變靠既有 428 tests 押陣；任一步紅燈即回退該 commit 修復，不帶病前進。

## 7. 測試策略

- 既有 428 tests：語義不改、全程綠；僅允許 import path 搬移。
- 新增 **module conformance tests**（`tests/core/moduleConformance.test.ts`）：對 registry 內**每個** module 自動跑同一份契約——
  1. `itemKey(item)` 與 `itemKey(diffItem)` 對同一筆資料一致且非空（防 undefined key 鎖死批准，熱點 2 的通用化）；
  2. `diffVersion` 對 diff 內容變動敏感、對相同輸入穩定（防恆定 hash 靜默停用 stale 防護，熱點 1 的通用化）；
  3. `itemSchema` 拒絕其他 module 的 item 樣本（互斥性——歷次 review 反覆抓的點變成免費回歸）;
  4. union 成員 ⇔ registry 註冊清單一一對應（exhaustive 鎖）。
- 未來 3b 價格上車時，新 module 一註冊即自動繼承整組 conformance tests。

## 8. 產出物（除 code 外）

- `docs/be2-mcp/module-catalog.md`：現支援哪些 module/action、key 形狀、authz codes、風險備註、wizard 有無。
- `docs/be2-mcp/module-onboarding.md`：新 action_type 上車 checklist（正式化 module-architecture.md §4：外部依賴/可寫帳號 → contract probe → readState → 一包五件套 → conformance/eval → catalog 登記）。

## 9. 風險與對策

| 風險 | 對策 |
|---|---|
| 純重構「行為不變」驗證面大 | 每步全綠 + 一熱點一 commit + 最後跑一次 live SIT 讀取 smoke（L0 三工具 + wizard 面板開啟） |
| UI bundle 把 server-only code 拉進面板 | `ui.ts` 限 isomorphic 純函式；build-ui 後跑既有 panel smoke test；esbuild 對 node built-in 的引用會直接 build fail（天然守門） |
| adapter 期（步驟 1-2）新舊兩套並存造成混淆 | adapter 生命週期只跨兩步、同一 PR 內收斂；不留長期兼容層 |
| `shelf_toggle` 拆兩條目後 create 入口的 union 行為漂移 | zod union 改由 registry 組裝時，以既有 createChangeset 測試 + 注入測試 pin 現行為 |
