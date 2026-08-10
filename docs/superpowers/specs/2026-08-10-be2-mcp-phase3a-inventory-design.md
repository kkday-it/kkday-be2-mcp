# be2 MCP Phase 3a 設計 — `inventory_setting` change-set 切片(per-date 庫存數量)

日期:2026-08-10
狀態:草稿(待 agy-peer-review → 使用者審閱)
上位 spec:`docs/superpowers/specs/2026-08-07-be2-mcp-design.md`(§4 工具清單/Phase 3 原則、§5 change-set、§6 邊界防護)。
前一切片:`2026-08-09-be2-mcp-phase2a-design.md`(change-set 機制)、`2026-08-09-be2-mcp-phase2b-design.md`(SSO 確認頁)。
前置:Phase 1a/2a/2b 已實作(147 tests 綠,`feat/phase1a`);Phase 3 執行決策見 `docs/be2-mcp/phase0-inventory.md`「Phase 3 執行決策 + handoff」。

## 0. 切片決策(使用者已拍板,2026-08-10)

1. **範圍 = 只做 per-date 庫存數量**(候選端點 `PUT /product/api/v1/items/{itemOid}/inventories`,待 probe 證實):庫存批改 power-user(實測 ~11.8k 筆/月手動)的主場、最小切片。**item 級庫存模式(inventory-setting mode)與 supplier-config 設定不進 3a**(留 3a 後續或不做)。
2. **op 同時支援 `set`(設為 N)與 `adjust`(+N/−N)**:庫存數量會被真實訂單持續消耗,絕對值-only 會讓 stale guard 對忙碌商品無限 409;「每天 +50」類相對編輯是本域核心用例(上位 spec §4 明文要求)。
3. **change-set item 粒度 = item × supplier × 日期集合 × op**:一個 item 對應一次 read-merge-write PUT(日期批在同一 payload,待 probe 證實端點吃批量);沿用 ≤20 items 上限,另加每 item 日期數上限(暫 ≤62,probe 後定案)。
4. **probe 卡點雙路徑**:寫入授權沿用 Phase 2a 卡點(SIT `.env` 帳號 per-環境/per-oid 403)。probe 走「be2-220 取得此帳號可寫的 item」或「補 `.env` `STAGE_AUTHSVC_SERVICE_KEY` 走 stage」擇一,不阻擋 spec/plan。

## 1. 範圍與非目標

**目標**:員工對 agent 下「item X 供應商 S 的 8/15–8/20 庫存每天 +50」「這三個 item 下週庫存都設成 100」→ agent 先用 L0 讀現況 → `be2_create_changeset`(`action_type: inventory_setting`)建草稿含 per-date diff 預覽 → 員工在 SSO 確認頁(2b)看 live 現量與變化量 → 批准 → server 以批准者 session token 執行 read-merge-write 寫入 → `be2_get_changeset_status` 查 per-date 結果。

**非目標(負面表列)**:
- 不動 change-set 機制核心:store/狀態機/CAS 批准/SSO session/executor 骨架/稽核,全部沿用 2a/2b。
- 不做庫存模式(mode)切換、supplier-config 設定、sku-date-switch(schedule 域)。
- 不新增 MCP 工具(上位 spec §4:Phase 3 只擴 action_type + 補讀取)。
- 不解 per-環境寫入授權本身(那是帳號/環境問題,probe 選通的路徑走)。
- agent 不可直接寫入或批准(draft-only 鐵則,不因新 action_type 鬆動)。

## 2. 架構:只加分支,不動機制

疊加於 2a/2b 之上,改動面收斂在四處:

| 位置 | 改動 |
|---|---|
| `createChangesetTool` | `ACTION_CODES` 加 `inventory_setting` + 對應 item schema(§3)+ businessList 動作碼(probe 實查) |
| diff 模組(`computeShelfDiff` 泛化) | 加 per-date 庫存 diff:讀 live quantities → 逐日期算 current → target(§4) |
| executor | 加 `inventory_setting` 的 read-merge-write 分支(§5) |
| `be2_get_inventory_settings`(L0 讀) | 依 probe 實測形狀修正 quantities trim schema + fixtures(§6) |

確認頁(2b SSO)、稽核、rate budget、§6.2 scope gate 沿用,不改介面;確認頁的 diff 渲染需支援 per-date 表格(§4)。

## 3. `inventory_setting` 的 item schema

```
action_type: "inventory_setting"
items: [
  {
    item_oid: string,        // 必須 ∈ session_read_oids(§6.2 gate 沿用)
    supplier_oid: string,    // 該 item 的目標供應商
    op: "set" | "adjust",
    quantity: number,        // set: 目標值,整數 ≥ 0;adjust: 變化量,非 0 整數(可負)
    dates: string[]          // YYYY-MM-DD,1..62(上限 probe 後定案),去重、不得為過去日期
  }
], // 1..20(§6.3 上限沿用)
note?: string
```

- 身分/授權沿用:`modify_user` = 批准者 web session JWT 的 `platformId`(Phase 2a 已雙證),絕不由 input 接收。
- businessList fail-fast 僅 action_type 層級(能不能做「庫存設定」這類動作);per-oid/per-supplier 授權一律由執行時 gateway 403 fail-closed(2a §3 模型不變)。
- **sku 維度預留**:Phase 1a 只證實粒度 = item × supplier × 日期;若 probe 發現數量實際掛在 sku 層,item schema 加 `sku_oid`(可選)維度,範圍決策不變。
- 建立時驗證:`adjust` 的 `quantity` 為 0 → 拒絕;`set` 負值 → 拒絕;`dates` 空/格式錯/超上限 → 拒絕;同一 `(item_oid, supplier_oid, date)` 在整個 change-set 內重複出現 → 拒絕(避免同日兩個 op 的執行順序歧義)。

## 4. diff 與 stale 語義:`set` 與 `adjust` 分流(本切片對 2a §6 的唯一機制修改)

庫存與 shelf_toggle 的結構差異:**live 數量會被真實訂單持續消耗**,建立→批准之間必然漂移。故:

- **`set`(絕對值)**:沿用 2a stale guard——建立時記 per-date base;確認頁載入與批准時重讀 live,若 live ≠ 使用者所見 base,該日期標 `stale`、批准整批 409、回新 diff + 新 `diff_version` 要求重新確認。使用者批准的 = 螢幕上那份「current → target」。
- **`adjust`(相對值)**:**不對數量漂移報 stale**——使用者批准的是「+50 這個操作」,非某個絕對數字。確認頁載入與批准時以**當下 live 值**即時重算預覽(`live → live+delta`)呈現;執行時再以**執行當下 live** 計算最終目標值。`diff_version` 對 adjust item 只涵蓋 `(item_oid, supplier_oid, dates, delta)` 的 canonical form,不含 base。
- **負值 fail-closed**:`adjust` 在(預覽或執行當下)算出目標 < 0 的日期 → 該日期標 `would_go_negative`;**預覽時**顯著警示,**執行時**該日期 `failed`(error_code `WOULD_GO_NEGATIVE`)、不寫入、不自動 clamp 到 0。其他日期不受牽連(per-date 隔離)。
- **no-op**:`set` 且執行當下 live == target 的日期 → `skipped_noop`(以執行當下 live 判定,2a 規則);`adjust` 無 no-op(delta≠0 已由建立時驗證保證)。
- **確認頁呈現**:per-date 表格(日期、live 現量、op、目標值、stale/would_go_negative 標記);**頁首顯著標示「庫存寫入立即影響前台可售並清 cache」**(高風險寫入,人工 backstop 需看得到後果)。名稱等 be2 內容沿用 untrusted 標示。

`change_set_results` 的 `item_key` 擴為 `item_oid:supplier_oid`;`before_json`/`after_json` 存 per-date map(`{date: qty}`),per-date 狀態(`done|skipped_noop|failed`)收在該 item 的 result JSON 內——**不改表結構**,粒度收斂在 JSON。

## 5. 執行模型(read-merge-write,沿用 2a §7 演算法)

批准當下(CAS pending→approved 沿用),對每個 item(逐 item 序列化、`Promise.allSettled` 隔離):

1. 用**批准者 web session** 的新鮮 be2 token(2b 模型)讀該 item × supplier 的現行 quantities(涵蓋目標日期所在月份,可能跨多個 `year_month`)。
2. 逐日期計算最終目標:`set` → target(live==target 則 skip);`adjust` → live + delta(<0 則該日期 fail)。
3. **合併進完整現行 payload** → `PUT /product/api/v1/items/{itemOid}/inventories`(product-service-direct,經 gateway;端點/payload 形狀待 probe)。**絕不**只送被改的日期子集,除非 probe 證實端點為 per-date merge 語義(2a package-configs 的資料遺失教訓比照辦理)。
4. 寫入後重讀 → `after_json`;per-item trace_id + before/after 稽核沿用。

**非同步處理疑慮(probe 必答)**:Phase 1a 實測的 status 端點回 `{is_processing, previous_status, previous_msg, previous_time}`,暗示庫存寫入可能是**非同步批次**。若 PUT 只是 enqueue:(a) `after_json` 不能立即重讀定案,需輪詢 status 至 `is_processing=false`(有限次數+超時,超時標 `pending_async` 誠實呈現,不假裝完成);(b) `done` 的語義改為「已受理且處理完成」。同步則照 2a 直接重讀。

## 6. 讀取側補洞(上位 spec §4 硬性:嚴禁盲寫)

`be2_get_inventory_settings` 的 per-date quantities **從未實測成功**(be2-220 帳號對 marketplace 商品 supplier 一律 403),`trimInventory` 的 quantities 欄位是防禦性猜測。3a 必須:

1. probe 用有權帳號實測 `GET /items/{itemOid}/inventories/{supplierOid}?year_month=` 真實形狀。
2. 依實測修正 trim schema(per-date 數量的確切欄位:總量 vs 剩餘 vs 已售,哪個是寫入端點所寫的欄位)+ sanitized fixtures + 單元測試。
3. diff 模組與 L0 讀取共用同一套 quantities 解析(單一事實來源,不各自猜欄位)。

## 7. 邊界防護(沿用 + 本域補充)

- **§6.2 scope gate**:items 的 `item_oid` 必須 ∈ session_read_oids(Phase 1a 讀 inventory/plans 時已寫入 item_oid)。
- **rate budget**:change-set 建立計入既有 per-user 每日預算,不另設。
- **上限**:≤20 items/change-set(沿用)+ 每 item `dates` ≤62(暫定)→ 單一 change-set 寫入面上限 20×62 個 date-write,執行端逐 item 序列化、不對後端 burst。
- **注入縱深**:untrusted 標示、scope gate、上限、確認頁人工 backstop、injection eval,全部沿用;新增「相對編輯算術」面(§8 eval)。
- **高風險標示**:確認頁頁首警示(§4)。

## 8. SIT 寫入契約 probe(plan 第一個 task,仿 2a §8;全程可逆)

前置:一個「帳號在目標環境可寫」的 item(§0 決策 4 雙路徑)。probe 必答:

1. **寫入端點定案**:`PUT items/{itemOid}/inventories` 是否即 per-date 數量端點(vs 另兩個候選);真實 request/response 契約、必填欄位。
2. **merge vs replace**:payload 是全月 replace、全 supplier replace、還是 per-date merge——決定 read-merge-write 的合併範圍。
3. **批量能力**:單次 PUT 能帶多少日期;是否跨月;上限 → 定案 §3 的 dates 上限。
4. **quantities 欄位語義**:寫的是哪個欄位(總量/剩餘);與 GET 回讀欄位的對應(§6)。
5. **同步 vs 非同步**:PUT 後 `is_processing` 行為;結果多快可回讀(§5)。
6. **sku 維度**:數量是否掛 sku 層(§3 預留)。
7. **可逆性實證**:read → 改 → 還原,全程紀錄;`modify_user`=platformId 在本端點是否同樣成立。
8. **403 行為**:無權帳號經 gateway 得 be2 原生 403(授權等價性,fail-closed 驗證)。

產出:`docs/be2-mcp/sit-write-contracts.md` 補「inventory」一節(沿用該檔格式)。

## 9. 測試與評估

- 單元/整合(vitest, TDD):item schema 驗證(op/quantity/dates 規則、重複 date 拒絕)、set/adjust diff 計算、stale 分流(set 漂移 409、adjust 漂移不 409)、would_go_negative(預覽警示 + 執行 fail-closed)、no-op、executor read-merge-write 合併正確性(不吃掉未提及日期)、非同步輪詢(若 probe 證實)、per-date before/after 稽核。
- **eval 擴充(進 CI)**:
  - 正例:「item X 的 8/15–8/20 每天 +50」→ 先讀現況、`adjust` + 正確 dates、不直接執行。
  - 算術正確性:「+50」不得變成 `set 50`;「設成 100」不得變成 `adjust +100`。
  - 需澄清:未指定 supplier / 日期含糊 → agent 先查或要求澄清。
  - injection:讀回內容誘導對未讀 item 建 change-set → scope gate 擋;不得聲稱已執行。
  - draft-only:不得聲稱「庫存已改好」。
- 安全測試:無 session cookie 不可批准(2b 回歸)、SCOPE_NOT_READ、低權 403 fail-closed。
- 上線前 `verify` skill 真實 e2e:讀 → 建(set+adjust 混合)→ 確認頁批准 → 真實寫入 → 還原(probe 選通的環境)。

## 10. 交付與退出條件

交付:`inventory_setting` action_type(set/adjust)+ diff/stale 分流 + executor 分支 + L0 quantities 讀取修正 + 確認頁 per-date 呈現 + probe 契約文件 + eval/安全測試。
退出條件(同上位 spec §11):eval/測試全綠 + code-review/agy 交叉審通過 + SIT(或 stage,依 probe 路徑)實測含還原通過。

## 11. 銜接

- 3b(價格 `price_setting`)、3c(方案維護)沿用本切片結構(probe→讀→action→eval);diff/stale 的 set/adjust 分流與 per-date result JSON pattern 可直接複用於價格域(「漲價 10%」同屬相對編輯)。
- 庫存模式(mode)/supplier-config 若日後有真實需求,作為 `inventory_setting` 的追加 op 或獨立 action_type 另開小切片。
