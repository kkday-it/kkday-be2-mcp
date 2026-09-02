# 段③ 驗收（Claude 編排）

六格產出且 **Gate①（計畫核准）** 過後的驗收步驟。全部 Claude 執行（需 shell/playwright/git）。預設走 Workflow B（`references/workflow-carrier.md`），中途死可 resume。

## v2 驗收變更（權威）

- **ci 在 replay 模式離線全綠**：`npm run ci` 靠 cassette（`tests/cassettes/<domain>.json`）跑，**零 live、零憑證**；CI 環境也能跑。
- **error 分支離線覆蓋**：403/500/stale/併發 用 `cassette.stubError(...)` 注入，不打 live（見第 3 節）。
- **live 寫入 e2e 分離、且是人工 Gate②**：replay 全綠後，真實寫入 stage/prod 前 **`AskUserQuestion` 攔人（Gate②）**；核准後 live 寫入 e2e 由主 Claude 對 stage 跑一次（要 live browser/token，非 Workflow）。原 v1 GATE 3 = 此 Gate②（併 merge 決定）。

## 1. 靜態驗收

```bash
npm run ci                 # typecheck + 全測試（含新 module + conformance 自動繼承）→ 必須全綠
node scripts/build-ui.mjs  # 若 domain 有 ui.ts（批次型）→ bundle 成功、無 server-only 誤入
```
- registry exhaustive：`tests/core/moduleConformance.test.ts` 的「union ⇔ registry 一一對應」自動涵蓋新 action_type。

## 2. dev panel e2e（讀取面，同彩排法）

```bash
BE2_MCP_DEV_PANEL=1 npm run dev > /tmp/factory-dev.log 2>&1 &
sleep 3 && curl -s http://127.0.0.1:8787/healthz
```
- playwright 驅動：開 `http://127.0.0.1:8787/dev/panel/<panel>?action_type=<type>&prod_oids=<測試oid>` → 載入 → 檢視 diff。
- **憑證新鮮度**：identity <12h 或先 `npm run bootstrap-user`（輸出重導檔案、不進對話）。
- **讀取面** e2e 一定要通；**寫入面** 若卡授權（如 shelfToggle 的 403 前例）→ 標 live 寫入 PENDING（同 3a），非阻擋。

## 3. error-handling 補測

補 executor 的錯誤分支測試：403（授權）、500（gateway）、stale（diff drift）、併發（同 key）。**v2：一律用 `cassette.stubError(method, urlPattern, status, envelopeBody)` 注入錯誤、離線覆蓋**（`tests/support/cassette.ts`），不打 live——種子 cassette 只有 happy-path 200，錯誤分支靠 stub。照既有 `tests/*Executor.test.ts` 的斷言風格。

## 4. 開 draft PR

```bash
git push -u origin feat/<domain>-module
gh pr create --base main --draft --title "feat: <domain> module（factory 產出）" \
  --body "factory 三段產出。含契約報告 sit-<domain>-contract.md、六格 module、e2e 紀錄。<live 寫入 PENDING 說明若有>"
```
PR body 附：契約報告連結、六格檔清單、`npm run ci` 結果、dev panel e2e 截圖/紀錄、GATE 1 判定（授權/欄位 gate 狀態）。

## 5. Gate②：live 寫入 + merge（AskUserQuestion，原 v1 GATE 3）

Claude 報告三段完成 + e2e 結果 + PENDING 項 → 人核准 live 寫入 + 決定 merge。merge 後更新 `docs/be2-mcp/module-catalog.md` 加該 domain 條目（key 形狀、authz、executor 形狀、factory 標記）。
