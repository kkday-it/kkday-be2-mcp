---
name: module-factory
description: 把「新增一個 be2 MCP action_type / 接一個新 domain」從人工工程變成三段闘關（探索→產→驗收）的可複製流程。當使用者說「加一個 action_type / module / 接新 domain / 用 factory 產模組 / onboard 一個新功能到 MCP」時使用。給定設計文件（如 ENDPOINTS.md）+ 標的 action_type 名，自動探索契約、六格並行產出一包 ActionModule、驗收開 PR，人只在兩個 gate 介入（v2）。
---

# Module Factory

把 `docs/be2-mcp/module-onboarding.md` 的人工 checklist 自動化成三段流程。搭配讀 spec `docs/superpowers/specs/2026-08-18-module-factory-design.md`。

## 何時用

使用者要新增一個 be2 MCP 的 `action_type`（上下架/庫存/公告類的批次操作），或接一個新 domain。輸入 = 一份設計文件（端點清單如 `ENDPOINTS.md`）+ 標的 action_type 名。

## v2 變更（權威——與下方 v1 敘述衝突時，以本段為準）

見 spec `docs/superpowers/specs/2026-08-31-module-factory-v2-delta-design.md`。六個 delta：

1. **載體 = Workflow（D1，可續跑）**：段②/段③預設走 Claude `Workflow` 工具（見 `references/workflow-carrier.md`），中途死一格用 `resumeFromRunId` 只補未完的格，不從頭。agy 六格後端保留為省額度選項。
2. **cassette 離線測試（D0/D2）**：段②六格測試預設 cassette-backed（`makeCassetteFetch('replay', …)`，`tests/support/cassette.ts`），零 live；error 分支走 `cassette.stubError(...)`。段③ `npm run ci` 在 replay 模式全綠、無憑證。
3. **discovery 環境退避（D3）**：段① 撞 4xx/5xx **先自動改打 stage**（`BE2_ENV=stage`）再判，不立即判授權 gate（多半是環境問題）。詳見 `references/stage1-explore.md`。
4. **姊妹契約繼承（D4）**：標的與既有 action_type 同 domain 時，host/envelope/header/授權碼/row 直接繼承姊妹契約（離線），只 sniff executor 真正需要的新增 endpoint（含 read-merge-write 的 GET 詳情，不是只 sniff 寫 verb）。
5. **sniff 用 page.route（D5）**：攔 request body 用 server 端 `page.route` + `request.postData()`，不用 `browser_network_requests`（BE2 SPA 抓不到 body）。
6. **可攜性（D6）**：本 skill repo-local。repo 外觸發＝主 Claude 於任意 cwd 用絕對路徑讀本 SKILL.md 手動照跑（不做全域安裝）。

**Gate：3 → 2 人工 gate。** discovery GREEN（換 stage 後欄位齊、授權過）→ **原 v1 GATE 1 自動放行、不攔人**（欄位/授權 gate 的判定邏輯完全保留，只是綠燈時不再問，見下方「GATE 1 判定準則」）。剩兩道人工 gate：
- **Gate①（計畫核准）**＝原 GATE 2：段②產完，攤六格 diff + conformance + 實作計畫給人核准。
- **Gate②（live 寫入核准）**＝原 GATE 3：段③ replay 全綠後，真實寫入 stage/prod 前攔人。

## 三段流程

```
段① 探索（Claude 跑）
  輸入：設計文件 + 標的 action_type 名
  第一步：把外部輸入文件複製進 docs/be2-mcp/factory-input-<domain>.md（之後引用指 repo 內副本）
  並行探索（Claude 執行，非派 agy——agy 跑不了 shell/瀏覽器）：
    - endpoint-prober   : curl/playwright 攔真實請求 → host/path/header/envelope（憑證只落 .env、不進對話）
    - bundle-miner      : curl 抓前端 bundle → grep businessList 授權碼
    - reference-reader  : 讀 src/modules/product/*/ 判定「最像哪個現成 module」
  產物：契約報告 docs/be2-mcp/sit-<domain>-contract.md（照 references/contract-report-template.md 七節）
  ┌─ GATE 1（AskUserQuestion）：見下方判定準則
  └─ 進段②

段② 產（六格並行 + 對抗驗證）
  照 references/stage2-produce.md 為六格組 prompt（keys/module/diff/executor/renderer/ui，各引最像的現成格）
  組 manifest（格名<TAB>prompt檔<TAB>目標檔）→ MAX_PARALLEL=3 bash scripts/run-agy-batch.sh manifest
  讀 RESULT ... OK|EMPTY → 對 EMPTY 格 fallback（重派帶強化禁令；仍 EMPTY 則 Claude 親寫）
  改 src/core/changeset/types.ts 的 ActionType union + src/modules/index.ts registerModule
  conformance-verifier（Claude subagent，對抗式）：跑 npm run ci + 逐格挑互斥性 bug
  ┌─ GATE 2（AskUserQuestion）：Claude 攤六格 diff + conformance 結果，人點頭
  └─ 進段③

段③ 驗收（Claude 編排）
  照 references/stage3-verify.md：npm run ci 全綠 → node scripts/build-ui.mjs → registry exhaustive
  → dev panel e2e（BE2_MCP_DEV_PANEL=1 + playwright，同彩排法）→ error-handling agent 補 403/500/stale/併發 測試
  → 開 draft PR（含契約報告、六格產物、e2e 紀錄）
  ┌─ GATE 3（AskUserQuestion）：merge 決定 + live 寫入驗收（有授權 gate 則標 PENDING）
  └─ 完成 → 產物登記進 docs/be2-mcp/module-catalog.md
```

## GATE 1 判定準則（spec §2.1，核心正確性）

契約報告有兩種 gate 項，效果**不同**——用 `AskUserQuestion` 把判定結果攤給人確認：

- **(a) 授權 gate（executor-only）**：知道 item 欄位、只是寫入身分過不了 verify（如 svc-b2c 對 S2S token 回 403）。→ 段② 其餘格照產，**只有 executor 格**標 `PENDING: 待授權確認`（同 Phase 3a 庫存先例）。**不 block 段②。**
- **(b) 欄位 gate（block 段②）**：item 欄位形狀未知（如後端 502 導致 row 結構、POST 必填欄位拿不到）。→ **段② 整個 block**。理由：`itemSchema: z.ZodType<Item>` 是所有格的地基，欄位不明就寫 schema = 盲寫（違反主 spec 鐵則）。**factory 絕不憑空補欄位**；段② 在欄位解出前不啟動。

**判定依據**：契約報告的「item 欄位形狀」節是否填實（來源：輸入文件的 payload 定義 / 攔到的 200 回應 / 前端型別任一）。填實 → 進段②；未填 → 停下等人補來源。

**v2：此判定邏輯完全保留，但綠燈時自動放行、不攔人。** discovery GREEN（換 stage 後欄位齊、授權過，見 D3）→ 自動進段②，不問。只有「換 stage 仍卡的真授權 gate」或「欄位確實拿不到」才停下等人。兩道人工 gate（Gate① 計畫核准、Gate② live 寫入）才用 `AskUserQuestion`。

## 每段執行者分工

| 段 | 動作 | 執行者 | 理由 |
|---|---|---|---|
| ① | curl/playwright 攔契約、bundle 逆向、寫報告 | **Claude** | 需 shell/瀏覽器 |
| ② | 六格 module 實作 | **可插拔實作者**（見下） | 預設 Claude subagent；agy 為省額度選項 |
| ② | conformance 對抗驗證 | **Claude subagent** | 需跨檔判斷 + 跑測試 |
| ③ | ci/build-ui/e2e/PR | **Claude** | 測試、playwright、git 都要 shell |

## 段② 的可插拔實作者（後端偵測）

段②要有人寫五六個檔。**這個實作者是可插拔的**，控制者（主 Claude）依環境選：

- **預設 = Claude subagent**（通用、任何人可用）：每格派一個 `Agent`（subagent_type: general-purpose），模型按格複雜度選——keys/renderer 這種純轉寫用便宜模型（haiku），module/executor 整合用標準模型（sonnet）。走 `references/stage2-produce.md` 的「Claude subagent 後端」段。成本：Claude 額度。
- **選項 = agy**（僅當 `agy` 在 PATH + 已登入 + repo 在 trustedWorkspaces + 使用者要省 Claude 額度）：`run-agy-batch.sh` 派 agy。成本：Antigravity 額度。前置見 `references/stage2-produce.md`（pwd 放行 + 絕對路徑）——**memory `agy-work-allocation` 是 lance 本機專屬，非通用**。

**偵測邏輯**：`command -v agy` 有 + 使用者偏好省 Claude 額度 → agy 後端；否則 → Claude subagent 後端。不確定就用 Claude subagent（可攜性優先）。

### 呼叫方式（兩後端共通尾段）

1. 照 `references/stage2-produce.md` 為六格各生規格（契約報告 + 參考格 + action_type；keys 格先產、其餘 import 它的 itemKey）。
2. **Claude subagent 後端**：keys 先派一個 subagent，收齊後其餘五格並行派（一次多個 `Agent` 於同一訊息）。**agy 後端**：組 manifest（`格名<TAB>prompt檔<TAB>絕對目標檔`）→ `MAX_PARALLEL=3 bash scripts/run-agy-batch.sh manifest` → 讀 `RESULT <格名> OK|EMPTY`，EMPTY 格 fallback 由 Claude 親寫。
3. 全格產出後：改 union + 註冊 → conformance-verifier subagent → 一次 commit。

## 標的切換條件

- **首發用 `shelf_toggle_bundle`（備援標的）**：同 product API、GET/PUT 都在 gateway 可達、欄位在既有 package-configs 形狀內——探索順利、不撞 gate，適合驗 factory 的完整「產」路徑。
- **真首發是商品公告（announcement）但欄位 TBD**：見 `docs/be2-mcp/sit-announcement-contract.md` §6 與 memory `announcement-fields-tbd`。欄位補齊（列表 row + POST body）即解段② 的欄位 gate，可從 bundle 切回 announcement。

## References

- `references/stage1-explore.md` — 三探索 agent 做法 + 輸入複製動作
- `references/stage2-produce.md` — 六格 agy prompt 模板 + agy headless 禁令段 + 參考格對照
- `references/stage3-verify.md` — ci/build-ui/dev-panel-e2e/PR 驗收步驟
- `references/contract-report-template.md` — 契約報告七節骨架（GATE 1 判定依據）
- `references/workflow-carrier.md` — **（v2）** 段②/段③的 Workflow 載體腳本 + resume 用法 + gate 邊界
