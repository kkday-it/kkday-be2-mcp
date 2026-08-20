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

### 塊 C — 商品公告進 wizard 【建議第一塊】
- **契約**：`docs/be2-mcp/sit-announcement-contract.md`（§6 list row + create 必填欄位；envelope `metadata.status "0000"`；header `x-api-key`(已在 `.env` `SIT_ANNOUNCE_API_KEY`) + `user-uuid`=JWT platformId）。
- **做什麼**：仿 `module-onboarding.md` 建 `announcement` module（svc-b2c 域，非 product 形狀——正好驗 `ActionModule` 介面通用性）；接 wizard 分頁；**生效時間走原生 `startTime`/`endTime` 欄位，不碰 B**。
- **阻擋**：executor live 寫入卡 svc-b2c 的 **S2S token 403**（`sit-announcement-contract.md` §5）——可 build + 到 draft/staging；live 200 待授權釐清。**POST wire body 確切格式**待一次真 create 攔（list row + create 欄位已足以產 schema/renderer）。
- **驗收**：不碰 core（module-onboarding 標準）；wizard 分頁能選商品→填公告→批准。

### 塊 A — 庫存數量進 wizard（即時版）
- **契約**：`docs/be2-mcp/sit-write-contracts.md` §inventory（2026-08-19/20）——讀 `POST inventories/search`、寫 `PUT inventories/{supplierOid}/quantity` body `{inventory_data:{remain_qty,modify_type},modify_user}`；讀取形狀矩陣（item/sku × 有無日期層 × fullday/場次，值可 null）；**parser 不鎖死原則**（不同商品類型變體，defensive）。
- **做什麼**：`inventory_setting` module 已在——補 wizard 分頁 + `batchView` + `appTools` enum；**SET 模式（覆寫 fullday）先做**，adjust/依日期後續。
- **阻擋**：`quantity` PUT 卡 **AU9403**（User Token per-URI verify 缺 action；stage key 申請中）——可 build，live 200 待授權 grant 或 stage。
- **注意**：Phase 3a 的 `inventoryShape.ts` 容錯欄位與真實形狀不符，**A 順手做 FINALIZE**（改主形狀 `data[itemOid|skuOid].fullday`、讀取改 POST search）。

### 塊 B — 排程層（庫存數量，橫切）【最難、最後】
- **第一步 probe**：be2 有無原生庫存排程端點?（手冊推論無；需實證——找 be2-web 庫存頁有無「排程/預約」入口、或問 product team）。
- **若無 → server 端排程器設計**：
  - be2-mcp server 內網常駐 → **比原版 Mac-app 可靠**（不需「Mac 醒著」）。
  - **時區一級需求**：排程時間存 UTC、換算 be2 日期邊界（截圖 GMT+9）不可錯。
  - **授權/nonce 模型（關鍵設計題）**：change-set 目前「批准即時執行」。排程 = 批准當下鎖定（消耗 nonce），**執行延到時間 T**。**Option 1 token store 讓這可行**——server 端持有並自動 refresh be2 token，到 T 用 store 內 token 執行（見 `be2-mcp-auth-design.md`）。要新增 change-set 狀態如 `scheduled`，server scheduler 到點撿起執行。
  - **多實例**：需 leader election / 分散式鎖，避免重複派送（連動 `deploy-architecture.md` §1.5 的 Redis）。
  - **client-side 退路**：若堅持原版「Mac 醒著才送」語意，則面板/Desktop 開著才 dispatch——不可靠，僅備選。
- **依賴**：deploy §1.5——server 端排程是唯一會新增「server 常駐排程」的功能（目前只有 oauth-purge cron）。

---

## 5. 相關文件 / memory（新 session 先讀）
- 契約：`sit-announcement-contract.md`、`sit-write-contracts.md`（§inventory）、`sit-price-contract.md`
- 官方手冊（高價值）：memory `product-team-docs-manual`（`12-庫存設定.md` / `04-成本售價.md` …）
- module 上車：`module-onboarding.md`、`module-catalog.md`
- 部署相依：`deploy-architecture.md`（§1.5 肚子裡要什麼）
- 現有 BAA/wizard：`phase4a-runbook.md`、`mcp-apps-runbook.md`
- 全域阻擋：寫入 live 200 皆卡授權（AU9403 庫存 / svc-b2c 403 公告 / stage key 申請中）——**建功能不阻擋，live 驗收才需要**。
