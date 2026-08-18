---
name: module-factory
description: 把「新增一個 be2 MCP action_type / 接一個新 domain」從人工工程變成三段闘關（探索→產→驗收）的可複製流程。當使用者說「加一個 action_type / module / 接新 domain / 用 factory 產模組 / onboard 一個新功能到 MCP」時使用。給定設計文件（如 ENDPOINTS.md）+ 標的 action_type 名，自動探索契約、派 agy 六格並行產出一包 ActionModule、驗收開 PR，人只在三個 gate 介入。
---

# Module Factory

把 `docs/be2-mcp/module-onboarding.md` 的人工 checklist 自動化成三段流程。搭配讀 spec `docs/superpowers/specs/2026-08-18-module-factory-design.md`。

## 何時用

使用者要新增一個 be2 MCP 的 `action_type`（上下架/庫存/公告類的批次操作），或接一個新 domain。輸入 = 一份設計文件（端點清單如 `ENDPOINTS.md`）+ 標的 action_type 名。

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

**判定依據**：契約報告的「item 欄位形狀」節是否填實（來源：輸入文件的 payload 定義 / 攔到的 200 回應 / 前端型別任一）。填實 → 進段②；未填 → 停在 GATE 1 等人補來源。

三個 gate 都用 `AskUserQuestion` 問人，不自動放行。

## 每段執行者分工（memory `agy-work-allocation`）

| 段 | 動作 | 執行者 | 理由 |
|---|---|---|---|
| ① | curl/playwright 攔契約、bundle 逆向、寫報告 | **Claude** | agy 跑不了 shell/瀏覽器；純寫作 agy 也屢零產出 |
| ② | 六格 module 實作 | **agy 並行**（run-agy-batch.sh），Claude 編排 | 實作類省 Claude 額度；六格獨立可平行 |
| ② | conformance 對抗驗證 | **Claude subagent** | 需跨檔判斷 + 跑測試 |
| ③ | ci/build-ui/e2e/PR | **Claude** | 測試、playwright、git 都要 shell |

## 段② 呼叫方式

1. 照 `references/stage2-produce.md` 模板，為六格各生一份 prompt 檔（填入契約報告、參考格路徑、action_type）。keys 格先產（其餘 import 它的 itemKey）。
2. 組 manifest 檔，每行 `格名<TAB>prompt檔路徑<TAB>目標檔路徑`。
3. `MAX_PARALLEL=3 bash scripts/run-agy-batch.sh manifest` → 讀每行 `RESULT <格名> OK|EMPTY`。
4. 對 `EMPTY` 格：重派一次帶強化禁令（agy headless soft-deny 常見）；第二次仍 EMPTY → **Claude 親自寫該格**（本專案已多次這樣救場）。
5. 全格 OK 後：改 union + 註冊 → conformance-verifier subagent → 一次 commit。

## 標的切換條件

- **首發用 `shelf_toggle_bundle`（備援標的）**：同 product API、GET/PUT 都在 gateway 可達、欄位在既有 package-configs 形狀內——探索順利、不撞 gate，適合驗 factory 的完整「產」路徑。
- **真首發是商品公告（announcement）但欄位 TBD**：見 `docs/be2-mcp/sit-announcement-contract.md` §6 與 memory `announcement-fields-tbd`。欄位補齊（列表 row + POST body）即解段② 的欄位 gate，可從 bundle 切回 announcement。

## References

- `references/stage1-explore.md` — 三探索 agent 做法 + 輸入複製動作
- `references/stage2-produce.md` — 六格 agy prompt 模板 + agy headless 禁令段 + 參考格對照
- `references/stage3-verify.md` — ci/build-ui/dev-panel-e2e/PR 驗收步驟
- `references/contract-report-template.md` — 契約報告七節骨架（GATE 1 判定依據）
