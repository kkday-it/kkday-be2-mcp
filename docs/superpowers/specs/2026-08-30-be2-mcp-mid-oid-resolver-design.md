# be2-mcp 商品 mid→prod_oid 防呆解析設計 — 2026-08-30

> GitHub issue #4。範圍拍板(2026-08-30,經 grilling + 原始碼查證):只處理「商品」層的 mid/oid 混淆;item_oid/pkg_oid/supplier_oid 不需要 resolver。

## 1. 背景與問題

be2-web 商品編輯頁網址帶的數字是 **prod_mid**(對外商品編號),但 be2-mcp 目前所有吃商品 ID 的工具(`find_products`/`get_product_plans`/`get_inventory_settings`/`batchView`/change-set 建立/`open_batch_wizard`/`open_announcement_wizard`/`open_workbench`)吃的參數名叫 `prod_oid(s)`,語意上要的其實是 **prod_oid**(內部主鍵)。

使用者/agent 若直接複製網址上的數字當 `prod_oid` 傳入 → 打 `products/{mid}/packages` 等端點 → `not_found` 404。**且這個 bug 具有「時好時壞」的隱蔽性**:近 1-2 年新建的商品因為 `prod_oid` 與 `prod_mid` 兩個序列同步遞增而經常剛好相等(例如 mid=oid=2358),此時誤用不會觸發任何錯誤;只有舊商品(`prod_oid` 序列與 2018 年後才引入、從 30001 起算的 `prod_mid` 序列已經分岔)才會讓這個誤用現形。連 RD 都常搞混兩者,是本專案至今唯一「查錯商品」的根因(來自 PR #19 live 驗收記錄)。

## 2. 現況事實(設計依據)

1. **官方資料模型**(來源:[kkday-it/product-team-docs「01-商品設定.md」](https://github.com/kkday-it/product-team-docs/blob/master/Product/%E7%B3%BB%E7%B5%B1%E6%93%8D%E4%BD%9C%E6%89%8B%E5%86%8A/01-%E5%95%86%E5%93%81%E8%A8%AD%E5%AE%9A.md)):`draft_product` 表的 `prod_oid`(自動遞增主鍵)與 `prod_mid`(對外編號,獨立序列、從 30001 起算)是兩個不同計數器。新商品因序列同步遞增而經常 `oid == mid`;舊商品在 `prod_mid` 序列引入前就已存在,兩者無關聯。
2. **官方解析端點**(同上文件記載,非僅逆向推測):`GET /api/v1/drafts/products/mid-{prodMid}/info`(草稿)、`GET /api/v1/products/mid-{prodMid}`(正式),回傳內容含真正的 `prod_oid`。
3. **SIT 實測驗證**(2026-08-21,Playwright 攔 be2-220):`mid-10759 → oid 38352`、`mid-2247 → oid 35992`、`mid-2358 == oid 2358`(巧合相等案例)。
4. **混淆範圍只存在於「商品」一種資源**:查了 be2-web 全部路由(`resources/js/router/routes.js`)與 `GLOSSARY.md`,只有商品編輯頁的路由是 `/product/:prodMid(...)`;其餘會出現 ID 的路由(如 `:prepaidAccountOid`、`:supplierOid`)本身就誠實命名為 `xxxOid` 且值就是 oid,無混淆風險。`item_oid`/`pkg_oid`/`supplier_oid` 從未出現在任何路由的 URL 參數裡(使用者不會從網址複製到這兩種 ID),官方文件也證實它們只是內部複合主鍵,無對應外部 mid 概念。**因此本次只做商品層 resolver,不做 item/pkg/supplier 版本。**
5. **`ToolContext`(`src/tools/types.ts`)目前只有 `gateway`/`accessToken`/`userLabel`,無 `sessionId`**——只有 L2 change-set 工具的 context 才帶 sessionId。
6. **`Envelope`(`src/tools/envelope.ts`)目前欄位**:`data_origin`/`untrusted_note`/`items`/`errors`/`read_oids`,無任何「附加資訊」欄位。
7. **受影響工具的現有 input shape**:僅 `productPlansTool`(`src/tools/productPlans.ts`)吃單一 `prod_oid: string`;`findProducts`/`batchView`/`openBatchWizard`/`openAnnouncementWizard`/`openWorkbench` 皆吃 `prod_oids: string[]`(陣列,各自 `.max()` 上限不同)。

## 3. 設計總覽

```
resolveProdOid(mid)        ─┐
  全域 in-memory cache      ├─> src/gateway/prodOidResolver.ts
resolveProdOids(mids, oids) ┘        呼叫 GatewayClient.get(mid-{mid}/info)

單一 ID 工具(get_product_plans)          陣列型工具(find_products / batchView /
  prod_mid? / prod_oid? 擇一必填            openBatchWizard / openAnnouncementWizard /
                                            openWorkbench)
                                          prod_mids? / prod_oids? 至少一個非空、平行陣列
```

## 4. `src/gateway/prodOidResolver.ts`(新檔)

```ts
import type { GatewayClient } from './client.js'
import { GatewayError } from '../errors.js'

// mid → prod_oid 是商品目錄的靜態事實(不是 session 行為記錄),全域共用、不分 session。
const midToOidCache = new Map<string, string>()

export async function resolveProdOid(mid: string, gateway: GatewayClient, accessToken: string): Promise<string> {
  const cached = midToOidCache.get(mid)
  if (cached) return cached
  const info = await gateway.get(`/product/api/v1/drafts/products/mid-${encodeURIComponent(mid)}/info`, accessToken)
  const oid = String((info as Record<string, unknown>)?.prod_oid ?? '')
  if (!oid) {
    throw new GatewayError(
      'MID_RESOLVE_FAILED',
      `mid ${mid} 找不到對應商品。若你是從 be2-web 網址複製這個數字,它可能其實是 prod_oid 而非 prod_mid,請改用 prod_oid 欄位。`,
      404,
    )
  }
  midToOidCache.set(mid, oid)
  return oid
}

export async function resolveProdOids(
  mids: string[], oids: string[], gateway: GatewayClient, accessToken: string,
): Promise<{ resolved: string[]; resolutions: Array<{ mid: string; oid: string }> }> {
  const resolutions = await Promise.all(mids.map(async mid => ({ mid, oid: await resolveProdOid(mid, gateway, accessToken) })))
  return { resolved: [...oids, ...resolutions.map(r => r.oid)], resolutions }
}
```

**mid 解析失敗時整批失敗**(不做 partial success):陣列中任一 mid 解析不到,視為使用者輸入錯誤,`Promise.all` 直接拋出中止,不是「部分商品不存在」的正常業務情境,不應假裝其餘商品成功。

**404 對稱提示**:上面 `MID_RESOLVE_FAILED` 是「mid 解析失敗」方向的提示。反方向——使用者把 mid 誤當 `prod_oid` 直接丟給商品查詢端點導致的原生 404——也要在該端點既有的 404 handler 補一句對稱提示:「若這個數字是從 be2-web 網址複製的,它可能是 prod_mid 而非 prod_oid,請改用 prod_mid 欄位」。兩個方向都要提示,不只是 resolver 那一半。**不做自動反查猜測**(即不會在 404 時自動嘗試把該數字當 mid 解析後建議「你是不是要找 X」)——維持 Strategy A「分欄位、不猜測」的精神,避免二次猜測風險(若該數字剛好也是別的商品的合法 mid,猜測建議反而更誤導)。

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

### 5.2 陣列型工具:`find_products`/`batchView`/`openBatchWizard`/`openAnnouncementWizard`/`openWorkbench`

```ts
prod_mids: z.array(z.string().min(1)).optional().describe('be2-web URL product numbers (mid). Resolved to canonical oid and merged with prod_oids.'),
prod_oids: z.array(z.string().min(1)).max(20).optional(),  // 原本的 .min(1) 移除,改成「整體至少一個陣列非空」的 refine
```

Handler 開頭呼叫 `resolveProdOids(args.prod_mids ?? [], args.prod_oids ?? [], ctx.gateway, ctx.accessToken)`,取得合併後的 canonical oid 陣列與 `resolutions`。

**驗證規則(所有受影響工具一致)**:`prod_mid(s)` 與 `prod_oid(s)` 至少一個非空,用 zod `.refine()` 擋掉「兩者皆空」;若兩者都給,各自解析後直接合併(視為批次操作,非衝突)。

**canonical oid 才進 scope-gate**:`readOids` 一律使用 resolver 解出的 canonical `prod_oid`,不使用原始輸入,維持既有 spec §6.2 scope-binding 一致性。

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

## 8. 測試計畫

**關鍵 fixture(驗收陷阱)**:驗收前必須先在 SIT be2-220(或 stage)找一個 **`prod_oid` ≠ `prod_mid` 的舊商品**,記錄其 `(mid, oid)` pair 寫入測試 fixture/文件。**用近期新建商品測無效**——`oid == mid` 時,即使 resolver 完全沒接上、程式碼直接誤用 mid 當 oid,測試也會「碰巧」通過,無法驗證出真正的防呆效果。

**單元測試**(mock gateway,新檔 `tests/prodOidResolver.test.ts`):
1. `resolveProdOid`:cache miss 時打 API 一次;cache hit 不再打 API(驗證 `gateway.get` 呼叫次數)。
2. `resolveProdOid`:mid 解析失敗(API 回無 `prod_oid` 欄位或 404)→ 丟出帶提示文字的 `GatewayError`,code 為 `MID_RESOLVE_FAILED`。
3. `resolveProdOids`:mids 與 oids 陣列正確合併為 `resolved`;`resolutions` 內容正確對應。
4. `resolveProdOids`:陣列中任一 mid 解析失敗 → 整批拋出,不做 partial success。

**per-tool 測試**(擴充既有測試檔,如 `productPlans.test.ts`):
5. 只給 `prod_mid` → 呼叫 resolver、底層打 canonical oid、`resolved_ids` 正確帶出。
6. 只給 `prod_oid` → 不呼叫 resolver、`resolved_ids` 為 undefined。
7. 兩者皆空 → zod 驗證錯誤。
8. `readOids`/scope-gate 使用的是 canonical oid,非原始輸入。

**整合測試**(對照 `sit-write-contracts.md` 慣例,對真實 SIT be2-220 + 上述舊商品 fixture):
9. 用 `prod_mid` 呼叫 `get_product_plans`,驗證 `resolved_ids` 正確且底層確實查詢到 canonical oid 的資料。
10. 把 mid 誤當 `prod_oid` 直接丟給既有查詢端點,驗證原生 404 訊息包含新增的對稱提示文字。

**回歸**:`npm run ci` 全綠;既有受影響工具(`find_products`/`get_product_plans`/`batchView`/`open_batch_wizard`/`open_announcement_wizard`/`open_workbench`)既有測試不動仍綠(純新增選填欄位,行為向後相容)。

## 9. 落地清單

- 新檔:`src/gateway/prodOidResolver.ts` + `tests/prodOidResolver.test.ts`
- 改動:`src/tools/envelope.ts`(`Envelope.resolved_ids` + `makeEnvelope` 簽名)
- 改動:`src/tools/productPlans.ts`(單一 ID schema + handler)
- 改動:`src/tools/findProducts.ts`、`src/tools/batchView.ts`、`src/tools/openBatchWizard.ts`、`src/tools/openAnnouncementWizard.ts`、`src/tools/openWorkbench.ts`(陣列型 schema + handler)
- 改動:既有商品查詢端點的 404 handler(對稱提示,§4)
- 文件:記錄 SIT be2-220(或 stage)的 `prod_oid ≠ prod_mid` 測試 fixture 商品
