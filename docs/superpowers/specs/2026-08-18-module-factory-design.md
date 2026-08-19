# Module Factory — 多 agent 自動化「新增 MCP 功能模組」設計

日期：2026-08-18　狀態：agy APPROVED（rounds=3）
> 目標：把「擴展一個新 action_type」從人工工程（現在手動碰 7+ 檔、派 agy 多輪）變成**可複製、可稽核的三段闘關流程**。這是 Phase 5 模組化「domain-onboarding 自動收納流程」的完全體。
> 搭配讀：`docs/be2-mcp/module-onboarding.md`（要自動化的人工 checklist）、`docs/be2-mcp/module-catalog.md`（產物登記處）、`docs/be2-mcp/sit-announcement-contract.md`（段① 產物已存在的真實範本）、`docs/superpowers/specs/2026-08-16-be2-mcp-modularization-design.md`（ActionModule 介面，factory 產出的目標形狀）。

## 1. 目標與非目標

**目標**：給定 repo／設計文件（如 `ENDPOINTS.md`）+ 一個標的 `action_type` 名 → factory 自動探索契約、產出一包 `ActionModule`（schema/diff/executor/renderer/ui/keys + 單元測試 + e2e + error handling），開成 draft PR。人只在三個 gate 介入。

**輸入文件（`ENDPOINTS.md`）不是 repo 檔**：它是 factory **每次跑時由使用者提供的外部設計文件**（首發那份在 `~/Downloads/ENDPOINTS.md`）。段① 第一步硬性動作：把該輸入文件**複製進 repo**（`docs/be2-mcp/factory-input-<domain>.md`）當可稽核的探索起點，之後段①/② 的引用一律指 repo 內副本，不依賴 repo 外的幻影路徑。

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
  六格 agent（可插拔實作者：預設 Claude subagent，agy 為省額度選項；Claude 編排）：
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

1. **GATE 1 有兩種 gate 項，效果不同——這是 factory 正確性的核心**：
   - **(a) 授權 gate（executor-only）**：如 announcement 的 S2S-403。知道欄位、只是寫入身分過不了 → 段② 其餘格照產，**只有 executor 格**標 `PENDING: 待授權確認`（同 3a 庫存先例）。
   - **(b) 欄位 gate（block 段②）**：item 欄位形狀未知（如 announcement 探索當下 502 導致 row 結構、POST 必填欄位拿不到）→ **段② 整個 block**。理由：`itemSchema: z.ZodType<Item>` 是所有格的地基，欄位不明就寫 schema = 盲寫（違反主 spec 鐵則，3a 教訓）。factory **絕不憑空補欄位**；段② 在欄位解出前不啟動。
   - GATE 1 判定準則：契約報告的「item 欄位形狀」欄位是否已填實（從輸入文件的 payload 定義 / 攔到的 200 回應 / 參考前端型別任一來源）。填實 → 進段②；未填 → 停在 GATE 1 等人補來源（後端恢復攔 200、或人工提供欄位定義）。授權 gate 不 block 段②、欄位 gate block 段②。

2. **每格 agent 的規格 = 契約報告 + 最像的現成同名格**：executor 格吃契約報告 + 例如 `shelfSchedule/executor.ts` 當形狀範本——「照最像的現成格改」而非憑空產。品質可控、天然繼承既有錯誤處理慣例（read-merge-write、per-item mutex、status 聚合等）。reference-reader 在段① 就選定範本，寫進契約報告。

## 3. 段② 引擎：方案 A（六格並行 + 對抗驗證）

為何並行而非 pipeline：`ActionModule` 介面本就為「各格獨立可測」設計（conformance harness 已存在），六格之間只透過介面契約耦合、無執行期依賴 → 可並行產出。取捨紀錄：
- 方案 B（pipeline 逐格串接）：依賴清楚但序列慢，executor 卡住整條停，未發揮解耦紅利——不採。
- 方案 C（整包一個 agent + review）：最省編排但單 agent 扛整包 context、品質不穩、複製性差——不採。

**對抗驗證**複用既有「adversarial verify」模式：把歷次模組化 review 反覆抓的 bug 類型（hash 恆定、itemKey 撞號、diff fall-through、per-type 判別不一致）變成 conformance-verifier 的固定檢查清單。這步是 factory 品質的核心保障，非可選。

### 3.1 六格的實際編排（依後端不同，兩套機制）

「六格並行」的落地依 §4 選定的實作者後端而異——共通不變式：各格寫各自的檔（keys/module/diff/executor/renderer/ui 六個獨立檔，檔案系統無衝突）、實作期間不動 git（commit 由 Claude 全部完成後一次做，無 git lock）、keys.ts 先產（其餘五格 import 它的 itemKey，唯一序列點）。

**Claude subagent 後端（預設）的編排**：主 Claude 用 `Agent` tool 派 subagent——keys 先派一個，收齊後其餘五格於同一訊息並行派多個 `Agent`。**harness 本身就是編排機制**：subagent 的生命週期、並行、完成通知由 harness 管，主 Claude 不需在 context 裡手動輪詢（「不靠 Claude juggle」在此後端由 harness 天然滿足，非靠腳本）。失敗即一般 subagent 除錯（逾時/context 上限重派或縮小任務），非 agy 的零產出問題。

**agy 後端（省額度選項）的編排**：agy 是外部 CLI、harness 不管它的生命週期，故需一支機械腳本 `scripts/run-agy-batch.sh` 吸收「派 N 個背景 agy + wait + 檔案非空檢查 + OK/EMPTY 報告 + keys 先跑 + 冪等」的脆弱性，**不靠 Claude 在 context 裡手動 juggle agy 程序**（agy review round 2）。職責邊界：
- **腳本做**：吃 `(格名, prompt 檔, 絕對目標檔)` 清單 → 有界並行（`MAX_PARALLEL=3`）派 agy → `wait` → 逐格檢查目標檔非空 → 印 `OK`/`EMPTY`。冪等。
- **Claude 做**：讀報告 → 對 `EMPTY` 格 fallback（重派帶強化禁令；仍 EMPTY 則 Claude 親寫）→ conformance + 一次 commit。
- **為何腳本只到這**：fallback 終點是「Claude 寫該格」、段間 gate 需 `AskUserQuestion`（互動）——這兩者腳本都做不到，留給 Claude。

兩後端的差異根源：Claude subagent 是 harness 原生受管（不需腳本），agy 是外部程序（需腳本收攏其併發與零產出脆弱性）。conformance 對抗驗證與三 gate 與後端無關。

## 4. 載體與分工

Factory = repo skill `.claude/skills/module-factory/`。主對話照 SKILL.md 逐段執行，三個 gate 用 `AskUserQuestion` 在對話裡問人。

```
.claude/skills/module-factory/
  SKILL.md                          三段 + 三 gate 的執行順序、gate 判定準則
  scripts/
    run-agy-batch.sh                段② 機械編排（Claude 一行呼叫，見 §3.1）
  references/
    stage1-explore.md               三個探索 agent 的 prompt 模板 + 契約報告格式
    stage2-produce.md               六格 agent 的 prompt 模板（各註明參考哪個現成格）
    stage3-verify.md                ci/build-ui/dev-panel-e2e/PR 驗收步驟
    contract-report-template.md     = sit-announcement-contract.md 骨架
```

**每段誰跑：**

| 段 | 動作 | 執行者 | 理由 |
|---|---|---|---|
| ① | curl/playwright 攔契約、bundle 逆向 | **Claude** | 需 shell/瀏覽器 |
| ① | 寫契約報告 | **Claude** | 需 shell |
| ② | 六格 module 實作 | **可插拔實作者**（見下） | 預設 Claude subagent（通用）；agy 為省額度選項 |
| ② | conformance 對抗驗證 | **Claude subagent** | 需跨檔判斷 + 跑測試 |
| ③ | ci/e2e/PR | **Claude** | 測試、playwright、git 都要 shell |

**段② 實作者可插拔（可攜性設計）**：段② 要有人寫五六個檔，這個實作者不寫死成 agy——控制者依環境選：
- **預設 = Claude subagent**（通用、任何人可用）：每格派一個 `Agent`（general-purpose），模型按格複雜度選（keys/renderer 純轉寫用便宜模型、module/executor 整合用標準模型）。成本 Claude 額度。
- **選項 = agy**（僅當 `agy` 在 PATH + 已登入 + repo 在 trustedWorkspaces + 使用者要省 Claude 額度）：`run-agy-batch.sh` 派 agy，需下述兩前置。成本 Antigravity 額度。
- 偵測：`command -v agy` 有 + 使用者偏好省額度 → agy；否則 → Claude subagent（不確定就走 Claude subagent，可攜性優先）。memory `agy-work-allocation` 記的「外包 agy」是**特定使用者本機的省額度策略、非 factory 本質**。

**agy 段② 的兩個前置（2026-08-19 追到底、實測確認）**：agy 在 headless accept-edits 下能否寫出檔，取決於兩件事**都**成立，缺一即零產出——
1. **allowlist 有 `pwd` + 唯讀定位指令**：agy 寫檔前習慣跑 `pwd`，不在 `~/.gemini/antigravity-cli/settings.json` 白名單即 auto-deny→零產出。放行 pwd/which/dirname/basename/realpath/test/stat/date（寫入/執行/網路/憑證維持批准，不全放行）。
2. **目標檔絕對路徑 + repo 在 `trustedWorkspaces`**：headless `-p` 無 active workspace，相對路徑掉進 agy scratch（不進 repo），絕對路徑需落在 trusted workspace 才准寫。

前置備齊後 agy 段② 正常運作（實測絕對路徑 + trusted + pwd 放行後 agy 成功寫 repo）。**bundle 首發時前置未備（pwd 未放行、給相對路徑），故五格全走 Claude fallback**——這是「前置未備」而非「agy 不可用」。fallback（連兩次零產出 → Claude 接手該格）維持為次要保護路徑。這些 headless 限制與前置固化進 stage2 的 prompt 模板。

## 5. 載體決策：為何 repo skill 而非 Workflow

**主要理由（與後端無關）**：三段之間要停下來問人（gate）。Claude Code 的 Workflow 是背景執行、中途無法 `AskUserQuestion`——選它就得把三段拆成三次 Workflow 呼叫、gate 在呼叫之間，反而更碎。repo skill + 主對話逐段執行，保留 gate 的互動性。這是選 repo skill 而非 Workflow 的**核心驅動**，對 Claude subagent 與 agy 兩後端都成立。

**附帶（僅 agy 後端）**：Workflow 的 agent() 只跑 Claude subagent、吃 Claude 額度；repo skill 的段內派工可改走 agy 省額度（lance 本機優化）。這是 agy 後端的附加好處，非架構主因。

## 6. 首發驗證：商品公告

skill 寫完後立刻拿商品公告當第一個真實案例跑三段——既驗 factory 能動，產出的 announcement module 也是真交付物。**但誠實揭露：announcement 目前同時撞到 GATE 1 的兩種 gate**：
- 段①：已完成（`sit-announcement-contract.md`）。GATE 1 觸發兩項——**(a) 授權 gate**（S2S-token-403，executor-only）＋**(b) 欄位 gate**（探索當下 svc-b2c 502，row 結構與 POST 必填欄位未取得）。
- **依 §2.1 判定準則，欄位 gate 使段② 目前 block**——announcement 的 item 欄位形狀未填實，factory 不得憑空補欄位。**解 block 的來源**（任一）：後端恢復攔一次 200 回應、或從 svc-b2c 後端 repo / 前端型別定義取欄位。這是 factory 忠實執行「不盲寫」的正確行為，不是設計缺陷。
- 欄位一旦補齊：段② 六格產出（executor 因授權 gate 仍標 PENDING）→ 段③ ci/conformance/非寫入面 e2e。

**首發成功定義（分兩種認定，因 announcement 撞欄位 gate）**：
- **若 announcement 欄位在 factory 首跑前補齊** → 完整定義：module 註冊進 registry、conformance 自動繼承通過、`npm run ci` 全綠、非寫入面 dev panel e2e 通過、三 gate 各觸發且人可介入。
- **若欄位仍未補齊** → factory 正確地**停在 GATE 1 欄位 gate**、產出契約報告並如實回報 block 原因，即算 factory 機制驗證成功（證明「不盲寫、遇欄位黑箱就停」這條核心正確運作）；此時改用**已知欄位的備援標的**（bundle 上下架：同 product API、GET/PUT 都在 gateway 可達、欄位在 `package-configs` 既有形狀內）跑完整三段驗 factory 的「產」能力。備援標的僅供驗證 factory，非本 spec 承諾的交付物。

## 7. 風險與對策

| 風險 | 對策 |
|---|---|
| 六格產出介面不一致（如 itemKey 兩處判別法不同——模組化時的老 bug）（**兩後端共通**） | conformance-verifier 固定檢查「itemKey server/ui 同源」；每格規格強制引用同一份 keys.ts |
| 契約探索猜錯（盲寫容錯路徑，3a 教訓） | GATE 1 硬性分兩種：欄位未知 → block 段②（§2.1(b)）；授權未過 → 僅 executor 標 PENDING（§2.1(a)）。factory 絕不憑空補欄位 |
| 六格並行的 git lock / 檔案衝突 / 完成解析 | §3.1 共通不變式：各格寫各自檔（無 fs 衝突）、實作期間不動 git（commit 事後一次做）；Claude subagent 後端由 harness 管生命週期，agy 後端由 run-agy-batch.sh 收攏併發 + 檔案非空判定 |
| **agy 後端**：段② 零產出拖慢 | 前置（pwd 放行 + 絕對路徑 + trusted workspace，§4）；prompt 內建禁令；兩次零產出該格 Claude 接手；fallback 看目標檔非空、不靠 agy stdout |
| **Claude subagent 後端**：subagent 逾時 / context 上限 / 模型選過小產出弱 | 每格是獨立小任務（單檔、契約給足）→ context 不易爆；模型按格複雜度選（純轉寫用便宜、整合用標準）；逾時或產出弱即重派/升模型（一般 subagent 除錯，非零產出黑箱） |
| factory 產出繞過 core 治理（安全洞） | 產出只能落 `src/modules/<domain>/`，SKILL.md 明令不碰 `src/core/`；段③ ci 含既有 draft-only/scope-binding 回歸 |
| 首發標的授權黑箱使 executor 無法 live 驗 | 接受 PENDING（與 3a/announcement 同狀態）；factory 的價值在自動化「產」與「驗非寫入面」，live 寫入本就受外部授權限制 |




<!-- agy-peer-reviewed: 2026-08-19T01:44:16Z rounds=2 verdict=approved (§2/§3/§3.1/§5/§7 可攜性一致性) -->
