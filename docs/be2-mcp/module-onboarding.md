# be2 MCP 模組上車指南 (Module Onboarding)

將新的 `action_type` 接入 be2 MCP 時，請遵循以下檢查清單。
**驗收標準：新增 module 過程「完全不需要修改 core 目錄裡的任何基礎設施」。**

## 1. 外部依賴與合約確認
- [ ] **取得可寫帳號與環境**：必須有一個在該 domain 有寫入權限的測試帳號（通常為 SIT 環境）。
- [ ] **確認 BusinessList 動作碼**：找出執行該動作所需的確切權限碼。
- [ ] **Contract Probe (合約探勘)**：實測 API 端點的行為，確認：
  - 必填欄位
  - Merge vs Replace 語義
  - `modify_user` 來源
  - 動作的可逆性
  - *詳見 [`sit-write-contracts.md`](./sit-write-contracts.md) 中的慣例與記錄。*

## 2. 建立 Module 實作包
在 `src/modules/<domain>/<action>/` 目錄下建立一包模組代碼：
- [ ] **`keys.ts`**: 定義 itemKey 產生器（注意：必須是 Isomorphic，不能依賴 Node 專用模組，因為 UI 也會共用）。
- [ ] **`validate.ts`**: 實作 Schema 與商業邏輯驗證。
- [ ] **`diff.ts`**: 實作 `computeDiff`（抓現況並與 target 比較）。
- [ ] **`executor.ts`**: 實作 read-merge-write 與 API 呼叫（根據需求實作序列、批次或分組）。
- [ ] **`renderer.ts`**: 實作 `renderConfirm`，定義確認頁的 HTML 與警告。
- [ ] **`ui.ts` (選配)**: 若為 Batch 型態可加入此檔，實作面板 UI（注意 Isomorphic 限制）。
- [ ] **`module.ts`**: 將上述拼裝為 `ActionModule`。需填寫欄位：
  - `actionType`
  - `itemSchema`
  - `authz` (codes, onMissing)
  - `invalidItemsMessage`
  - `scopeNotReadMessage`
  - `isItem`
  - `scopeOids`, `scopeErrorKey`
  - `validate`, `computeDiff`, `diffVersion`, `itemKey`, `execute`, `renderConfirm`
  - `schedulable?: boolean`（選配,預設不填=不接 core 排程層):宣告本 action_type 是否允許 change-set 帶 `schedule`(到點派送,塊 B)。**有原生排程欄位的 domain 一律不開**(上下架走 reserve_queue、公告走 startTime/endTime);只有像庫存數量這種 backend 無原生排程的域才開。開了之後 wizard 描述子(`ui.ts` 的 `WizardDescriptor.schedulable`)可同步標記讓面板長出排程輸入。

## 3. 註冊 Module
- [ ] 在 `src/modules/index.ts` 內匯入並呼叫 `registerModule(...)` 註冊該模組（import 副作用註冊）。
- [ ] 在 `src/core/changeset/types.ts` 中的 Union Types (如 `ActionType`, `AnyChangeSetItem`, `AnyDiffItem`) 擴充新模組的型別。

## 4. 測試撰寫
- [ ] **Conformance 自動繼承**：在 `tests/core/moduleConformance.test.ts` 加入新模組的 diff 樣本，自動繼承基礎契約驗證。
- [ ] **Per-type 測試檔**：慣例上需要另外建立：
  - `<action>Diff.test.ts`
  - `<action>Executor.test.ts`
  - `confirmRoutes.test.ts` (補上對應路徑的 UI 測試)

## 5. Eval 與安全測試
- [ ] **Eval 案例**：在 eval 資料夾中加入針對新 module 的測試情境。
- [ ] **安全測試**：驗證：
  - Draft-only (變更集草稿不直接寫入)
  - Scope-gate (未讀取的資料不允許寫入)
  - 注入攻擊防護

## 6. 登錄 Catalog
- [ ] 最後，將模組資訊登記到 [`module-catalog.md`](./module-catalog.md) 的 5 條目表中。
