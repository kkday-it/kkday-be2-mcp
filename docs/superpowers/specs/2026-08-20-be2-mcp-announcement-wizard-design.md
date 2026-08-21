# be2 MCP — 商品公告（announcement）進 wizard 設計

> 日期：2026-08-20　分支基準：`feat/bundle-followup`
> 來源：`docs/be2-mcp/baa-wizard-expansion-handoff.md`（塊 C）+ `docs/be2-mcp/sit-announcement-contract.md`（契約）+ `docs/be2-mcp/module-onboarding.md`（上車 checklist）。
> 對應主 spec：`2026-08-07-be2-mcp-design.md`（治理層）、`2026-08-14-be2-mcp-baa-wizard-design.md`（wizard 底座）。

## 1. 目標與範圍

把「商品公告」接成 be2 MCP 的一個新 `action_type = announcement`，讓員工透過 wizard 面板「選商品 → 填公告 → 批准」批次建立商品公告，全程沿用既有治理（身份貫穿、draft-only、confirm 確認頁 nonce、稽核）。

**In scope（本 spec）**
- 新 `announcement` domain module（首個非 product 形狀 domain）：`src/modules/announcement/create/`。
- 首發動作 = **建立公告（create，全欄位）**：name / is_enabled / prod_oids / start_time / end_time / langs / per-lang content。
- module-local svc-b2c HTTP client（executor 專用；不碰 core `GatewayClient`）。
- 專用建立表單 wizard 面板（獨立入口 `be2_open_announcement_wizard` + `announcement-wizard.html`）。
- `be2_create_changeset` + confirm 確認頁對 announcement 一致可用（registry 自動涵蓋）。

**Out of scope（明確不做）**
- PATCH 更新 / enable-disable 切換既有公告（首發只做 create；未來另開 action）。
- 伺服器端排程器（塊 B）——公告生效時間走**原生 `startTime`/`endTime` 資料欄位**，無需自建排程。
- 折進 `be2_open_batch_wizard` 的 grid 面板（採獨立面板，見 §4.2）。

## 2. 北極星原則（已與使用者定案）

1. **wizard 只是 UX 友善層**；能力靠底層 module + change-set + executor。先確保底層成立。
2. **不做排程**：公告生效走原生 `startTime`/`endTime` 欄位。
3. 本塊獨立跑完整主管線；與 Session 2（庫存數量進 wizard）**幾乎零檔案衝突**（見 §9）。

## 3. 契約錨點（自 `sit-announcement-contract.md`，SIT be2-220 / stage 實攔）

| 項 | 值 |
|---|---|
| host（SIT） | `https://api-gateway-220.sit.kkday.com/svc-b2c/api/v1` |
| host（prod） | `https://api-gateway.kkday.com/svc-b2c/api/v1` |
| 建立 | `POST /admin/product/announcement`（一筆橫跨所有選定 prodOids） |
| 列表 | `GET /admin/product/announcement?page=&perPage=&prodOids=` |
| 成功契約 | HTTP 200 **且** `metadata.status == '0000'`；其餘一律失敗、逐字回報、不自動重試 |
| header | `authorization: Bearer <be2 JWT>` + `x-api-key`（`.env` `SIT_ANNOUNCE_API_KEY`，固定前端 key）+ `user-uuid`（= JWT `platformId` claim）|
| businessList | 寫 `product.announcement.update`；讀 `product.announcement.query` |

list row 欄位（stage 實攔，§6.1）：`productAnnouncementOid:number` / `name:string` / `prodOids:number[]` / `isEnabled:boolean` / `startTime:"YYYY-MM-DD HH:mm:ss"`(UTC+0) / `endTime:string\|null` / `modifyUser:string` / `langs:string`。

create 必填欄位（stage 表單語義，§6.2）：`*Name`(≤254) / `*Is Enabled`(bool) / `*Product Oids`(csv → number[]) / `*Start Time (UTC+0)` / `End Time (UTC+0)`(選填) / `*Select Languages`(多選，25 種，`en-default` 為 en-xx fallback) / 每語系 content（選語系後動態展開）。

**未解 gate（非阻擋開發）**
- **§5 S2S token 403**：be2-mcp 的 auth-service S2S token 打 announcement `/verify` 回 403（web session token 可過）。→ executor 可 build 到 draft、live 200 待授權釐清。與 Phase 3a 庫存 403 同屬「契約已知、live 待授權」。
- **§6.3 POST wire body 確切格式未攔**（欄位鍵名、`prodOids` array vs csv、per-lang content 陣列形狀）——需一次真 create 才攔得到。本 spec 依 §6.2 表單語義做 best-guess，程式標 UNVERIFIED，集中在 executor 一處易改。

## 4. 架構決策

### 4.1 registry-driven，core 觸點最小化

changeset 框架已全動態（`createChangesetInputShape` 的 action_type enum 與 item union 都由 `listModules()` 建構，`src/core/changeset/tools.ts:21-30`）。新增 announcement 只需：
1. 在 `src/modules/announcement/create/` 實作一包 `ActionModule`。
2. `src/modules/index.ts` `registerModule(...)`。
3. `src/core/changeset/types.ts` union 擴充（`ActionType` / `AnyChangeSetItem` / `AnyDiffItem`）——**這是 onboarding 唯一允許的 core 觸點**。

→ `be2_create_changeset`、`app_create_changeset`、confirm 確認頁、稽核、budget 皆自動涵蓋 announcement，無需改 core 邏輯。

### 4.2 獨立 wizard 面板（不折進 be2_open_batch_wizard）

`be2_open_batch_wizard` 的 `uiResourceUri` 是「一 tool 綁一面板」（app.ts tools/list 時靜態掛，`src/server/app.ts:199`），**無法依 action_type 動態切面板**。公告是 create-form、與現有 grid 面板（pkg/item 逐列勾選）天生不同。故：

- 新 model-visible 入口 **`be2_open_announcement_wizard`**（仿 `openBatchWizard.ts`），`uiResourceUri: 'ui://be2/announcement-wizard.html'`。
- 新面板 `src/ui/announcement-wizard.ts` + build 產物 `announcement-wizard.html`。
- **完全不碰 `src/ui/batch-wizard.ts`**（Session 2 在改那支）→ 兩 session 幾乎零衝突。
- `announcement` 仍註冊進 changeset registry，故能力與 `be2_create_changeset`+確認頁一致；只是「面板入口」是 sibling tool 而非 `be2_open_batch_wizard` 的 enum 值。

### 4.3 module-local svc-b2c client（不碰 core GatewayClient）

core `GatewayClient`（`src/gateway/client.ts`）只支援單一 baseUrl、固定 header（`x-auth-id: be2`）、只有 get/put、成功判定看 `meta`/HTTP。公告需要 svc-b2c 前綴 + `x-api-key`/`user-uuid` header + POST + `metadata.status '0000'` 判定，皆超出 core client。

→ 在 module 內建一支輕量 `announcementClient`（`src/modules/announcement/create/svcB2cClient.ts`），從 `.env` 讀 `SIT_ANNOUNCE_API_KEY` 與 host，判 `metadata.status '0000'`。core 完全不動。

**user-uuid header 由 `accessToken` 自解，不預先塞 modifyUser（改自 agy review round 1）**：§3 契約規定**所有** announcement API（含 GET）都需 `user-uuid` header（= JWT `platformId`）。而讀取路徑的 `DiffCtx`(=`ToolContext`) 與 `AppToolContext` **刻意不含 `modifyUser`**（避讀取型 tool 承受解碼負擔），只含 `accessToken`（`src/tools/types.ts:7`、`src/server/appPipeline.ts:21`）。故 svc-b2c client 一律**接 `accessToken`、內部自解 `platformId` 當 user-uuid**（讀 diff、讀 view、寫 executor 三處統一，皆有 accessToken）。解碼邏輯抽成 module-local isomorphic 小工具（`src/modules/announcement/create/userUuid.ts`，`decodePlatformId(accessToken)`；語義同 `src/server/app.ts#modifyUserFromToken` 但不跨 server→module import），fail-closed：無 platformId claim 即 throw。write body 的 `modify_user` 欄位仍用 `ExecCtx.modifyUser`（同為 platformId、值一致）。

## 5. Module 設計（`src/modules/announcement/create/`）

依 `module-onboarding.md` §2 逐檔：

### 5.1 `keys.ts` — itemKey（isomorphic）
create item 無天然單鍵（一筆橫跨多 prod）。itemKey = `announce:${name}:${[...prod_oids].sort().join(',')}:${start_time}`（穩定、不依賴 Node 專用模組；UI 與 server 共用同一函式）。同一 change-set 內多筆公告以此區分。**用 `[...prod_oids].sort()` 複製後排序，不 mutate 原陣列**（`Array.sort()` 就地改序，直接 sort 會改動 change-set item 的 prod_oids 順序 → 影響顯示/其他讀取；agy review round 1 rec）。

### 5.2 `types`（放 `src/core/changeset/types.ts` union）
```ts
export interface AnnouncementLangContent { lang: string; content: string }
export interface AnnouncementCreateItem {
  prod_oids: string[]                 // 一筆橫跨所選商品（對齊 native prodOids number[]）
  name: string                        // ≤254
  is_enabled: boolean
  start_time: string                  // "YYYY-MM-DD HH:mm:ss" UTC+0
  end_time?: string | null            // 同格式，選填
  langs: string[]                     // e.g. ['zh-tw','en-default']
  contents: AnnouncementLangContent[] // 每 lang 一筆文案（best-guess wire）
}
export interface AnnouncementDiffItem {
  prod_oids: string[]
  product_names: string[]             // computeDiff 讀取所得（顯示用）
  name: string
  is_enabled: boolean
  start_time: string
  end_time?: string | null
  langs: string[]
  contents: AnnouncementLangContent[] // 帶進 diff 供確認頁 per-lang 內文預覽（防 blind write；改自 agy plan review）
  existing_count: number | null       // 這些商品上既有公告數（context，非 blocker）；null = 讀不到/未知
  noop: false                         // create 永不 noop
}
```
`ActionType` 加 `'announcement'`；`AnyChangeSetItem` 加 `AnnouncementCreateItem`；`AnyDiffItem` 加 `AnnouncementDiffItem`。

### 5.3 `validate.ts`
- `name` 非空且 ≤254；`prod_oids` 非空；`langs` 非空。
- `start_time` 必填且符合 `YYYY-MM-DD HH:mm:ss`；`end_time` 若有則格式正確且 **晚於** start_time。
- `contents` 至少涵蓋所有 `langs`（缺 lang 文案 → INVALID_ITEMS）。
- **`en-default` 建議存在但不 block**：`validate` 回傳型別是 error-or-null（沒有 warn 通道），故 en-default 的「warn 不 block」**不放在 validate**，而是在**確認頁 renderer 與 wizard 面板 step-3**（人工批准當下）出一則非阻擋提醒——warn 最該被看到的地方。缺 en-default 不影響 staging/執行。
- **不擋過去日期**：start_time 可為未來（原生排程語義），亦可為現在。

### 5.4 `diff.ts` — computeDiff
create 無「現況可比」，但守主 spec §4「嚴禁盲寫」：讀所選商品名（重用 `drafts/products/{oid}/info` → `extractProductInfo`）+ 讀既有公告數（`GET /admin/product/announcement?prodOids=`，經 module-local client）當 context。產 `AnnouncementDiffItem`（`noop:false`、`existing_count` 為既有公告數）。讀取失敗以 warning 降級（`product_names` 留空、`existing_count` 標未知），**不阻擋** staging。

### 5.5 `diffVersion.ts`
create 為 target-only（無 live current 需綁）。hash 目標 payload（name / prod_oids.sort / start_time / end_time / is_enabled / langs.sort / contents）。`existing_count` **不**納入 hash（它是 context，漂移不應使 change-set stale）。

### 5.6 `executor.ts`
對每筆 item：module-local client `POST /admin/product/announcement`，body 為 §6 best-guess wire（標 UNVERIFIED）：
```
{ name, isEnabled, prodOids:number[], startTime, endTime, langs:[...],
  contents:[{lang,content}], modifyUser }
```
成功 = HTTP 200 且 `metadata.status==='0000'` → `ItemResult{status:'done', after:createdRow}`。S2S 403 → `status:'failed', error_code`（預期，直到授權 grant）。`modify_user` = `ExecCtx.modifyUser`（= JWT platformId，通則）。多筆 item 逐筆序列化（announcement 無跨筆批次端點）。

### 5.7 `renderer.ts` — renderConfirm（確認頁）
呈現將建立的公告：name、商品清單（product_names + prod_oids）、is_enabled、start/end（**伺服器端雙時區** UTC + GMT+8，固定偏移、無外部庫；防排程時間看錯）、langs、per-lang content 預覽（來自 diff item 的 `contents`，untrusted → esc）、`existing_count` context。**高風險紅字 banner**：公告會即時對前台顯示（customer-facing）。

### 5.8 `ui.ts` + `module.ts`
`module.ts` 拼裝 `ActionModule`（actionType `announcement`、itemSchema zod、authz `{codes:['product.announcement.update'], onMissing:'warn'}`、scopeOids=`prod_oids`、scopeErrorKey、invalidItemsMessage、scopeNotReadMessage、validate/computeDiff/diffVersion/itemKey/execute/renderConfirm）。announcement 面板為專用 UI（見 §7），故 `wizard` descriptor（grid 型）**不設**；面板走自訂 flow。

### 5.9 通用 changeset 面板的 itemKey 相容（改自 agy review round 1 Issue 1）
`be2_create_changeset`（`uiResourceUri: 'ui://be2/changeset-panel.html'`）與 `be2_get_changeset_status` 打開的是**通用** `changeset-panel.html`，其 `itemKeyOf`（`src/ui/changeset-panel.ts:24-27`）**硬寫**只認 inventory/shelf 兩形狀，未知形狀 fallback 讀 `shelfKey`→`prod_oid`。announcement diff 只有 `prod_oids[]`（無 `prod_oid`）→ fallback 回 `"undefined"` → approve 送 `confirmed_keys:["undefined"]` 對不上後端 `announce:...` → `CONFIRMED_KEYS_MISMATCH`，**announcement 永遠無法透過通用面板批准**。
→ 修：在 `changeset-panel.ts` `itemKeyOf` 加 announcement 分支（`'prod_oids' in d && !('item_oid' in d)` → 用 module 的 isomorphic `itemKey`，與 server 同一函式），import announcement keys。此為 UI 檔（非 core changeset infra），不違反「不碰 core」。confirm SSO 頁（`src/server/confirmRoutes.ts`）已 registry-driven（`getModule(rec.actionType).renderConfirm`），該路徑不受影響。

## 6. App 讀取工具與 scope-gate

change-set §6.2 scope-gate 要求 `scopeOids`（= prod_oids）都在本 session 被讀過（`ctx.readOids`）。故新增：

- **`app_get_announcement_view`**（app-only，仿 `appGetBatchViewTool`）：input `{ prod_oids: string[] }`；經 module-local client + `drafts/.../info` 讀商品名 + 既有公告清單，回 `{ products:[{prod_oid,name,existing:[...]}] }` + `read_oids`。`wrapAppTool` 自動把 `read_oids` 記進 session-scoped `ReadOidStore` → 合法化 scope-gate。面板選擇不被信任，只認實際讀到的。
- `app_create_changeset` / `app_get_changeset_view` / `app_confirm_changeset`：**沿用現成**（registry-driven，無需改）。
- `be2_open_announcement_wizard`：model-visible 入口，回 prefill prod_oids（無 scope 權威，同 `openBatchWizard` 註解）。

## 7. Wizard 面板（`announcement-wizard.ts` / `announcement-wizard.html`）

四步驟（沿用 batch-wizard 的 apple-design 風格、nonce/diff_version 批准 flow、DIFF_STALE reload、`renderText` 純文字防注入）：

1. **選擇**：prod_oids 輸入 → `app_get_announcement_view` 載入 → 顯示商品名 + 既有公告數。
2. **填寫**：公告表單 —— name（text）、is_enabled（toggle，預設 on）、start/end datetime + 時區選擇（重用 batch-wizard 的 `toReserveDateUtc`/`formatDualDisplay` 時區換算，**時區顯示不可失誤**）、langs（多選）、每選定 lang 一個 content textarea。「下一步」→ `app_create_changeset`（action_type=`announcement`, items=[一筆]）。
3. **檢視 / 批准**：`app_get_changeset_view` 取 diff+nonce → 顯示 diff 卡（公告內容、商品、時間雙時區、高風險 banner）→「確認執行」`app_confirm_changeset`（帶 nonce + diff_version + confirmed_keys）。
4. **結果**：per-item ledger（done / failed + error_code；S2S 403 會落在此，訊息需人話化）。

## 8. core 觸點清單（驗收：除下列外不碰 `src/core/`）

| 檔 | 改動 | 性質 |
|---|---|---|
| `src/core/changeset/types.ts` | 加 `announcement` 到 3 個 union + 2 個 interface | onboarding 允許的唯一 core 觸點 |
| `src/modules/index.ts` | `registerModule(announcementCreateModule)` | 模組註冊（非 core 邏輯） |
| `src/server/appResources.ts` | PANELS 加 `announcement-wizard.html` | 面板資源登記 |
| `src/server/app.ts` | 掛 `be2_open_announcement_wizard` + `app_get_announcement_view` | tool 註冊 |
| `src/tools/openAnnouncementWizard.ts`（新） | model-visible 入口 | 新檔 |
| `src/modules/announcement/create/*`（新） | 一包 module | 新檔 |
| `src/ui/announcement-wizard.ts`（新） | 面板 | 新檔 |
| `src/ui/changeset-panel.ts` | `itemKeyOf` 加 announcement 分支（§5.9） | UI 檔（非 core），Session 2 不碰此支 |

**不碰**：`src/core/changeset/{tools,executor,confirmService,registry,module,store,diff}.ts`、`src/server/confirmRoutes.ts`（已 registry-driven）、`src/gateway/client.ts`、`src/tools/batchView.ts`、`src/ui/batch-wizard.ts`。

## 9. Session 2 協調

唯一共用檔 = `src/core/changeset/types.ts`（Session 2 加 inventory_setting 進 wizard，本 session 加 announcement union）——**不同行、可自動 merge**。`src/server/appResources.ts` / `app.ts` 若兩邊都加行，人工對齊即可。announcement **完全不碰** `batch-wizard.ts` / `batchView.ts` / `openBatchWizard.ts`（Session 2 的主戰場）。

## 10. 測試計畫（TDD）

- **Conformance**：`tests/core/moduleConformance.test.ts` 加 announcement diff 樣本（自動繼承 union⇔registry、schema 互斥、itemKey 非空、diffVersion 穩定/敏感）。
- **Unit**：`announcementValidate.test.ts`（欄位/時間/lang-content 覆蓋）、`announcementDiff.test.ts`（讀商品名 + existing_count + 讀取失敗降級）、`announcementExecutor.test.ts`（0000 成功 / 403 失敗 / body wire 形狀 / modify_user=platformId，用 mock fetch）、`svcB2cClient.test.ts`（header 組裝、envelope 0000 判定、缺 x-api-key 行為）。
- **confirmRoutes**：確認頁對 announcement 的 render（高風險 banner、雙時區、content 預覽、注入字串純文字）。
- **通用面板 itemKey**（§5.9）：`changeset-panel.test.ts` 驗 announcement diff 的 `itemKeyOf` 回 `announce:...`（非 `"undefined"`）、與 server `itemKey` 一致 → approve 的 confirmed_keys 對得上。
- **面板**：`announcementWizard.test.ts`（fakeDom，四步驟、時區換算、nonce flow、DIFF_STALE reload）。
- **Eval + 安全**（`module-onboarding.md` §5）：draft-only（拒絕未經批准即宣稱完成）、scope-gate（未讀商品拒絕 staging）、注入抵抗（工具輸出注入不改行為）、引導走精靈而非直寫。

## 11. 阻擋與 live 狀態

- **live 寫入卡 svc-b2c S2S 403**（§5）：build + draft/staging 全綠可驗；live 200 待 svc-b2c team 授權釐清（三選一：S2S token 授權 / 改走 confirm-page web session token / 不同 x-auth-id）。**不阻擋本 spec 開發與 draft-only 驗收**。
- **POST wire body UNVERIFIED**（§6.3）：executor body 為 best-guess，集中一處；待一次真 create（拋棄式 isEnabled=off 再刪）攔到後校正。因 live 反正卡 403，暫不阻擋。

## 12. 假設（spec review 可推翻）

1. change-set item = 一筆公告橫跨所選 prod_oids（對齊 native「一筆多 prodOids」），非每商品一筆。
2. 一次 change-set 建立一筆公告（items 陣列雖支援多筆，wizard MVP 產一筆）。
3. `user-uuid` = JWT platformId（§3 實證），executor 由 token 解碼取得，不另存。
4. content 每 lang 必填（缺則 INVALID_ITEMS）；`en-default` 建議存在（warn 於確認頁/面板 step-3，不 block；見 §5.3）。
5. start_time 允許過去與未來（不擋過去日期）。

<!-- agy-peer-reviewed: 2026-08-20T06:57:55Z rounds=2 verdict=approved -->
