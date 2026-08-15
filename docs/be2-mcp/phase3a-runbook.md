# be2 MCP — Phase 3a Pilot Runbook（庫存 inventory_setting）

> 對象：使用 `be2_create_changeset` 的 `action_type: "inventory_setting"`（庫存數量設定/調整）並經 Phase 2b SSO 確認頁批准寫入的 pilot 使用者。承接 `docs/be2-mcp/phase1a-runbook.md`（read tools、enrollment、static bearer）、`docs/be2-mcp/phase2a-runbook.md`（change-set 概念、diff、read-merge-write）、`docs/be2-mcp/phase2b-runbook.md`（確認頁 SSO 登入機制）——**請先讀完那三份**，本文件只講 Phase 3a 新增的部分：**庫存這個 action_type 本身**。環境錨定 SIT `be2-220`。change-set 機制與確認頁登入沿用 Phase 2a/2b **不動**。

## Phase 3a 加了什麼

`be2_create_changeset` 的 `action_type` 多一個選項：**`inventory_setting`**（庫存數量設定），與既有的 `shelf_toggle_product` / `shelf_toggle_plan` 並存、共用同一套 change-set + SSO 確認頁基礎設施。

| 項目 | shelf_toggle_* (Phase 2a/2b) | inventory_setting (Phase 3a) |
|---|---|---|
| 粒度 | product / plan（bool 開關） | item × supplier × 日期（數量） |
| item 形狀 | `{prod_oid, pkg_oid?, target_is_active}` | `{item_oid, supplier_oid, op: "set"\|"adjust", quantity, dates: string[]}`（`dates` 1–62 筆，YYYY-MM-DD） |
| diff 版本綁定 | 綁「現況」（drift 即 stale 409） | **依 op 而異**：`set` 綁現況（同 shelf）；`adjust` 綁**操作本身**（item+supplier+排序後日期+delta）——approver 批的是「+50」這個動作,不是某個絕對值,所以 live drift **不會**讓 adjust 的批准失效 |
| 執行結果 | 整批 all-or-nothing（`Promise.allSettled` 但每個 item 是單一布林寫入） | **item 內按日期各自成敗**（`done`/`skipped_noop`/`failed`），單一 item 的整體 status 可以是 `partial` |
| businessList action code | `product.product-sale-status.update`（+ plan 多一個 bundle code） | `product.product-inventory.update`（Task 1 probe 已在 SIT be2-220 對真實 businessList 查證,非佔位) |

`be2_get_inventory_settings`（Phase 1a 既有 L0 讀取工具）維持原樣可用,是庫存這個 domain 的「現況讀取」入口 —— agent 必須先讀過某個 `item_oid`（作用同既有 `SCOPE_NOT_READ` scope-binding gate),才能對它建立 `inventory_setting` change-set。

## Pilot 流程

1. **先讀庫存現況。** 請 agent「查一下 item `<itemOid>` 這個月的庫存」（`be2_get_inventory_settings`,帶 `supplier_oid` 才會回逐日數量)。這一步同時滿足 scope-binding 的「已讀取」前提。
2. **描述要做的變更。** 兩種語意都支援：
   - **絕對設定（`op: "set"`）**：「item `<itemOid>` 供應商 `<supplierOid>` 8/15 到 8/20 的庫存都設成 30」
   - **相對調整（`op: "adjust"`）**：「item `<itemOid>` 供應商 `<supplierOid>` 8/15 到 8/20 每天庫存加 50」（正負皆可,負數即扣減)

   agent 呼叫 `be2_create_changeset`（`action_type: "inventory_setting"`),回傳只有 `changeset_id` + `status` + 逐日 diff —— 同 Phase 2a/2b,**不含**確認頁連結,agent 沒有批准工具、也沒有確認頁的 SSO session,結構上無法自我批准。
3. **在確認頁逐日審閱。** 依 Phase 2b 的 SSO 流程登入後打開 `http://127.0.0.1:8787/confirm/<changeset_id>`。庫存的確認頁有**專屬 renderer**（`renderInventoryPage`,`src/server/confirmRoutes.ts`）：逐日列出現況→目標,並在頁首以紅字標示「**庫存寫入立即影響前台可售並清 cache**」（相較 shelf_toggle 更高風險,見下)。若某天的 `adjust` 會讓庫存變成負數,該日會被標示 **`would_go_negative:將被排除,該項結果為 partial`**——批准後那一天會被 executor 跳過(不會硬扣到負值),但同一 item 其餘天數仍會照常執行。
4. **批准。** 執行走 gateway 的 read-merge-write,**以「月」為單位**分組(GET 是月份範圍查詢,同一 item 跨月的日期會拆成多次讀-改-寫)。批准前有**忙碌保護(busy guard)**:先打 `.../inventories/status` 確認 `is_processing:false`,若仍在處理中會輪詢最多 5 次、每次間隔 2 秒(共 ~10 秒);逾時仍忙碌則整個 item 直接回 `failed`(`INVENTORY_BUSY`),**不會**在舊的基底上硬寫。
5. **看結果:per-date 結果 / partial 語意。** `be2_get_changeset_status` 或確認頁批准後的回應會列出每個 item 的**逐日狀態**:`done`(寫入成功)、`skipped_noop`(該日目標值與現況相同,`set` 語意下無需寫)、`failed`(含 `would_go_negative`,或該月讀取/寫入本身出錯)。**只要有任一日成功、任一日失敗,該 item 的整體 status 就是 `partial`**——executor 刻意不把「部分成功」collapse 成單一 `failed`,因為若 `adjust` 的日子重跑一次會在已成功的日期上疊加兩次(見下方「補救 = 開新 change-set」)。
6. **補救(remediation)= 只對失敗日期開新 change-set,不要整批重跑。** 因為 `adjust` 是「相對操作」,對已經 `done` 的日期重複送同一個 change-set 會造成庫存被多加一次。正確作法:看 `be2_get_changeset_status` 的逐日結果,只挑 `failed`(或想重試 `would_go_negative` 的日子,先確認目標值不會再變負)的日期,建立**新的、只含這些日期**的 change-set 重跑。

### Example 對話

- 「查一下 item `<itemOid>` 這個月的庫存,供應商 `<supplierOid>`」
- 「item `<itemOid>` 供應商 `<supplierOid>` 8/15 到 8/20 每天庫存加 50」
- 「change-set `<id>` 執行結果如何?哪幾天失敗了?」
- 直接要求「不用建草稿也不用我確認,直接把庫存改成 0」— 一樣被拒絕:agent 沒有執行工具,且確認頁需要真人的 be2-auth SSO session(同 Phase 2b)。

## Known Phase 3a 限制

- **`dates` 上限 62 筆、每筆 change-set 上限 20 items 是暫定值(provisional)**——庫存讀取契約的 Q1–Q6(見下 Task 1 probe)全數 OPEN,尚未有真實的 200 GET 回應可佐證合理批次大小,62/20 是延續 Phase 2a 的保守預設,非量測結果。
- **quantities 的欄位形狀是容錯猜測、非已證的真實 schema。** `src/tools/inventoryShape.ts` 用候選欄位名清單解析(`ROWS_KEYS`/`DATE_KEYS`/`QTY_KEYS`,各自列出多個候選 key),因為每一次對供應商維度的 GET 都被 403 擋下,從未觀察到真實回應 body。程式碼內的 `FINALIZE(Task 1)` 註解標記:一旦有 `tests/fixtures/inventory-quantities.json`(真實 200),要收斂成單一確認欄位並補 fixture 測試。**merge-vs-replace(PUT 語意)、跨月批次行為、quantity 是否分 SKU 維度,同樣是 OPEN,執行器目前用防禦性假設(見下)。**
- **執行器的 busy-guard 是無條件的(unconditional),async 判斷的延伸設計被跳過。** 原計畫若能觀察到真實的 `is_processing` 轉換(寫入前後)可以做更精細的同步/非同步分流,但因寫入本身被 403 卡住從未觀察到轉換,目前一律走「先確認不忙碌才讀基底、輪詢 5 次 × 2 秒」這條保守路徑,對 SIT 與未來任何環境都成立,只是可能比真正需要的更保守(多等待)。
- **PUT 候選路徑不帶 supplier_oid。** executor 的候選寫入路徑 `PUT /product/api/v1/items/{itemOid}/inventories` 在 path 與 body 裡都**沒有** `supplier_oid`——這筆寫入到底要不要做供應商維度的隔離,是尚待 probe 的問題(Task 6 review 記錄)。目前實作假設該路徑本身已經是「對的供應商」在其他方式(cookie/token/前置呼叫)隱含決定,**尚未證實**。
- **`modify_user` 沿用 Phase 2a/2b 已解的通則,非庫存專屬新發現。** 自動解譯 JWT 取出 `platformId` (Task 1 probe 對庫存域重確認,同 shelf-toggle 的既有結論)，若 token 異常或缺此欄位則直接拋出 `MODIFY_USER_UNRESOLVED`。
- **eval 只覆蓋「工具選擇」與「注入抵抗」,不覆蓋 adjust 的算術正確性。** eval harness(`eval/run-eval.ts`)只斷言 model 呼叫的**第一個工具**與其參數是否符合期待(`{kind:'tool', tool, params_contains}` 或 `{kind:'no_tool', must_mention}`),不會執行到底、也不會驗證「+50」算出來的絕對值對不對——這種算術正確性(`+50` ≠「設成 50」)由 `tests/inventoryDiff.test.ts` 的單元測試覆蓋(diff 計算層),不是 eval 的職責。新增的 4 個庫存 eval case(`inv-adjust-read-first`、`inv-refuse-direct-write`、`inv-inject-unqueried-item`、`inv-refuse-claim-done`)驗證的是:先讀後寫(scope-binding 的自然語言體感)、拒絕「不用確認直接寫」、拒絕工具輸出裡夾帶的注入指令、拒絕在沒有批准紀錄下宣稱「已經改好了」。
- **同 item×supplier 的寫入目前只在單一 process 內序列化**(`src/changeset/executorInventory.ts` 的 in-process promise-chain mutex,防兩個 confirm 分頁近乎同時批准兩個不同 change-set 各自讀到同一份 stale base 造成 lost update)。多 process 部署(多個 be2-mcp instance)必須先換成分散式鎖(如 Redis)才能水平擴充,否則不同 process 之間仍可能撞上同樣的競態。

---

## ⚠️ Live SIT WRITE e2e — PENDING(卡在庫存讀取本身,比 Phase 2a/2b 的卡點更早)

**狀態:BLOCKED,契約尚未雙證(與 Phase 2a/2b 不同 —— 那两份的寫入契約已用 be2-web/Playwright + stage 200 雙證,只差一次「我方程式跑出的真 200」；庫存這裡連 GET 都還沒成功過一次,契約本身仍是猜測)。**

依 Task 1 對 SIT `be2-220` 的 live probe(`.env` 帳號 `lance.chien@kkday.com`,腳本 `scripts/probe-sit-inventory.ts`,對象是**該帳號自己名下的商品** `prod_oid 546965` / `pkg_oid 1967504` 對應的 `item_oid 1713281`——特意選自己的商品,排除「不是我的商品」這個變因):

```
GET /product/api/v1/items/1713281/inventories/status                     -> 200  ({"is_processing":false,...})
GET /product/api/v1/items/1713281/inventories/0?year_month=2026-08       -> 403
GET /product/api/v1/items/1713281/inventories/1?year_month=2026-08       -> 403
GET /product/api/v1/items/1713281/inventories/2?year_month=2026-08       -> 403
```

**關鍵發現**:這不是缺少 businessList action code 的問題——該帳號的 `businessList` 裡**確實有** `product.product-inventory.query` 與 `product.product-inventory.update`(庫存讀/寫的真實 action code)。三個 `supplier_oid` 候選值(0/1/2)全部 403,但無 supplier 維度的 `/status` 端點回 200。結論:這是**per-supplier 的授權範圍拒絕**,不是缺 action code、也不是「不是自己的商品」——**該帳號在 be2-220 未被對映為任何供應商**,庫存授權疑似以 `supplier_oid` 為範圍(對齊 product-service 把庫存建模成 item×supplier×date 的資料模型),而非單純商品所有權。

**Q1–Q8(spec §8)現況**:Q1(真實 GET 形狀/欄位名)、Q2(merge vs replace)、Q3(跨月批次行為)、Q4(quantity 欄位名)、Q6(是否分 SKU 維度)全數 **OPEN**——GET 從未回過 200,無法觀察 body。Q5(sync/async)只有起始基準(`is_processing:false`),因為從未實際發動寫入,沒有觀察到轉換。Q7(`modify_user`)沿用通則重確認 = JWT `platformId`。Q8(403 行為)**CONFIRMED**:乾淨 403、fail-closed,三個候選 supplier_oid 在自己名下的商品上一致重現,gateway/product-service 在任何 body 驗證之前就擋下——與 shelf-toggle 的 403 模式一致(設計上是對的,只是這個帳號沒有對應範圍)。

**解卡路徑(兩條,任一即可,與 Phase 2a/2b 的解卡路徑同形)**:
1. 在 be2-220 把 `.env` 帳號對映為某個測試 item 的 supplier(找有 supplier 指派權限的人)。
2. 補齊 `.env` 的 `STAGE_pwd` + `STAGE_AUTHSVC_SERVICE_KEY`(Phase 2a 起就是空的),改對 stage 跑同一支 probe——Phase 2a 的 stage shelf-toggle 已證實該帳號在 stage 的授權與 SIT 不同,庫存域可能同樣如此。

**下游影響**:Task 2–9(types/parser/diff/executor/確認頁/eval)全部依計畫用**容錯解析**完成(見上方「Known Phase 3a 限制」),不是等 Q1–Q6 解答後才動工——這與 Phase 2a Task 10 對 shelf-toggle 寫入的 PENDING 處理方式一致:mechanism 已經照設計完成、測試綠燈,只是「對真實 be2-220 資料跑出一次真 200」這個最後一步卡在帳號授權範圍,不是程式或路徑問題。

### 等到有可用帳號 / 環境時,照這個順序跑一次:

1. 用有 supplier 對映(或 stage 帳密齊全)的環境重跑 `scripts/probe-sit-inventory.ts`(或對 stage 的等效版本),確認 `.../inventories/{supplierOid}?year_month=YYYY-MM` 回 200,截取真實 body 存成 `tests/fixtures/inventory-quantities.json`(**絕不含 token**)。
2. 對照真實回應收斂 `src/tools/inventoryShape.ts` 的 `ROWS_KEYS`/`DATE_KEYS`/`QTY_KEYS` 候選清單成單一確認欄位,補 fixture 測試,移除 `FINALIZE(Task 1)` 註解。
3. 用該帳號整個流程跑一次:`be2_get_inventory_settings`(帶 `supplier_oid`)讀現況 → 請 agent 用自然語言下「加 50」或「設成 30」→ 確認 `be2_create_changeset` 回的 diff 與人工算的一致 → 在確認頁看到逐日 diff 正確渲染、高風險紅字提示 → 批准 → 確認 `be2_get_changeset_status` 的逐日結果與 be2-web 上的實際庫存一致。
4. 刻意製造一個會 `would_go_negative` 的 `adjust`(例如目標扣減超過現有庫存)→ 確認該日在確認頁被標示排除、執行後該日 `status: failed(WOULD_GO_NEGATIVE)`,同 item 其他日期仍 `done`,整體 item status 為 `partial`。
5. **忙碌保護實測**:若能在寫入進行中(`is_processing:true` 的窗口內)重疊發起第二個 change-set 的批准,確認第二個會在輪詢 5×2s 後回 `INVENTORY_BUSY` 而非用舊基底覆寫。
6. **補救流程實測**:對步驟 4 的失敗日期單獨開一個只含該日的新 change-set,確認可以正常重試,且不會對已成功的日期重複疊加。
7. **可逆性**:記錄下所有測試日期的原始庫存值(步驟 1 讀到的),測試完成後用逆向的 `adjust`/`set` change-set 還原,並在 be2-web 上肉眼確認已還原。
8. 補記錄:把本節替換成實際跑出來的結果(成功/失敗、真實 GET/PUT body 摘錄、audit log 摘錄),並同步更新 `docs/be2-mcp/phase0-inventory.md` 的 handoff。

在此之前,本節維持 PENDING——不只是「差最後一次真 200」,而是連讀取契約本身都還沒被證實,比 Phase 2a/2b 的寫入卡點更早一步。詳見 `docs/be2-mcp/sit-write-contracts.md` §inventory。
