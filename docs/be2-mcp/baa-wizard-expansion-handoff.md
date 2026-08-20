# BAA Wizard 域擴充 — 總覽 handoff（新 session 一塊一塊做）

> 產出自 brainstorming（2026-08-20）。**這不是 spec，是拆解 + 每塊的接力包。** 每一塊各自跑完整主管線：brainstorming → spec（`docs/superpowers/specs/`）→ agy-peer-review → writing-plans → agy → subagent-driven + TDD。
> 目標：把既有**獨立版 BAA** 的能力補進 mcp_poc 的 `be2_open_batch_wizard`：**庫存數量（+排程）**、**商品公告**。

---

## 0. 北極星原則（已與使用者定案，勿再爭）

1. **wizard 只是 UX 友善層；實際靠底層 action_type / 能力本身運作。** 任何功能先確保底層（module + change-set + executor）成立，wizard 只是把它包成好操作的面板。
2. **排程：先看 be2 backend 有無原生排程。** 有 → MCP 收到批准後把排程請求送出、backend 到點執行；無 → 只能在 be2-mcp server 端到點送，且**時區不能失誤（一級需求）**。
3. 每塊獨立 spec/plan/實作、**開新 session 做**（context 隔離）。

---

## 1. 現況錨點（2026-08-20，分支 `feat/bundle-followup`）

- `be2_open_batch_wizard` 現有 action_type：**只有 `inventory_platform` + `shelf_schedule`**（`src/tools/appTools.ts` enum、`src/tools/batchView.ts`、`src/ui/batch-wizard.ts`）。
- **module 化已完成**：core registry（`src/core/changeset/{module,registry}.ts`）+ 每 action_type 一包（`src/modules/product/*`）。加新 action_type 照 `docs/be2-mcp/module-onboarding.md`。
- `inventory_setting` module **已存在**（Phase 3a，`src/modules/product/inventorySetting/`），但**沒接進 wizard**。
- `announcement`：**還沒有 module**；欄位 gate 已解（見契約）。
- **排程層：repo 完全沒有。**

---

## 2. 決策：3 塊，切成 2 條正交軌（seam 不同、可並行）

| 軌 | 塊 | 內容 | seam（動哪些檔） |
|---|---|---|---|
| **X：action_type 進 wizard** | **A** | 庫存數量（`inventory_setting`，**即時版先做、不含排程**） | module + wizard UI（batchView / appTools enum / batch-wizard.ts） |
| | **C** | 商品公告（新 module + wizard） | 同上 |
| **Y：排程層（橫切，只為庫存數量）** | **B** | 到點派送 | change-set 執行/排程層（+ server 排程器） |

X 與 Y 動的檔不同 → **可真並行**；唯一交會點是 wizard 的 action_type enum + `batch-wizard.ts`，merge 協調即可。

### 原生排程分類（B 原則的落地，關鍵）
| 域 | backend 原生排程? | 對 B 的意義 |
|---|---|---|
| 上下架 | ✅ `reserve_queue` / `reserve-active`（`shelf_schedule` 已用） | 不需 B |
| **商品公告** | ✅ 生效時間是 **`Start Time`/`End Time` 資料欄位**（create 表單自帶） | **不需 B**；設欄位即可 |
| **庫存數量** | 🔴 疑似**無**（手冊端點只有即時 `quantity` PUT + async，無 reserve/schedule 變體）→ **B 第一步必須 probe 實證** | **B 只為此域而生** |

→ 結論：**B（自建排程）實際上只服務「庫存數量」**。

---

## 3. 執行順序建議

1. **C 商品公告進 wizard**（最乾淨：契約剛備、無排程難題、原生 startTime/endTime）
2. **A 庫存數量進 wizard（即時版）**
3. **B 排程層**（以 probe 開頭）

（A、C 同屬軌 X 同一機械模式，也可並行；B 獨立、probe 先行。）

---

## 4. 每塊接力包

### 塊 C — 商品公告進 wizard 【✅ 已完成 2026-08-20，Session 1】
> **DONE**：spec + plan 皆 agy-approved（各 rounds=2），13 tasks TDD 全綠（`feat/bundle-followup` 上 `daa36ae..HEAD` 13 commits）。`npm run ci` **560 passed / 0 skipped**、typecheck clean、build:ui 4 面板、dev `/healthz` 200。final whole-branch review（agy/Gemini）**READY TO MERGE**（1 Critical 已修：`makeAnnouncementClient()` 無 key 時同步 throw 會擋 staging/crash 執行 → 改 try/catch 降級）。
> 產出：`announcement` module（首個非 product domain，`src/modules/announcement/create/*`）+ module-local svc-b2c client（不碰 core GatewayClient）+ 獨立入口 `be2_open_announcement_wizard` + `announcement-wizard.html` 專用建立表單面板。**不碰 core DoD 達標**（core/changeset 僅 `types.ts` union）。首發=create 全欄位、生效走原生 startTime/endTime、無排程。
> **未竟（非阻擋）**：live 寫入卡 svc-b2c S2S 403（build+draft 可，live 200 待授權）；POST wire body 為 §6.2 best-guess（UNVERIFIED，待一次真 create 攔）。
> **Session 2 協調**：本塊走 sibling 面板、**完全沒碰** `batch-wizard.ts`/`batchView.ts`/`openBatchWizard.ts`（Session 2 主戰場）；唯一共用 `types.ts`（不同行、可自動 merge）、`src/modules/index.ts`/`src/server/app.ts`/`appResources.ts`/`devPanelRoutes.ts` 行級小衝突人工對齊。
> **merge 待使用者拍板**。

### 塊 C — 商品公告進 wizard（原接力包，留存）
- **契約**：`docs/be2-mcp/sit-announcement-contract.md`（§6 list row + create 必填欄位；envelope `metadata.status "0000"`；header `x-api-key`(已在 `.env` `SIT_ANNOUNCE_API_KEY`) + `user-uuid`=JWT platformId）。
- **做什麼**：仿 `module-onboarding.md` 建 `announcement` module（svc-b2c 域，非 product 形狀——正好驗 `ActionModule` 介面通用性）；接 wizard 分頁；**生效時間走原生 `startTime`/`endTime` 欄位，不碰 B**。
- **阻擋**：executor live 寫入卡 svc-b2c 的 **S2S token 403**（`sit-announcement-contract.md` §5）——可 build + 到 draft/staging；live 200 待授權釐清。**POST wire body 確切格式**待一次真 create 攔（list row + create 欄位已足以產 schema/renderer）。
- **驗收**：不碰 core（module-onboarding 標準）；wizard 分頁能選商品→填公告→批准。

### 塊 A — 庫存數量進 wizard（即時版）
- **契約**：`docs/be2-mcp/sit-write-contracts.md` §inventory（2026-08-19/20）——讀 `POST inventories/search`、寫 `PUT inventories/{supplierOid}/quantity` body `{inventory_data:{remain_qty,modify_type},modify_user}`；讀取形狀矩陣（item/sku × 有無日期層 × fullday/場次，值可 null）；**parser 不鎖死原則**（不同商品類型變體，defensive）。
- **做什麼**：`inventory_setting` module 已在——補 wizard 分頁 + `batchView` + `appTools` enum；**SET 模式（覆寫 fullday）先做**，adjust/依日期後續。
- **阻擋**：`quantity` PUT 卡 **AU9403**（User Token per-URI verify 缺 action；stage key 申請中）——可 build，live 200 待授權 grant 或 stage。
- **注意**：Phase 3a 的 `inventoryShape.ts` 容錯欄位與真實形狀不符，**A 順手做 FINALIZE**（改主形狀 `data[itemOid|skuOid].fullday`、讀取改 POST search）。

### 塊 B — 排程層（庫存數量，橫切）【✅ 已完成 2026-08-20，Session 3】
> **DONE**：probe 實證 be2 無庫存原生排程（`probe-inventory-native-schedule.md`）→ spec/plan 皆 agy APPROVED（各 rounds=4）→ 10 tasks TDD 全綠（`feat/bundle-followup` 上 `37300b8..63a1745` 18 commits）。`npm run ci` **607 passed / 0 skipped**、tsc clean、build:ui 綠、dev healthz 200（scheduler 啟動）。final whole-branch review **READY TO MERGE**（0 Critical；3 Important + 4 Minor 全數即修：purge claimed-approved 窗、stranded-executing 啟動 audit、schedule.wall model 文件、keep-alive 連坐 audit 歸屬、tz 標籤去硬編、eval 判準對齊 runner）。
> 產出：core 泛用排程（`ChangeSetStatus` +scheduled/cancelled/missed、`src/core/schedule/{tz,policy,scheduler}.ts`、TokenManager `getFreshByIdentityId`/`keepAlive`、identityId 貫穿兩通道、時間回聲 TOCTOU、executor CAS exactly-once、取消雙通道、purge 保護）+ `schedulable` opt-in（僅 inventory_setting）+ wizard 排程輸入/scheduled ledger/取消按鈕。多實例全靠 DB CAS，**不新增 Redis 依賴**（deploy §1.5 已回改）。
> **未竟（非阻擋）**：live 排程 e2e 待寫入授權（SIT AU9403 / stage grant）解鎖後做（spec §11：SIT 建 5 分鐘後排程→到點自動執行→讀回）。**merge 待使用者拍板**（PR #19）。

### 塊 B — 排程層（原接力包，留存）
- **第一步 probe**：be2 有無原生庫存排程端點?（手冊推論無；需實證——找 be2-web 庫存頁有無「排程/預約」入口、或問 product team）。
- **若無 → server 端排程器設計**：
  - be2-mcp server 內網常駐 → **比原版 Mac-app 可靠**（不需「Mac 醒著」）。
  - **時區一級需求**：排程時間存 UTC、換算 be2 日期邊界（截圖 GMT+9）不可錯。
  - **授權/nonce 模型（關鍵設計題）**：change-set 目前「批准即時執行」。排程 = 批准當下鎖定（消耗 nonce），**執行延到時間 T**。**Option 1 token store 讓這可行**——server 端持有並自動 refresh be2 token，到 T 用 store 內 token 執行（見 `be2-mcp-auth-design.md`）。要新增 change-set 狀態如 `scheduled`，server scheduler 到點撿起執行。
  - **多實例**：需 leader election / 分散式鎖，避免重複派送（連動 `deploy-architecture.md` §1.5 的 Redis）。
  - **client-side 退路**：若堅持原版「Mac 醒著才送」語意，則面板/Desktop 開著才 dispatch——不可靠，僅備選。
- **依賴**：deploy §1.5——server 端排程是唯一會新增「server 常駐排程」的功能（目前只有 oauth-purge cron）。

---

## 4.5 Session 分配 + 每個 session 的開頭資訊（貼給新 session）

**依賴關係決定切法**：C 完全獨立；**A→B 耦合**（B 排的就是 A 的庫存寫入）。故不按 §2 的 X/Y，而按依賴切成 2 個可並行的 session：

### Session 1 —「塊 C：商品公告進 wizard」（獨立，可先跑）
開頭貼這段：
> 目標：把「商品公告」接成 `be2_open_batch_wizard` 的新 action_type。先讀 `docs/be2-mcp/baa-wizard-expansion-handoff.md`（全文，尤其「塊 C」段）+ `docs/be2-mcp/sit-announcement-contract.md`（§6 契約）+ `docs/be2-mcp/module-onboarding.md`（上車 checklist）。照 CLAUDE.md 主管線走：brainstorming → spec（`docs/superpowers/specs/`）→ agy-peer-review → writing-plans → agy → subagent-driven + TDD。北極星：wizard 只是 UX、能力靠底層；公告生效時間走**原生 `startTime`/`endTime` 欄位、不做排程**。阻擋：executor live 寫入卡 svc-b2c S2S 403（build+draft 可，live 待授權）——不阻擋開發。實作外包 agy（見 memory `agy-work-allocation`）。⚠️ 會動到 wizard 的 action_type enum（`src/tools/appTools.ts`/`batchView.ts`/`src/ui/batch-wizard.ts`）——與 Session 2 的交會點，merge 前先同步。

### Session 2 —「塊 A→B：庫存數量進 wizard（即時）→ 排程層」
開頭貼這段：
> 目標：(A) 把庫存數量（`inventory_setting`，SET/fullday）接成 `be2_open_batch_wizard` 的 action_type（即時版先做）；(B) 再疊上「到點派送」排程層。先讀 `docs/be2-mcp/baa-wizard-expansion-handoff.md`（全文，「塊 A」「塊 B」段）+ `docs/be2-mcp/sit-write-contracts.md`（§inventory：讀取形狀矩陣、寫入 body、**不鎖死 parser 原則**）+ `docs/be2-mcp/module-onboarding.md`。**先做 A 完整跑完（brainstorming→spec→agy→plan→subagent+TDD）再開 B**。A 順手做 Phase 3a `inventoryShape.ts` FINALIZE（改主形狀 `data[itemOid|skuOid].fullday`、讀取改 `POST inventories/search`）。B 第一步 probe「be2 有無原生庫存排程」→ 無則 server 端 timezone-safe 排程器（**時區一級需求**）+ 延遲執行授權模型（Option 1 token store 使可行，見 handoff「塊 B」）。阻擋：quantity PUT 卡 AU9403 + stage key 待正確（見 memory `be2-mcp-phase3-plan`）——build 可、live 待授權。實作外包 agy。⚠️ wizard action_type enum 是與 Session 1 的交會點。

**協調唯一衝突點**：兩個 session 都會加 wizard 的 `action_type` enum + `batch-wizard.ts` 分頁。建議：誰先到誰先加，另一個 rebase；或各自分支、合併時人工對齊那一處。

## 5. 相關文件 / memory（新 session 先讀）
- 契約：`sit-announcement-contract.md`、`sit-write-contracts.md`（§inventory）、`sit-price-contract.md`
- 官方手冊（高價值）：memory `product-team-docs-manual`（`12-庫存設定.md` / `04-成本售價.md` …）
- module 上車：`module-onboarding.md`、`module-catalog.md`
- 部署相依：`deploy-architecture.md`（§1.5 肚子裡要什麼）
- 現有 BAA/wizard：`phase4a-runbook.md`、`mcp-apps-runbook.md`
- 全域阻擋：寫入 live 200 皆卡授權（AU9403 庫存 / svc-b2c 403 公告 / stage key 申請中）——**建功能不阻擋，live 驗收才需要**。
