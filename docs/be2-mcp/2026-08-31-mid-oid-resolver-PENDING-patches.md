# mid→oid resolver — 待套用 patch + 收尾交接（給 codex）

> 產出時間:2026-09-01。緣由:Claude Code 這個 session 的**檔案寫入工具反覆「回報成功、實際未落地」**(讀取類 grep 正常、寫入類 Edit/python 幻想),導致 plan 有 3 處補充寫不進去。這份文件把「還沒進檔的 3 段」與「當前真實狀態」交給 codex 接手套用 + 把 agy plan review 收到 APPROVED。

---

## 1. 這個任務是什麼

be2-mcp 的「商品 `prod_mid` → `prod_oid` 防呆解析」。be2-web 網址上的數字是 `prod_mid`(對外編號),但吃商品 ID 的 MCP 工具參數叫 `prod_oid`。舊商品 mid≠oid,誤用會 404 / 新商品 mid==oid 會靜默查錯。resolver 讓工具接受 mid、自動解析成 oid。

- **spec**:`docs/superpowers/specs/2026-08-30-be2-mcp-mid-oid-resolver-design.md`
- **plan**:`docs/superpowers/plans/2026-08-31-be2-mcp-mid-oid-resolver.md`
- repo:`kkday-be2-mcp`(TypeScript ESM、zod、vitest;工具 `inputShape` 是 zod raw shape 物件直接餵 MCP SDK `registerTool`,**全 repo 無 `.refine()` 用例**)。

## 2. 當前真實狀態(用乾淨 grep 盤點過,可信)

**SPEC — 完整定稿、已 agy APPROVED(rounds=5)。** 經 codex cross-review 後修正的內容全部落地:
- §5.3 收斂:只 `open_workbench` 是 model-visible;`open_batch_wizard`/`open_announcement_wizard` 是未註冊 dead tool(`src/server/app.ts` 的 `TOOLS` 只含 `openWorkbenchTool`、`tests/serverTools.test.ts` 斷言另兩支不在)。
- §5.3 已知限制 + §7.6:`src/ui/workbench.ts` 不消費 prefill payload、輸入框只送 `prod_oids`,故面板手動貼 mid 不生效 → resolver 生效面 = 「agent 對話直呼工具」,面板 UI mid 列 follow-up。
- §7.7:`app_get_announcement_view` 既有 read-oid 登記破口(讀取失敗仍登記 oid)為既有債,本次不擴大處理。
- §4 code block:resolver catch 只在 `status===404` 改寫 `MID_RESOLVE_FAILED`(其餘 rethrow 保留 be2 code/status);`resolveProdOids` Set dedup + 每批 ≤5 分批;全域 cache(不分 session)維持,trade-off 留痕。
- §5.2:移除 `.refine()`,改 handler 手動驗證(兩陣列皆空回 `MISSING_ID`),含「落地註記」供 §8 Test 8 引用。

**PLAN — 核心已落地,3 處補充未進檔(下方 patch)。**
- ✅ 已落地(grep 確認 =1):Task2 catch 404-only、Task2 分批 `batch.map`、Task2 cache trade-off、Task6 收斂(只改 `openWorkbench.ts`)。
- ❌ 未落地(grep 確認 =0):**並發測試、Self-Review codex 記錄段、Task5 announcement 註記**。

## 3. 待套用的 3 個 patch

### Patch 1 — 並發測試(Task 2 Step 1,`describe('resolveProdOids')` 內)

**搜尋錨點**(dedup 測試結尾 + describe 收尾):

```
    expect(out.resolutions).toEqual([{ mid: '10759', oid: '38352' }])
    expect(out.resolved).toEqual(['38352'])                 // oids 與解出 oid 重疊 → 去重
  })
})
```

**替換為**:

```
    expect(out.resolutions).toEqual([{ mid: '10759', oid: '38352' }])
    expect(out.resolved).toEqual(['38352'])                 // oids 與解出 oid 重疊 → 去重
  })

  it('分批:mid 解析階段並發不超過 5(對齊 find_products gateway burst 控制,codex Issue 5)', async () => {
    let inFlight = 0, peak = 0
    const gw = { get: async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--; return { prod_oid: '1' }
    } } as never
    await resolveProdOids(Array.from({ length: 12 }, (_, i) => String(i)), [], gw, 't')
    expect(peak).toBeLessThanOrEqual(5)
  })
})
```

### Patch 2 — Self-Review 的 codex 修正記錄

**搜尋錨點**(Self-Review「落地偏差」段的 refine bullet,結尾「見 Global Constraints。」):

```
- spec §5.2「zod `.refine()` 擋兩陣列皆空」→ 因 codebase inputShape 為 raw shape、SDK `inputSchema` 不接 `ZodObject`(全 repo 零 refine 用例),落地改為 handler 開頭手動驗證回 `MISSING_ID`。功能等價(皆擋「兩陣列皆空」),與 §5.1 手動驗證一致。見 Global Constraints。
```

**在其後插入**:

```
**codex cross-model review 修正(2026-08-31,已落地本 plan + spec):**
- **Issue 1(scope 收斂)**:`open_batch_wizard`/`open_announcement_wizard` 未註冊為 model-visible(dead tool)→ Task 6 只改 `open_workbench`;`workbench` 面板 UI 不消費 prefill、手動貼 mid 不生效 → resolver 生效面收斂為「agent 對話直呼工具」,面板 UI mid 列 follow-up(spec §5.3 已知限制 + §7.6)。
- **Issue 3**:resolver catch 只在 `status===404` 改寫 `MID_RESOLVE_FAILED`,其餘 status 原樣 rethrow → Task 2 handler + 新增 403-rethrow 測試。
- **Issue 5**:`resolveProdOids` 內部分批(每批 ≤5)+ Set dedup 對齊 `find_products` 既有 burst 控制 → Task 2。
- **Issue 2**:全域 cache 不分 session 經評估維持(oid 非機密、下游 per-user gate),trade-off 留痕 → Task 2 cache 註解 + spec §4/§7.3。
- **Issue 4**:`app_get_announcement_view` 既有 read-oid 登記破口(讀取失敗仍登記)為既有債,本次不擴大處理 → spec §7.7 follow-up + Task 5 註記。
- **Issue 6**:`mid-info` 的 `prod_oid` 頂層取值未經 repo 實證 → Task 7 Step 3 live 驗證 + 非頂層時補 fallback。
```

### Patch 3 — Task 5 announcement 既有債註記

**搜尋錨點**(Task 5 實作註,結尾「加第四參數 `resolutions`。」):

```
> 實作註:`appGetAnnouncementViewTool` 中段的 `client` / `counts` / `for (const oid of prodOids)` 區塊維持原樣,只是 `prodOids` 來源從 `args.prod_oids` 換成解析結果、`errors` 初值改為 `[...resolveErrors]`、最末 `makeEnvelope` 加第四參數 `resolutions`。
```

**在其後插入**:

```
>
> **既有債不擴大處理(codex Issue 4,spec §7.7)**:此工具中段迴圈即使某 oid 的 `info` GET 失敗(push 進 `errors`),仍把該 oid 放進 `products` 並列入 `read_oids`——「解析成功但實際讀取 403/404」的 canonical oid 因此仍可能通過 change-set 的 `SCOPE_NOT_READ` gate。這是本次改動前就存在的行為,本 task 維持原樣(把 `prod_oids` 換成 canonical oid,不改變登記時機)。§5.2「canonical oid 才進 scope-gate」指「進 gate 的是解析後的 oid,非原始 mid」,不宣稱「只有讀取成功的 oid 才進 gate」。要收緊另開 issue。
```

## 4. agy plan review 未結的 2 個 issue（round 2）+ 判斷

agy(Gemini)對改動後 plan 審到 round 2,push back「兩階段序列 peak=10 不疊加」已 **CONCEDE**。剩 2 個 REMAINING:

1. **並發測試 missing** → 套 Patch 1 即消(agy 只是看不到測試 code block,補上就好;邏輯本身 agy 已認同序列不疊加)。
2. **Task 5 缺 appTools schema 斷言替換 snippet** → **顧慮不成立、可 push back**。實查 `tests/appTools.test.ts` 的 `appGetBatchViewTool zod` describe 只有 `safeParse({ action_type, prod_oids: ['1'] }).success).toBe(true)`(接受合法),**沒有任何 `prod_oids: []` / `.min(1)` 的 reject 斷言**;`appGetAnnouncementViewTool` 也無此類斷言。故把 `prod_oids` 改 `.optional()` **不會破壞既有測試**,無 snippet 需替換。plan Task 5 Step 4 的 ⚠️ 註記可改為「經實查 appTools.test.ts 無 min(1)/空陣列 reject 斷言,無需替換」。

## 5. 請 codex 做什麼

1. 把 3 個 patch 套進 `docs/superpowers/plans/2026-08-31-be2-mcp-mid-oid-resolver.md`(搜尋錨點 → 套用)。套用後 grep 確認 3 個關鍵字都在:`並發不超過 5`、`codex cross-model review 修正`、`既有債不擴大處理(codex Issue 4`。
2. (可選)順手把 Task 5 Step 4 的 ⚠️ 註記改成「經實查無需替換」(見 §4 第 2 點)。
3. 若要把 plan review 收尾到 APPROVED:對 plan 跑一輪 review,確認 3 patch 已在 + Task5 顧慮已釐清。spec 不用再動(已 APPROVED rounds=5)。

## 6. 診斷線索(Claude Code 寫入為何幻想)

- **讀取類**(grep 顯示 0/MISS/實際檔案內容)這個 session 都正常。
- **寫入類**(Edit tool、Bash 內 python 寫檔)反覆「回報 updated successfully / count=1 / DELTA>0」但獨立 grep 事後顯示 **未落地**。
- 已排除「old_string 不 match」單一因素:曾出現 `ANCHOR_MATCHES=0`(anchor 兩行順序記錯)與後續逐行定位 `marker_line_indices=[231]` 正確、卻仍寫不進的情形交錯。
- 傾向:Claude 端在「預期成功」時把尚未真正持久化的結果當成已完成(生成幻想輸出);是否也有 harness file-state 同步層的問題,需以「貼上 patch 是否順利落地」反證——若 codex/人手套用順利,則屬 Claude 端幻想。
