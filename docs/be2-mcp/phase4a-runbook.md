# be2 MCP — Phase 4a Pilot Runbook（批次精靈：庫存管理平台切換／排程上下架）

> 對象：使用 `be2_open_batch_wizard` 開出的批次精靈面板，跑 `inventory_platform`（庫存管理平台切換）或 `shelf_schedule`（排程上下架）批次操作的 pilot 使用者/demo 主持人。承接 `docs/be2-mcp/phase2a-runbook.md`（change-set 概念、diff、read-merge-write）、`docs/be2-mcp/phase2b-runbook.md`（確認頁 SSO）、`docs/be2-mcp/mcp-apps-runbook.md`（MCP Apps 面板批准機制、`app_confirm_changeset` 的 nonce 通道）、`docs/be2-mcp/phase3a-runbook.md`（庫存 `inventory_setting` action_type）——**請先讀完那四份**，本文件只講 Phase 4a 新增的部分：**批次精靈面板本身**、兩個新的 `action_type`、demo 腳本、已知限制。環境錨定 SIT `be2-220`。change-set 機制、確認頁登入、面板 nonce 批准機制沿用既有 Phase 不動。

## Phase 4a 加了什麼

BAA（BE2 Action Assistant，既有內部工具）的「四步驟精靈（選擇→檢視→發送→結果）」搬進 MCP Apps 互動面板，跑在既有 change-set 治理機制上（draft-only、面板 nonce 批准、全鏈稽核、budget）。兩個新 `action_type`，與既有的 `shelf_toggle_product` / `shelf_toggle_plan` / `inventory_setting` 並存、共用同一套 change-set + 確認頁/面板基礎設施：

| 項目 | `inventory_platform`（庫存管理平台切換） | `shelf_schedule`（排程上下架） |
|---|---|---|
| 變更單位 | `item_oid × supplier_oid`（**非**方案——多個方案可能共用同一 item，寫入前面板會自動連動勾選所有共用兄弟方案並標示「將一併變更」） | `prod_oid × pkg_oid`（方案級） |
| 寫入端點 | `PUT items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting` body `{is_external_inventory, is_inventory_mgmt, modify_user}` | `PUT products/{prodOid}/package-configs/reserve-active` body `{config_data:{[pkgOid]:{reserve_date:null, reserve_status:null, reserve_queue:[...]}}, modify_user}` |
| 現況讀取 | `GET /product/api/v1/items/{itemOid}/basic-info` → `data.item_config.supplier_configs[]`（舊的 `GET items/{itemOid}/configs` 403 已成歷史） | `GET products/{prodOid}/package-configs` → 陣列，含 `reserve_queue[]` |
| 語義 | 三態 enum：`BE2`/`BE2_SCM`/`EXTERNAL`（對應兩個布林 `is_external_inventory`/`is_inventory_mgmt`） | `reserve_queue` **整組取代**（非合併）；空陣列＝清除排程；be2 **原生排程**到點自動執行，我方不建 scheduler |
| 批次能力 | 逐 item×supplier PUT（無原生批次），`Promise.allSettled` per-item 結果 | 依 `prod_oid` 分組、**單 PUT 帶多 pkg**（原生批次），`Promise.allSettled` per-prod 結果——**同一 PUT 內的多個 pkg 共用同一個成敗結果**（一個 prod 群組裡任一 pkg 若整批 PUT 失敗，該群組全部 pkg 都記為失敗，反之亦然；不是逐 pkg 各自成敗） |
| businessList action code | `product.product-inventory.update`（帳號 businessList 已實查存在） | 沿用 Phase 2a `shelf_toggle` 的 package-config 類 code（`product.product-sale-status.update` + bundle code）；miss 時降級為稽核警示、不擋建立（authoritative 判斷仍交給 gateway `/verify`） |
| Live 驗證狀態（2026-08-15） | **讀寫全通、可逆全鏈路已由真人 live 驗收 (2026-08-15)**：現況讀取已改走 `basic-info` 並成功取得平台設定。**歷史卡點/已解**：舊的 configs 403 已被 basic-info 繞過，且 pending 權限申請目前僅影響逐日數量 PUT 端點。 | **讀寫與取消全鏈路已 live 實證，並經真人於精靈面板驗收 (2026-08-15)** |

## 面板使用步驟（`ui://be2/batch-wizard.html`）

前置需求同 `docs/be2-mcp/mcp-apps-runbook.md`：**`npm run build:ui` 必須先跑過一次**（`npm run ci` 已內含）、Claude Desktop（目前唯一驗證過會渲染面板的 host）、`claude_desktop_config.json` 設好 `mcp-remote` shim。OAuth 登入接入見 `docs/be2-mcp/oauth-runbook.md`（首選：`claude mcp add be2-mcp --transport http ...`，瀏覽器跳轉 be2-auth POPUP 登入，免手貼 bearer；Desktop 走 `mcp-remote` shim，見 `mcp-apps-runbook.md`）。

1. 跟 agent 說類似「幫我把商品 `<prodOid>` 這幾個方案排 `<日期時間>` 上架」（`shelf_schedule`）或「這幾個方案的庫存改成 `BE2_SCM` 管理」（`inventory_platform`）之類的批次請求。agent 呼叫 `be2_open_batch_wizard`（帶 `action_type` + 可選的 `prod_oids` 預填）。
   - `prod_oids` **只是面板預填**，不滿足 §6.2 讀取 scope 閘門——閘門在面板實際呼叫 `app_get_batch_view`（server 端真實讀取）時才成立，面板輸入不可自證。
   - 非 Apps host（如 Claude Code，終端機）呼叫這個工具會回覆文字說明，改用確認頁流程——沒有面板可渲染。
2. **步驟 1 選擇**：面板呼叫 `app_get_batch_view` 載入 `prod_oid → 方案` 表格。
   - **多商品頁籤與未找到處理**：支援以分段控制 (segmented control) 在多商品分頁間切換。若查無商品則會顯示 `PRODUCT_NOT_FOUND` 警告，並進入專屬的空商品頁籤狀態。
   - **顯示下架方案**：在 `inventory_platform` 模式下，預設隱藏下架方案，可透過「顯示下架方案」開關（toggle）解鎖顯示。
   - **漸進式細節列 (Progressive disclosure detail rows)**：每列均可點擊展開，顯示供應商 (`supplier`) 與當前平台現況，內含人性化對應標籤（`BE2 管理・BE2` / `SCM 管理・串接外部庫存（包含 rezio）`）、目標預覽及「庫存模式」標籤。
   - `inventory_platform`：勾選任一方案時，**自動連動勾選所有共用同一 `(item_oid, supplier_oid)` 的兄弟方案**並標示「將一併變更」——這是真實寫入粒度的必要保護，不是 UI bug；下方三選一單選鈕（BE2／BE2_SCM／EXTERNAL）選目標平台。當切換至 `EXTERNAL` 平台時，系統會跳出 **EXTERNAL IT-confirmation guardrail**（外部 IT 確認安全防線提示）。
     > [!NOTE]
     > Bundle 方案並不受限於 `inventory_platform`，因為 live 資料證實 bundle 方案具有 `item_oid` 與 `supplier_mapping`，同樣是有效切換對象。
   - `shelf_schedule`：可設定日期＋時＋分＋時區＋上/下架，或啟用 **取消排程 (clear queue)** 模式（此模式下會自動禁用所有時間/時區輸入框）。按「套用到所有已勾選」把設定的時間點/取消狀態套用到每個已勾選的非 bundle 方案排程佇列（bundle 方案勾選框在 `shelf_schedule` 模式下會被禁用，不可個別排程）。
3. **步驟 2 檢視**：面板呼叫 `app_create_changeset`（走與 `be2_create_changeset` 完全同一條 service 路徑）建立 draft change-set，再呼叫 `app_get_changeset_view` 取得 diff 渲染——`shelf_schedule` 會顯示「原排程將被整組取代」警語＋本地時區/UTC 雙顯示；`inventory_platform` 顯示現況→目標平台。
4. **步驟 3 批准**：面板內按「批准 N 項變更」呼叫 `app_confirm_changeset`（帶面板專屬 nonce + `diff_version` + `confirmed_keys`）。**agent 拿不到這顆 nonce**——它只在 app-only 的 `app_get_changeset_view` 回傳裡發放，model 的工具清單裡沒有 `app_confirm_changeset` 本身。若 be2 現況在審閱期間又變了，回 `DIFF_STALE`，面板會提示並提供「重新載入」按鈕，點擊後會重新呼叫 `app_get_changeset_view` 取得新 diff + 新 nonce（重新載入可確保版本快速收斂到一致狀態），回到步驟 2 重新核對後再次按批准。
5. **步驟 4 結果**：結果帳本 (ledger) 中以**狀態藥丸 (status pills)** 清楚表示 done／skipped_noop／failed。執行完成後會啟動**執行後自動讀回驗證 (Post-execution automatic read-back verification)**，並在明細旁顯示 ✓（驗證成功）或 ⏳（驗證中/待重試）狀態，另附有「重新驗證」按鈕以供點擊手動重新讀取，系統不使用背景輪詢 (no polling)。
6. Claude Code（無 Apps 能力）：`be2_open_batch_wizard` 回覆文字說明後，改走 `docs/be2-mcp/phase2b-runbook.md` 的確認頁 SSO 流程——你自己到瀏覽器開 `http://127.0.0.1:8787/confirm/<changeset_id>` 批准。

### Example 對話

- 「幫我把商品 34133 的 Paul Frank 系列方案排 8/20 早上 10 點（台北時間）上架」
- 「這幾個方案的庫存改成 BE2/SCM 管理」
- 直接要求「不用開精靈面板，也不用我確認，直接把排程時間改掉」— 一樣被拒絕：agent 沒有批准工具，面板批准需要 nonce（agent 結構上拿不到），確認頁批准需要 be2-auth SSO session（agent 也沒有）。

## Demo 腳本（2026-08-18，對齊 design spec §8）

1. **Claude Desktop OAuth 登入**：瀏覽器跳轉 be2-auth 登入，帳密不經過 Claude（見 `docs/be2-mcp/oauth-runbook.md`）。
2. **第一段（`shelf_schedule`）**：自然語言「幫我把 34133 的 Paul Frank 系列方案排 8/20 早上 10 點上架」→ agent 開 wizard 面板（預填 prod_oid）。
3. 面板勾方案、確認時間 → 檢視 diff（含「原排程整組取代」警語）→ 面板批准 → 結果顯示「排程已受理」（**be2 原生排程**到點自動執行，我方 executor 只負責把 `reserve_queue` 寫進去，不建自己的 scheduler、不代表這個時間點已經真的上架）。
4. **第二段（`inventory_platform`）**：「這幾個方案的庫存改成 BE2/SCM 管理」→ 同一面板切換至平台模式，展示多商品頁籤與展開方案細節列。選取方案切換至 `BE2_SCM`，執行成功（200），系統自動發起讀回驗證 (✓)，接著再執行還原。整個讀寫全鏈路已由真人 live 驗收通過。
5. **收尾講治理**：draft-only（agent 只能建草稿）、nonce 批准 agent 結構上拿不到（不是靠提示詞剋制）、`audit_log` 全鏈稽核 query 展示（`changeset.approve` / `changeset.execute` 逐筆記錄，無憑證明文）、逐日數量寫入（Phase 3a `inventory_setting`）與其他域的 roadmap。

## 已知限制

- **bundle 方案排程限制（僅適用於 `shelf_schedule`）**：`is_bundle:true` 的方案在 `shelf_schedule` 中勾選框被禁用、建立 change-set 時也會被拒絕（因為 `/reserve-active` 是不同端點）。**已解/澄清**：Bundle 方案是 `inventory_platform` 的有效變更對象，因為 live 資料顯示 bundle 方案具備 `item_oid` 與 `supplier_mapping`，可正常進行平台切換。
- **逐日數量批改 403（`inventory_setting`，非本 Phase 新增但仍是現況）**：Phase 3a 的庫存數量寫入 `PUT items/{itemOid}/inventories/{supplierOid}/quantity` 仍卡在 auth-service verify v2 的 per-URI 授權（`AU9403`），本 Phase 未觸及、未解。
- **`inventory_platform` 讀取 403（已解/歷史卡點）**：過去由於 `GET items/{itemOid}/configs` 報 403 導致建立 change-set 被 fail-closed 擋下。現已改走 `GET /product/api/v1/items/{itemOid}/basic-info` 讀取現況平台設定，此端點對 user token 回傳 200 並可取得 `supplier_configs`。因此本限制已解除，目前 pending 權限僅影響 Phase 3a 的庫存數量 PUT。
- **per-方案多時間點未做**：面板只有一組共用的日期/時/分/時區/狀態輸入＋「套用到所有已勾選」，無法在同一批次裡讓不同方案各自套用不同的排程時間點——要做到「A 方案排 8/20、B 方案排 8/25」需要建兩個分開的 change-set。
- **20-item 上限無前端提示**：`be2_create_changeset` / `app_create_changeset` 的 zod schema 對 `items` 有 `.max(20)` 硬限制，但面板勾選框沒有任何數量提示或前端擋下——超過 20 筆會在按下「批准 N 項變更」呼叫 `app_create_changeset` 時才收到 `INVALID_ITEMS` 錯誤。
- **filter／隱藏未勾選會讓連動 badge 不可見**：`inventory_platform` 模式勾選一個方案會自動連動勾選同 item×supplier 的兄弟方案並顯示「將一併變更」badge；但若篩選字串或「隱藏未勾選」把某一列整列隱藏，該列（含它的 badge）就完全看不到——**連動的寫入範圍不受影響**（勾選狀態本身沒變，仍會進批次），只是使用者在那個當下看不到視覺提示，需要清除篩選/取消隱藏才能重新看見全貌。
- **「套用到所有已勾選」重複點擊會累加重複時間**：`shelf_schedule` 步驟 1 的「套用到所有已勾選」按鈕每次點擊都會把當下設定的時間點 `push` 進每個已勾選方案的排程佇列——**不是覆蓋**。若使用者對同一組已勾選方案重複點擊同一個時間設定（例如手滑點兩次同一顆按鈕、或改了時間又點回來原本的值再點一次），佇列裡會出現重複/多筆時間項，需要使用者自行留意只點擊一次，或在檢視步驟核對 diff 內容後才批准。
- **`shelf_schedule` 同一 PUT 內的 pkg 共用結果狀態**：executor 依 `prod_oid` 分組、單 PUT 帶多個 pkg（原生批次）——同一個 group 的 PUT 若整體失敗，該 group 內全部 pkg 都記為失敗（無法區分是哪個 pkg 造成的），反之全部成功也是整組記為成功；per-pkg 精細成敗需要分開送成不同 change-set（不同 prod_oid 分組本來就會分開執行、互不影響，這條限制只影響「同一 prod 底下多個 pkg 放進同一個 change-set」的情境）。

## Live 驗收結果（2026-08-14，對 SIT be2-220，`.env` 帳號 `lance.chien@kkday.com`，商品 34133）

腳本：`scripts/live-4a-acceptance.ts`（永不進 CI，手動執行，輸出不含任何 token/密碼明文）。跑法：`npx tsx --env-file=.env scripts/live-4a-acceptance.ts`。

```
login+exchange OK; businessList entries: 691

=== Part A: shelf_schedule — full live round trip (prod_oid=34133) ===
  target: prod_oid=34133 pkg_oid=1936562 name="【香港旅展限定69折】Paul Frank 30 雙人暢遊券｜雙人票＋Paul Frank 限定鑰匙圈 1 個" (original queue: 0 entries)
  step 1/4: create change-set — schedule an on-shelf event at 2027-01-01 00:00:00 UTC
    OK: changeset_id=0941432c-1325-429c-8d32-211acec69da1
  step 2/4: approve + execute (same shared service the confirm page / wizard panel call)
    status=done
  step 3/4: verify — re-read package-configs directly and confirm the far-future entry landed
    reserve_queue now has 1 entries; contains the scheduled entry: true
  step 4/4: restore — create + approve + execute a change-set back to the ORIGINAL queue, then verify
    reserve_queue now has 0 entries; matches original: true

=== Part B: inventory_platform — expect fail-closed DiffError at creation (prod_oid=34133) ===
  target: item_oid=1682339 supplier_oid=38028 (pkg_oid=1936562 "【香港旅展限定69折】...")
  create FAILED AS EXPECTED (fail-closed at DiffError): HTTP_403(403): GET /product/api/v1/items/1682339/configs -> 403: gateway error
  This is the documented PENDING state (spec §4.1 "read fails -> DiffError blocks creation")

=== audit_log summary (sanitized: ts/tool/status/user only — no tokens) ===
  2026-08-14T16:46:40.226Z  changeset.approve        status=ok  user=lance.chien@kkday.com
  2026-08-14T16:46:40.854Z  changeset.execute        status=ok  user=lance.chien@kkday.com
  2026-08-14T16:46:41.564Z  changeset.approve        status=ok  user=lance.chien@kkday.com
  2026-08-14T16:46:41.961Z  changeset.execute        status=ok  user=lance.chien@kkday.com

RESULT=SHELF_SCHEDULE_LIVE_OK
RESULT=INVENTORY_PLATFORM_DIFF_BLOCKED_AS_EXPECTED (see docs/be2-mcp/sit-write-contracts.md)
```

**結論（歷史紀錄）**：

- **`shelf_schedule`：全鏈路 live 驗收通過（`RESULT=SHELF_SCHEDULE_LIVE_OK`）。** 建 change-set → 批准 → 執行（真 200）→ 讀回驗證排程已寫入 → 建第二個 change-set 還原 → 批准 → 執行 → 讀回驗證已還原成原始狀態（空佇列）。全程未使用任何模擬/mock，直打 SIT be2-220 gateway；商品 34133 現況在測試前後一致（可逆性成立）。
- **`inventory_platform`：如預期在建立階段被 `DiffError` fail-closed 擋下（歷史狀態，已於 2026-08-15 解決）。** 這不是程式缺陷——寫入契約本身已 live 實證可用（design spec §2.1），純粹是這個帳號在 be2-220 對 `GET items/{itemOid}/configs` 這個現況讀取端點沒有 verify 授權（與 Phase 3a 庫存數量寫入的 `AU9403` 同一類卡點）。該卡點已於 2026-08-15 改走 `basic-info` 讀取並成功完成真人 e2e 驗證。

---

## Live 驗收結果（2026-08-15，真人透過 Claude Desktop 批次精靈面板，對 SIT be2-220，`.env` 帳號 `lance.chien@kkday.com`，商品 34133）

於 2026-08-15，由人類測試員透過真實的 Claude Desktop 精靈面板，在 SIT 環境 be2-220 上完成了 e2e 完整鏈路驗證，兩個 action_types 的全鏈路讀寫、驗證與取消流程皆全數通過：

### 1. `shelf_schedule` (排程上下架流程)
- **測試方案**：`pkg_oid=1936562` (Paul Frank 30 雙人暢遊券)
- **操作步驟**：
  1. 呼叫批次精靈，於選擇步驟勾選方案，設定排程時間。
  2. 進入檢視步驟確認 diff，面板提示「原排程將被整組取代」。
  3. 面板批准並執行成功（200）。
  4. 面板結果頁面自動啟動讀回驗證，顯示 ✓ 狀態。
  5. 啟用「取消排程 (clear queue)」模式（時間輸入禁用），再次提交批准與執行，成功清除該方案的排程佇列，再次讀回驗證 (✓)。

### 2. `inventory_platform` (庫存管理平台切換流程)
- **測試方案**：`pkg_oid=1936562` (包含其所屬的 `item_oid=1682339` 與預設供應商 `supplier_oid=38028`)
- **操作步驟**：
  1. 透過 `basic-info` 讀取現況：`is_external_inventory: false`, `is_inventory_mgmt: false` (即 `BE2` 平台)。
  2. 精靈面板選擇步驟自動連動所有共用該 item 的方案，展示細節列。
  3. 將平台切換至 `BE2_SCM`，提交建立 change-set 並於檢視步驟確認 diff：`BE2` → `BE2_SCM`。
  4. 面板批准執行，成功完成寫入（200）。
  5. 執行後自動讀回驗證成功，明細顯示 ✓ 狀態。
  6. 為保持測試前後一致，隨即在面板中發起還原 change-set，將平台切回 `BE2`，執行成功且讀回驗證無誤。
- **結論**：
  - `GET /product/api/v1/items/{itemOid}/basic-info` 成功克服了先前 S2S 讀取的 403 授權卡點，使用 user token 即可取得 200 平台現況。
  - `inventory_platform` 與 `shelf_schedule` 兩個 action_type 均取得 100% 讀寫與可逆性驗證成功。

---

## Chrome 開發預覽（dev only）

可以透過真實的 Chrome 開發面板，而非必須使用 Claude Desktop 進行開發迭代。

1. 設定環境變數啟動專案：`APP_DEV_PANEL=1 npm run dev`
2. 使用瀏覽器打開：`http://127.0.0.1:8787/dev/panel/batch-wizard?action_type=shelf_schedule&prod_oids=34133`
3. 迭代流程：修改 `src/ui/` 下的檔案後，執行 `npm run build:ui` 並重整網頁即可生效。

**安全態勢（Security Posture）**：
- **預設關閉**：未設置 flag 時相關路由與注入皆不存在（404）。
- **僅限本機**：只支援在 local loopback（127.0.0.1）開發測試。
- **嚴禁 Prod 啟用**：開啟此 flag 會繞過對 agent 的 nonce 安全隔離，因為 panel 將能直接存取身分授權。絕對不可在 Production 啟用。
