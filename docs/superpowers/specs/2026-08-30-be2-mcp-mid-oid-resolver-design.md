# be2-mcp 商品 mid→prod_oid 防呆解析設計 — 2026-08-30

> GitHub issue #4。範圍拍板(2026-08-30,經 grilling + 原始碼查證):只處理「商品」層的 mid/oid 混淆;item_oid/pkg_oid/supplier_oid 不需要 resolver。

## 1. 背景與問題

be2-web 商品編輯頁網址帶的數字是 **prod_mid**(對外商品編號),但 be2-mcp 目前所有吃商品 ID 的工具(`find_products`/`get_product_plans`/`app_get_batch_view`/`app_get_announcement_view`/`open_batch_wizard`/`open_announcement_wizard`/`open_workbench`)吃的參數名叫 `prod_oid(s)`,語意上要的其實是 **prod_oid**(內部主鍵)。

使用者/agent 若直接複製網址上的數字當 `prod_oid` 傳入 → 打 `products/{mid}/packages` 等端點 → `not_found` 404。**且這個 bug 具有「時好時壞」的隱蔽性**:近 1-2 年新建的商品因為 `prod_oid` 與 `prod_mid` 兩個序列同步遞增而經常剛好相等(例如 mid=oid=2358),此時誤用不會觸發任何錯誤;只有舊商品(`prod_oid` 序列與 2018 年後才引入、從 30001 起算的 `prod_mid` 序列已經分岔)才會讓這個誤用現形。連 RD 都常搞混兩者,是本專案至今唯一「查錯商品」的根因(來自 PR #19 live 驗收記錄)。

## 2. 現況事實(設計依據)

1. **官方資料模型**(來源:[kkday-it/product-team-docs「01-商品設定.md」](https://github.com/kkday-it/product-team-docs/blob/master/Product/%E7%B3%BB%E7%B5%B1%E6%93%8D%E4%BD%9C%E6%89%8B%E5%86%8A/01-%E5%95%86%E5%93%81%E8%A8%AD%E5%AE%9A.md)):`draft_product` 表的 `prod_oid`(自動遞增主鍵)與 `prod_mid`(對外編號,獨立序列、從 30001 起算)是兩個不同計數器。新商品因序列同步遞增而經常 `oid == mid`;舊商品在 `prod_mid` 序列引入前就已存在,兩者無關聯。
2. **官方解析端點**(同上文件記載,非僅逆向推測):`GET /api/v1/drafts/products/mid-{prodMid}/info`(草稿)、`GET /api/v1/products/mid-{prodMid}`(正式),回傳內容含真正的 `prod_oid`。
3. **SIT 實測驗證**(2026-08-21,Playwright 攔 be2-220):`mid-10759 → oid 38352`、`mid-2247 → oid 35992`、`mid-2358 == oid 2358`(巧合相等案例)。
4. **混淆範圍只存在於「商品」一種資源**:查了 be2-web 全部路由(`resources/js/router/routes.js`)與 `GLOSSARY.md`,只有商品編輯頁的路由是 `/product/:prodMid(...)`;其餘會出現 ID 的路由(如 `:prepaidAccountOid`、`:supplierOid`)本身就誠實命名為 `xxxOid` 且值就是 oid,無混淆風險。`item_oid`/`pkg_oid`/`supplier_oid` 從未出現在任何路由的 URL 參數裡(使用者不會從網址複製到這兩種 ID),官方文件也證實它們只是內部複合主鍵,無對應外部 mid 概念。**因此本次只做商品層 resolver,不做 item/pkg/supplier 版本。**
5. **`ToolContext`(`src/tools/types.ts`)目前只有 `gateway`/`accessToken`/`userLabel`,無 `sessionId`**——只有 L2 change-set 工具的 context 才帶 sessionId。
6. **`Envelope`(`src/tools/envelope.ts`)目前欄位**:`data_origin`/`untrusted_note`/`items`/`errors`/`read_oids`,無任何「附加資訊」欄位。
7. **受影響工具的現有 input shape,逐一查證後修正如下(agy-peer-review 第一輪抓出三處誤植)**:
   - `productPlansTool`(`src/tools/productPlans.ts`)吃單一 `prod_oid: string`(必填)。
   - `findProductsTool`(`src/tools/findProducts.ts`)吃 `prod_oids: z.array(...).min(1).max(20)`(必填、非空)。**明確宣告「Per-oid failures are reported in errors without failing the batch」**——per-oid 局部失敗不能讓整批掛掉,resolver 設計需對齊此保證(見 §4)。
   - `appGetBatchViewTool`、`appGetAnnouncementViewTool`(皆定義在 `src/tools/appTools.ts`,不是 `src/tools/batchView.ts`——**該檔只是 `buildBatchView()` library function,無 zod schema,是被 `appGetBatchViewTool` 呼叫的內部邏輯,不是獨立工具**)分別吃 `prod_oids: z.array(...).min(1).max(10)`(皆必填、非空)。
   - `openBatchWizardTool`(`src/tools/openBatchWizard.ts`)、`openAnnouncementWizardTool`(`src/tools/openAnnouncementWizard.ts`)、`openWorkbenchTool`(`src/tools/openWorkbench.ts`)三支「開面板」工具,`prod_oids` 皆是**完全選填、無 `.min(1)`**(`.max()` 上限各自 10/10/20)——程式註解明講這是「僅 prefill,無 scope 權威」,§6.2 read-scope gate 由面板實際載入時的 `app_get_batch_view`/`app_get_announcement_view` 那次真實讀取來滿足,允許開一個空白面板(不帶任何商品)。**⚠️ 但三支中只有 `openWorkbenchTool` 註冊為 model-visible(`src/server/app.ts` 的 `TOOLS`);`openBatchWizardTool`/`openAnnouncementWizardTool` 是未註冊的 dead tool(見 §5.3),本次不改。**
   - **`get_inventory_settings`(`src/tools/inventorySettings.ts`)吃的是 `item_oid`,不是 `prod_oid`**(item_oid 由 `be2_get_product_plans` 取得)——**原稿誤列此工具,已從受影響清單移除**;item_oid 依 §2.4 無 mid 混淆風險。
   - **change-set 建立(`be2_create_changeset` 於 `src/core/changeset/tools.ts`、`app_create_changeset` 於 `src/tools/appTools.ts`,兩者共用 `createChangesetInputShape`)不吃扁平的 `prod_oid(s)` 欄位**——`items` 是每個 module 各自宣告的 `itemSchema` union(如 `shelfToggle/module.ts` 的 `{prod_oid, target_is_active}`、`shelfToggleBundle/module.ts` 的 `{prod_oid, bundle_pkg_oid, ...}`),`prod_oid` 是巢狀在各 module 自訂物件裡的欄位之一。**原稿誤把它歸類為「陣列型工具」,已從本次範圍移除,理由與影響見 §7 非目標。**

## 3. 設計總覽

```
resolveProdOid(mid)        ─┐
  全域 in-memory cache      ├─> src/gateway/prodOidResolver.ts
resolveProdOids(mids, oids) ┘        呼叫 GatewayClient.get(mid-{mid}/info),per-mid 局部失敗

單一 ID 工具                陣列型必填工具                        選填(prefill-only)工具
(get_product_plans)         (find_products /                     (open_workbench 唯一 model-visible;
  prod_mid? / prod_oid?       app_get_batch_view /                 open_batch/announcement_wizard 是
  擇一必填                    app_get_announcement_view)            未註冊 dead tool、本次不改,見 §5.3)
                             prod_mids? / prod_oids?               prod_mids? / prod_oids?
                             至少一個陣列非空                       兩者皆空亦合法(開空白面板)
```

## 4. `src/gateway/prodOidResolver.ts`(新檔)

```ts
import type { GatewayClient } from './client.js'
import { GatewayError } from '../errors.js'
import { toEnvelopeError, type EnvelopeError } from '../tools/envelope.js'

// mid → prod_oid 是商品目錄的靜態事實(不是 session 行為記錄),全域共用、不分 session。
const midToOidCache = new Map<string, string>()

export async function resolveProdOid(mid: string, gateway: GatewayClient, accessToken: string): Promise<string> {
  const cached = midToOidCache.get(mid)
  if (cached) return cached
  let info: unknown
  try {
    info = await gateway.get(`/product/api/v1/drafts/products/mid-${encodeURIComponent(mid)}/info`, accessToken)
  } catch (e) {
    // gateway.get 對非 2xx 一律直接 throw GatewayError(見 src/gateway/client.ts#unwrap)——
    // 原本用 `if (!oid) throw` 的寫法永遠到不了這行,404 會被 gateway 自己的通用錯誤先攔截、
    // 丟出的是 HTTP_404 而非下面這則客製提示。改成 try/catch 攔截原始錯誤,保留其 status、換上提示文字。
    // 只有 404「找不到商品」才是 mid 混淆徵兆 → 改寫;其餘(403/500/502/network)原樣 rethrow,
    // 保留 be2 原始 code/status,不誤報成「填錯欄位」(codex Issue 3)。
    const status = (e as { status?: number })?.status
    if (status !== 404) throw e
    throw new GatewayError(
      'MID_RESOLVE_FAILED',
      `mid ${mid} 找不到對應商品。若你是從 be2-web 網址複製這個數字,它可能其實是 prod_oid 而非 prod_mid,請改用 prod_oid 欄位。`,
      404,
    )
  }
  const oid = String((info as Record<string, unknown>)?.prod_oid ?? '')
  if (!oid) {
    throw new GatewayError('MID_RESOLVE_FAILED', `mid ${mid} 的商品資訊缺少 prod_oid 欄位,請確認 mid 正確或聯絡開發`, 500)
  }
  midToOidCache.set(mid, oid)
  return oid
}

export async function resolveProdOids(
  mids: string[], oids: string[], gateway: GatewayClient, accessToken: string,
): Promise<{ resolved: string[]; resolutions: Array<{ mid: string; oid: string }>; errors: EnvelopeError[] }> {
  const uniqMids = [...new Set(mids)]   // dedup:重複 mid 不 stampede 同一支 mid-info API
  const resolutions: Array<{ mid: string; oid: string }> = []
  const errors: EnvelopeError[] = []
  // 分批(每批 ≤5)對齊 find_products 既有 gateway burst 控制(codex Issue 5),避免 20 個 mid 瞬間 20 個 GET。
  for (let i = 0; i < uniqMids.length; i += 5) {
    const batch = uniqMids.slice(i, i + 5)
    const settled = await Promise.allSettled(batch.map(mid => resolveProdOid(mid, gateway, accessToken)))
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') resolutions.push({ mid: batch[j], oid: s.value })
      else errors.push(toEnvelopeError(batch[j], s.reason))
    })
  }
  // dedup resolved:oids 與 mid 解出 oid 重疊時去重,避免下游重複 fetch/record。保留首次出現順序。
  return { resolved: [...new Set([...oids, ...resolutions.map(r => r.oid)])], resolutions, errors }
}
```

**mid 解析失敗走 per-item 局部失敗,不是整批失敗**(agy-peer-review 修正:原稿寫「整批失敗」,但 `find_products` 的既有 description 已明文保證「Per-oid failures are reported in `errors` without failing the batch」——`app_get_batch_view`/`app_get_announcement_view` 也是同一種 per-item 容錯慣例。若 resolver 對 mid 解析失敗採整批拋出,會破壞這些工具既有的保證。改用 `Promise.allSettled`,失敗的 mid 進 `errors`(沿用既有 `toEnvelopeError` 慣例),成功的 mid 正常解析、與 `oids` 合併;呼叫端把 `resolveProdOids` 回傳的 `errors` merge 進自己原本就有的 errors 陣列即可,不需要新機制)。單一 ID 工具(`get_product_plans`)沒有「批次」概念,`resolveProdOid` 解析失敗就是直接拋出,轉成該工具唯一的錯誤,行為不變。

**404 對稱提示(agy-peer-review 修正:原稿寫「既有商品查詢端點的 404 handler」過於含糊,此 codebase 沒有這種東西)**:`resolveProdOid` 內的 `MID_RESOLVE_FAILED` 是「mid 解析失敗」方向的提示。反方向——使用者把 mid 誤當 `prod_oid` 直接傳入、導致原生商品查詢 404——提示邏輯精確落地在 `src/tools/envelope.ts` 新增的 `toEnvelopeErrorWithMidHint(key, e)` helper(判斷 `e.status === 404` 時在訊息後附加提示句,否則行為等同原本的 `toEnvelopeError`),只在**明確判定使用者是用 `prod_oid` 欄位查詢、且該次查詢真的 404** 的呼叫點替換使用:`src/tools/findProducts.ts` 的 `lookupOne()`(`toEnvelopeError(oid, info.reason)` 那行)與 `src/tools/productPlans.ts` 的等價錯誤轉換點。`app_get_batch_view`/`app_get_announcement_view` 的既有錯誤轉換點暫不套用(範圍收斂,見 §7)。**不做自動反查猜測**(不會在 404 時自動嘗試把該數字當 mid 解析後建議「你是不是要找 X」)——維持 Strategy A「分欄位、不猜測」精神,避免二次猜測風險(若該數字剛好也是別的商品的合法 mid,猜測建議反而更誤導)。

> **codex review 修正(2026-08-31),落地見 plan Task 2**:
> 1. **catch 只在 404 改寫,非 catch-all**:上方 `resolveProdOid` 的 catch 若把 gateway 回的**所有**非 2xx(403 無權、500/502 gateway 故障、network)都改寫成 `MID_RESOLVE_FAILED`「mid 可能填錯欄位」,會誤導——把授權不足/服務中斷都講成「找錯欄位」,且丟失 `GatewayClient.unwrap()` 已保留的 be2 原始 code/status。**修正**:只有 `status === 404` 才改寫成 `MID_RESOLVE_FAILED` + mid 提示;其餘 status 原樣 rethrow(保留原始 be2 code/status,交由既有 `toEnvelopeError` 帶進 envelope)。
> 2. **`resolveProdOids` 分批,對齊既有 gateway burst 控制**:`find_products` 既有以 5-oid 一批、峰值 ≤10 GET 控制 gateway 壓力;`resolveProdOids` 若對最多 20 個 unique mid 直接 `Promise.allSettled`,會先瞬間打 20 個 `mid-info` GET 再進商品查詢,是既有測試意圖沒覆蓋到的 regression。**修正**:resolver 內部同樣分批(每批 ≤5),與既有慣例一致。
> 3. **全域 cache 維持不分 session(使用者拍板,2026-08-31)**:codex 指出全域 cache 讓使用者 B 蹭 A 的解析、跳過 B 自己對 `mid-info` 的授權判定,且 `resolved_ids` 曝光 mid↔oid 對應。**維持 §7.3 的全域 cache 決策**:cache 只存「mid↔oid 編號對照」這個非機密靜態事實,oid 本身不是商品內容;真正的商品資料讀取(`packages`/`info`/`switch` 等)仍走各 user 自己的 token per-user gate,授權邊界不因 cache 而失守。trade-off 已知並接受;若日後 mid-info 端點被賦予 per-user 機密語義,再改 per-user cache(需同步改 §7.3 與 resolver 簽名)。

## 5. 工具 Schema 改動

### 5.1 單一 ID 工具:`get_product_plans`(`src/tools/productPlans.ts`)

```ts
const inputShape = {
  prod_mid: z.string().min(1).optional().describe('be2-web URL product number (mid). Provide this OR prod_oid, not both required — pick whichever you have.'),
  prod_oid: z.string().min(1).optional().describe('be2 product internal oid whose plans to list.'),
}
```

Handler 開頭:
```ts
if (!args.prod_mid && !args.prod_oid) return /* 400 系列 envelope error: 兩者至少填一個 */
let oid = args.prod_oid
let resolvedIds: Array<{ mid: string; oid: string }> | undefined
if (args.prod_mid) {
  const resolvedOid = await resolveProdOid(args.prod_mid, ctx.gateway, ctx.accessToken)
  // 兩者都給時驗證一致,不悄悄以其中一個為準——避免使用者誤填卻無感知地操作到非預期商品。
  if (oid && oid !== resolvedOid) return /* 400 系列 envelope error: prod_mid 與 prod_oid 指向不同商品 */
  oid = resolvedOid
  resolvedIds = [{ mid: args.prod_mid, oid }]
}
```

**兩者都給且不一致時直接報錯,不以任一方為準**——維持「不猜測」精神:若使用者/agent 誤填兩個矛盾的值,應該讓它感知到矛盾,而不是系統悄悄選一個替它做決定。

### 5.2 陣列型必填工具:`find_products`(`src/tools/findProducts.ts`)、`app_get_batch_view`、`app_get_announcement_view`(皆在 `src/tools/appTools.ts`)

```ts
prod_mids: z.array(z.string().min(1)).max(20 /* 或該工具原本上限 */).optional()
  .describe('be2-web URL product numbers (mid). Resolved to canonical oid and merged with prod_oids.'),
prod_oids: z.array(z.string().min(1)).max(20 /* 或該工具原本上限 */).optional(),  // 原本的 .min(1) 移除;「兩陣列合計至少一項」由 handler 手動驗證(見下方落地註記)
```
(`find_products` 上限維持 20;`appGetBatchViewTool`/`appGetAnnouncementViewTool` 維持各自的 10。)

Handler 開頭呼叫 `resolveProdOids(args.prod_mids ?? [], args.prod_oids ?? [], ctx.gateway, ctx.accessToken)`,取得合併後的 canonical oid 陣列、`resolutions`、以及 mid 解析失敗的 `errors`(§4 的 per-item 局部失敗)——`errors` 併入該工具原本就會回傳的 errors 陣列(如 `find_products` 既有的 per-oid errors 機制),不新增失敗語意。

**驗證規則(落地註記,codex review 修正 2026-08-31)**:`prod_mids` 與 `prod_oids` 合計至少一項非空。**原稿寫「用 zod `.refine()` 擋兩陣列皆空」,但此 codebase 的 `inputShape` 是 raw shape 物件直接餵 MCP SDK `registerTool` 的 `inputSchema`,全 repo 無 `.refine()` 用例、SDK 不接 `ZodObject`——root-level `.refine()` 結構上不可行。改由 handler 開頭手動驗證**:兩陣列皆空(解析後 `resolved.length === 0` 且無 resolve error)回 `MISSING_ID` 系列 envelope error,與 §5.1 手動驗證一致。若兩者都給,各自解析後直接合併(視為批次操作,非衝突)。§8 Test 8 引用的即本註記。

**canonical oid 才進 scope-gate**:`readOids` 一律使用 resolver 解出的 canonical `prod_oid`,不使用原始輸入,維持既有 spec §6.2 scope-binding 一致性。

### 5.3 開面板工具:只有 `open_workbench` 是 model-visible(codex review 修正,2026-08-31)

> **原稿盤點錯誤,已修正**:原列 `open_batch_wizard`/`open_announcement_wizard`/`open_workbench` 三支為受影響工具。codex cross-model review 查證 `src/server/app.ts` 的 model-visible `TOOLS` 只註冊 `openWorkbenchTool`;`open_batch_wizard`/`open_announcement_wizard` **未註冊**(`tests/serverTools.test.ts` 明確斷言二者不在 `TOOLS`),是 Phase 4a workbench 統一面板取代獨立 wizard 入口後殘留的 dead tool。**本次只改 `open_workbench`,不碰那兩支 dead tool**(改了 agent 也呼叫不到)。

`open_workbench` 的 `prod_oids` 目前**完全選填、無 `.min(1)`**,語意是「面板 prefill 用,無 scope 權威」——真正的 §6.2 read-scope gate 由使用者實際打開面板後、`app_get_batch_view`/`app_get_announcement_view` 的伺服器端讀取來滿足,允許開一個不帶任何商品的空白面板。

```ts
prod_mids: z.array(z.string().min(1)).max(20).optional(),
prod_oids: z.array(z.string().min(1)).max(20).optional(),
// 不加「至少一項非空」的 refine——兩者皆空是合法情境(開空白面板)。
```

Handler 開頭:僅當 `prod_mids`/`prod_oids` 任一有值時才呼叫 `resolveProdOids`;兩者都空則沿用原本「開空白面板」行為,不呼叫 resolver。mid 解析失敗的 `errors` 併入回傳(prefill 失敗不阻擋開面板本身)。

> **⚠️ 已知限制(scope 收斂,2026-08-31,使用者拍板「本功能主要服務 agent 對話直呼工具」)**:`workbench` 面板 UI(`src/ui/workbench.ts`)**不消費** `open_workbench` 回的 prefill payload(無 `app.ontoolresult`,對照 `batch-wizard.ts:1366` 有),且其輸入框載入時只送 `prod_oids`、不送 `prod_mids`。因此使用者**在面板輸入框手動貼 mid** 時,resolver 不會生效(UI 直接把 mid 當 oid 送 `app_get_batch_view`)。本次 resolver 生效範圍 = **agent 在對話中直接呼叫 MCP 工具**(`find_products`/`get_product_plans`/`app_get_batch_view`/`app_get_announcement_view`,以及 agent 帶 `prod_mids` 呼叫 `open_workbench`)。**面板 UI 層讓手動輸入也吃 mid** 列為 follow-up(見 §7.6),不在本次範圍。

## 6. 解析結果曝光(`Envelope` 擴充)

`src/tools/envelope.ts` 新增選填欄位,向後相容(不影響未使用 resolver 的既有工具):

```ts
export interface Envelope {
  data_origin: 'be2_content'
  untrusted_note: string
  items: unknown[]
  errors: EnvelopeError[]
  read_oids: string[]
  resolved_ids?: Array<{ mid: string; oid: string }>   // 新增
}
```

`makeEnvelope()` 簽名加選填第四參數 `resolvedIds`。做成結構化陣列而非塞進文字訊息,是因為這是 MCP `structuredContent` 給 agent 讀的機器可讀欄位——agent 可以直接引用 `resolved_ids` 告知使用者「已將 mid X 解析為 prod_oid Y」,不需自己解析自然語言字串。

## 7. 邊界(非目標)

1. **不做 item_oid/pkg_oid/supplier_oid 版本的 resolver**——見 §2.4,這些 ID 不出現在 be2-web 路由 URL 上,無對應混淆風險。
2. **不做「先當 mid 猜、404 再當 oid」的 resolve-first 邏輯**(Strategy B)——近期商品 `oid == mid` 的巧合機率高,猜錯不易被發現,比明確報錯更危險。
3. **cache 不做失效機制/TTL**——mid↔oid 對應關係一旦建立即不變(oid 是自動遞增主鍵、mid 是獨立序列,兩者都不會被重新指派),程序生命週期內全域快取即可,不需過期。
4. **不去信 product team 正式確認 mid/oid 值域是否會碰撞**——Strategy A(分欄位、不猜)在碰撞與否兩種情況下都安全,此問題答案不影響設計決策。
5. **change-set 建立(`be2_create_changeset`/`app_create_changeset`)不接 mid 支援**(agy-peer-review 期間發現,原稿誤把它歸類成陣列型工具,已修正)。原因:`items` 是每個 module 各自宣告的 `itemSchema` union,`prod_oid` 巢狀在各 module 自訂物件裡(如 `shelfToggle` 的 `{prod_oid, target_is_active}`),不是本次能一次性處理的扁平欄位——要支援 mid 得逐一改每個 module 的 `itemSchema`/`validate`(目前 5 個 module,且會隨 issue #1 的模組化持續增加),範疇與本次「加兩個 resolver 呼叫」的量級不同。**這不是繞過問題**:change-set 的 §6.2 scope-gate 本來就要求 item 引用的 oid 必須先被某次讀取工具讀過(`readOids`)才能進 change-set;而讀取工具(`find_products`/`get_product_plans`/`app_get_batch_view` 等)在本次改動後都會把 mid 解析成 canonical oid 存進 `read_oids`。也就是說,使用者/agent 的正常工作流程是「先讀(可以用 mid)→ 用讀到的 canonical oid 建 change-set」,mid 混淆的風險視窗已經在讀取這一步被擋掉了,change-set 建立階段能拿到的本來就該是已解析過的 oid。若之後仍觀察到使用者在建 change-set 時繞過讀取步驟直接手填 mid,再視情況開獨立 issue、逐 module 補齊。
6. **workbench 面板 UI 層的 mid 輸入支援**(codex review 揭露,2026-08-31)——見 §5.3 已知限制。本次 resolver 是 server 端,`workbench.ts` 輸入框不消費 prefill、只送 `prod_oids`,故面板手動貼 mid 不會被解析。列 follow-up issue,不在本次範圍(使用者拍板本功能主要服務 agent 對話直呼工具)。
7. **不修 `app_get_announcement_view` 既有的 read-oid 登記破口**(codex review 揭露,2026-08-31)——現行 `appTools.ts` 即使商品 `info` GET 失敗仍把該 oid 記進 `read_oids`(`ReadOidStore`),使「解析成功但實際讀取 403/404」的 oid 仍可能通過 change-set 的 `SCOPE_NOT_READ` gate。**這是本次改動前就存在的既有債**(非 resolver 引入),本次維持既有行為不擴大處理;§5.2「canonical oid 才進 scope-gate」指「進 scope-gate 的是解析後的 canonical oid,而非原始 mid」,不改變既有「讀取失敗仍登記」的時機。若要收緊(只有實際讀取成功的 oid 才進 read scope),另開 issue。

## 8. 測試計畫

**關鍵 fixture(驗收陷阱)**:驗收前必須先在 SIT be2-220(或 stage)找一個 **`prod_oid` ≠ `prod_mid` 的舊商品**,記錄其 `(mid, oid)` pair 寫入測試 fixture/文件。**用近期新建商品測無效**——`oid == mid` 時,即使 resolver 完全沒接上、程式碼直接誤用 mid 當 oid,測試也會「碰巧」通過,無法驗證出真正的防呆效果。

**單元測試**(mock gateway,新檔 `tests/prodOidResolver.test.ts`):
1. `resolveProdOid`:cache miss 時打 API 一次;cache hit 不再打 API(驗證 `gateway.get` 呼叫次數)。
2. `resolveProdOid`:mid 解析失敗——mock `gateway.get` **拋出** `GatewayError('HTTP_404', ..., 404)`(模擬 `src/gateway/client.ts#unwrap` 的真實行為,不是回傳無 `prod_oid` 欄位的物件)→ `resolveProdOid` 攔截後重新丟出帶提示文字、code 為 `MID_RESOLVE_FAILED` 的 `GatewayError`,且保留原始 status。
3. `resolveProdOid`:mock `gateway.get` **成功回傳但物件缺 `prod_oid` 欄位** → 丟出 `MID_RESOLVE_FAILED`(500)。
4. `resolveProdOids`:mids 與 oids 陣列正確合併為 `resolved`;`resolutions` 內容正確對應。
5. `resolveProdOids`:陣列中部分 mid 解析失敗 → 成功的仍進 `resolved`/`resolutions`,失敗的進 `errors`(**不是整批拋出**——對齊 `find_products` 既有的「per-oid 失敗不拖垮整批」保證)。

**per-tool 測試**(擴充既有測試檔):
6. `productPlans.test.ts`:只給 `prod_mid` → 呼叫 resolver、底層打 canonical oid、`resolved_ids` 正確帶出;只給 `prod_oid` → 不呼叫 resolver;兩者皆空 → zod 驗證錯誤;兩者都給且解析結果不一致 → 明確報錯,不悄悄擇一。
7. `findProducts.test.ts`:`prod_mids`/`prod_oids` 合併正確;其中一個 mid 解析失敗時,該筆進 `errors`、其餘商品仍正常回傳(不拖垮整批)；`toEnvelopeErrorWithMidHint` 在直接用 `prod_oid` 查詢卻 404 時附帶提示文字。
8. `appTools.test.ts`(或既有對應測試檔):`appGetBatchViewTool`/`appGetAnnouncementViewTool` 的 `prod_mids`/`prod_oids` 合併行為;「兩陣列皆空 → `MISSING_ID`」由 handler 手動驗證(非 zod refine,見 §5.2 落地註記)。
9. `openBatchWizard.test.ts`(model-visible 入口實為 `openWorkbenchTool`,測試檔沿用既有 `tests/openBatchWizard.test.ts`):`prod_mids`/`prod_oids` 皆空時仍能開出空白面板;給 mid 時能正確解析出 canonical oid。**不測 dead tool**(`open_batch_wizard`/`open_announcement_wizard` 未註冊,見 §5.3)。
10. `readOids`/scope-gate 使用的是 canonical oid,非原始輸入。

**整合測試**(對照 `sit-write-contracts.md` 慣例,對真實 SIT be2-220 + 上述舊商品 fixture):
11. 用 `prod_mid` 呼叫 `get_product_plans`,驗證 `resolved_ids` 正確且底層確實查詢到 canonical oid 的資料。
12. 把 mid 誤當 `prod_oid` 直接丟給 `find_products`,驗證 `errors` 內的訊息包含新增的對稱提示文字。

**回歸**:`npm run ci` 全綠;既有受影響工具(`find_products`/`get_product_plans`/`app_get_batch_view`/`app_get_announcement_view`/`open_workbench`)既有測試不動仍綠(純新增選填欄位,行為向後相容);change-set 相關測試不受影響(§7.5 範圍排除);dead tool `open_batch_wizard`/`open_announcement_wizard` 不改動(§5.3)。

## 9. 落地清單

- 新檔:`src/gateway/prodOidResolver.ts` + `tests/prodOidResolver.test.ts`
- 改動:`src/tools/envelope.ts`(`Envelope.resolved_ids` + `makeEnvelope` 簽名 + 新增 `toEnvelopeErrorWithMidHint` helper)
- 改動:`src/tools/productPlans.ts`(單一 ID schema + handler,含一致性驗證)
- 改動:`src/tools/findProducts.ts`(陣列必填 schema + handler + `toEnvelopeErrorWithMidHint` 套用)
- 改動:`src/tools/appTools.ts` 的 `appGetBatchViewTool`、`appGetAnnouncementViewTool`(陣列必填 schema + handler)
- 改動:`src/tools/openWorkbench.ts`(選填 prefill schema 加 `prod_mids` + handler 加 `ctx` 參數呼叫 resolver,不加「至少一項」refine)
- **不改動(dead tool)**:`src/tools/openBatchWizard.ts`、`src/tools/openAnnouncementWizard.ts`(未註冊為 model-visible,改了 agent 也呼叫不到,見 §5.3)
- **不改動**:`src/tools/batchView.ts`(純 library function,無 schema)、`src/tools/inventorySettings.ts`(吃 item_oid,無關)、`src/core/changeset/tools.ts` 與各 module 的 `itemSchema`(範圍排除,見 §7.5)、`src/ui/workbench.ts`(面板 UI 層 mid 輸入為 follow-up,見 §7.6)
- 文件:記錄 SIT be2-220(或 stage)的 `prod_oid ≠ prod_mid` 測試 fixture 商品

<!-- agy-peer-reviewed: 2026-09-01T09:17:09Z rounds=5 verdict=approved -->
<!-- codex-cross-review: 2026-08-31 — codex found spec scoping error (dead tools) + §4/§5.2 code-vs-note drift; all amended, agy re-approved rounds=5 -->
