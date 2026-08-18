# Module Factory — 多 agent 自動化「新增 MCP 功能模組」設計

日期：2026-08-18　狀態：待 agy review
> 目標：把「擴展一個新 action_type」從人工工程（現在手動碰 7+ 檔、派 agy 多輪）變成**可複製、可稽核的三段闘關流程**。這是 Phase 5 模組化「domain-onboarding 自動收納流程」的完全體。
> 搭配讀：`docs/be2-mcp/module-onboarding.md`（要自動化的人工 checklist）、`docs/be2-mcp/module-catalog.md`（產物登記處）、`docs/be2-mcp/sit-announcement-contract.md`（段① 產物已存在的真實範本）、`docs/superpowers/specs/2026-08-16-be2-mcp-modularization-design.md`（ActionModule 介面，factory 產出的目標形狀）。

## 1. 目標與非目標

**目標**：給定 repo／設計文件（如 `ENDPOINTS.md`）+ 一個標的 `action_type` 名 → factory 自動探索契約、產出一包 `ActionModule`（schema/diff/executor/renderer/ui/keys + 單元測試 + e2e + error handling），開成 draft PR。人只在三個 gate 介入。

**首發標的**：商品公告（product announcement）——全新 domain，非 product 形狀（不同 host svc-b2c、不同 envelope `metadata.status '0000'`、額外 header），最能驗證 `ActionModule` 介面的通用性。段① 契約探索已完成（`sit-announcement-contract.md`）。

**Non-goals（明確不做）**：
- 不做「零人工全自動到 merge」——契約黑箱（如 svc-b2c 的 S2S-token-403）必須 gate 給人，盲寫違反主 spec 鐵則。
- 不改 core 治理層——factory 產出的 module 走既有 registry，不碰 `src/core/`（= module-onboarding 的驗收標準）。
- 不做背景 Workflow 版本——三段之間要停下來問人，背景執行問不了人（見 §5 載體決策）。
- 首發只跑商品公告一個標的；其他標的（庫存數量新路徑、bundle 上下架）留作 factory 第二/三次跑的驗證，不在本 spec。

## 2. 三段闘關流程（本 spec 核心）

```
段① 探索（Claude 跑）
  輸入：設計文件（ENDPOINTS.md）+ 標的 action_type 名
  並行 agent：
    - endpoint-prober   : curl/playwright 攔真實請求 → host/path/header/envelope
    - bundle-miner      : 前端 bundle 逆向 → businessList 授權碼
    - reference-reader  : 讀現有 4 個 module → 判定「最像哪個」當形狀範本
  產物：契約報告（sit-<domain>-contract.md，格式見既有範本）
  ┌─ GATE 1（人，AskUserQuestion）：報告有無「未解 gate 項」？
  │    有真黑箱 → 該格（通常是 executor）標 PENDING，其餘格照產
  └─ 進段②

段② 產（六格並行 + 對抗驗證，方案 A 引擎）
  六格 agent（agy 並行 accept-edits，Claude 編排）：
    keys / schema+validate / diff / executor / renderer / ui
    每格規格 = 契約報告 + reference-reader 指定的「最像現成 module 的同名格」
    tests 隨每格附（該格的單元測試）
  → conformance-verifier（Claude subagent，對抗式）：
    跑 conformance harness + 逐格「這格會不會騙過測試/有無互斥性 bug」
  產物：src/modules/<domain>/<action>/ 一包 + tests
  ┌─ GATE 2（人）：Claude 攤六格 diff + conformance 結果，人點頭
  └─ 進段③

段③ 驗收（Claude 編排）
  npm run ci 全綠 → build-ui → registry exhaustive 測試 → dev panel e2e（playwright 驅動）
  → error-handling agent：補 403/500/stale/併發 的 executor 分支測試
  產物：draft PR（含契約報告、六格產物、e2e 紀錄）
  ┌─ GATE 3（人）：merge 決定 + live 寫入驗收（GATE 1 有 executor gate 則標 PENDING）
  └─ 完成
```

### 2.1 兩個關鍵設計決策

1. **GATE 1 是「該格的條件 gate」，非整個 factory 的 stop**：像 announcement 的 S2S-403，段② 的 keys/schema/diff/renderer/ui 五格照產（契約足夠），只有 executor 格標 `PENDING: 待授權確認`。符合「3a/3b 契約待驗下仍先做完非寫入面」的先例。factory 不因單一授權黑箱全停。

2. **每格 agent 的規格 = 契約報告 + 最像的現成同名格**：executor 格吃契約報告 + 例如 `shelfSchedule/executor.ts` 當形狀範本——「照最像的現成格改」而非憑空產。品質可控、天然繼承既有錯誤處理慣例（read-merge-write、per-item mutex、status 聚合等）。reference-reader 在段① 就選定範本，寫進契約報告。

## 3. 段② 引擎：方案 A（六格並行 + 對抗驗證）

為何並行而非 pipeline：`ActionModule` 介面本就為「各格獨立可測」設計（conformance harness 已存在），六格之間只透過介面契約耦合、無執行期依賴 → 可並行產出。取捨紀錄：
- 方案 B（pipeline 逐格串接）：依賴清楚但序列慢，executor 卡住整條停，未發揮解耦紅利——不採。
- 方案 C（整包一個 agent + review）：最省編排但單 agent 扛整包 context、品質不穩、複製性差——不採。

**對抗驗證**複用既有「adversarial verify」模式：把歷次模組化 review 反覆抓的 bug 類型（hash 恆定、itemKey 撞號、diff fall-through、per-type 判別不一致）變成 conformance-verifier 的固定檢查清單。這步是 factory 品質的核心保障，非可選。

## 4. 載體與分工

Factory = repo skill `.claude/skills/module-factory/`。主對話照 SKILL.md 逐段執行，三個 gate 用 `AskUserQuestion` 在對話裡問人。

```
.claude/skills/module-factory/
  SKILL.md                          三段 + 三 gate 的執行順序、gate 判定準則
  references/
    stage1-explore.md               三個探索 agent 的 prompt 模板 + 契約報告格式
    stage2-produce.md               六格 agent 的 prompt 模板（各註明參考哪個現成格）
    stage3-verify.md                ci/build-ui/dev-panel-e2e/PR 驗收步驟
    contract-report-template.md     = sit-announcement-contract.md 骨架
```

**每段誰跑（依 memory `agy-work-allocation`）：**

| 段 | 動作 | 執行者 | 理由 |
|---|---|---|---|
| ① | curl/playwright 攔契約、bundle 逆向 | **Claude** | agy 跑不了 shell/瀏覽器（實證多次） |
| ① | 寫契約報告 | **Claude** | agy 純寫作屢次零產出，Claude 直接寫更快 |
| ② | 六格 module 實作 | **agy 並行**（六個 accept-edits），Claude 編排 | 實作類省 Claude 額度；六格獨立可平行 |
| ② | conformance 對抗驗證 | **Claude subagent** | 需跨檔判斷 + 跑測試，agy 做不了 |
| ③ | ci/e2e/PR | **Claude** | 測試、playwright、git 都要 shell |

**agy 零產出的對策固化進 skill**：stage2 的 agy prompt 模板內建禁令段（只有唯讀 shell、檔案用內建編輯工具、產物路徑明確、prompt 不用「先 grep」這類誘導跑 shell 的動詞），並註明「agy 連兩次零產出 → 該格改由 Claude 接手」。把本專案反覆踩到的 agy headless 限制寫成流程的一部分。

## 5. 載體決策：為何 repo skill 而非 Workflow

三段之間要停下來問人（gate）。Claude Code 的 Workflow 是背景執行、中途無法 `AskUserQuestion`——選它就得把三段拆成三次 Workflow 呼叫、gate 在呼叫之間，反而更碎。且 agy 接不進 Workflow 的 agent()（Workflow 只跑 Claude subagent，吃 Claude 額度）。repo skill + 段內派 agy 既保留 gate 的互動性、又用 agy 省額度，與現行工作方式一致。

## 6. 首發驗證：商品公告

skill 寫完後立刻拿商品公告當第一個真實案例跑完整三段——既驗 factory 能動，產出的 announcement module 也是真交付物：
- 段①：已完成（`sit-announcement-contract.md`），含 GATE 1 的真黑箱（S2S-token-403）。
- 段②：keys/schema/diff/renderer/ui 五格照產，executor 標 `PENDING: 待 svc-b2c 授權`。
- 段③：ci/conformance 綠 + dev panel e2e（讀取面）；live 寫入標 PENDING（同 3a 庫存狀態）。
- 產物登記進 `module-catalog.md`。

**成功定義**：announcement module 註冊進 registry、conformance harness 自動繼承通過、`npm run ci` 全綠、非寫入面 dev panel e2e 通過、GATE 1/2/3 各觸發一次且人可介入。

## 7. 風險與對策

| 風險 | 對策 |
|---|---|
| 六格 agent 產出介面不一致（如 itemKey 兩處判別法不同——模組化時的老 bug） | conformance-verifier 固定檢查「itemKey server/ui 同源」；每格規格強制引用同一份 keys.ts |
| 契約探索猜錯（盲寫容錯路徑，3a 教訓） | GATE 1 硬性：報告有未解項即該格 PENDING，不容錯猜寫 |
| agy 段② 零產出拖慢 | prompt 模板內建禁令；兩次零產出 Claude 接手（§4） |
| factory 產出繞過 core 治理（安全洞） | 產出只能落 `src/modules/<domain>/`，SKILL.md 明令不碰 `src/core/`；段③ ci 含既有 draft-only/scope-binding 回歸 |
| 首發標的授權黑箱使 executor 無法 live 驗 | 接受 PENDING（與 3a/announcement 同狀態）；factory 的價值在自動化「產」與「驗非寫入面」，live 寫入本就受外部授權限制 |
