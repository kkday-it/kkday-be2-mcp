# 段② 產（六格並行 + 對抗驗證）

Claude 編排，六格由**可插拔實作者**寫。每格規格 = 禁令段（agy 後端限定）+ 契約報告 + 參考格 + 該格職責。

## v2：載體與測試（權威）

- **載體預設 Workflow**（`references/workflow-carrier.md`）：六格走 Workflow 的 `parallel`（keys 先、其餘並行），中途死用 `resumeFromRunId` 只補未完格。下方 agy 後端 / `run-agy-batch.sh` 保留為省 Claude 額度的選項。
- **每格單元測試預設 cassette-backed（D2）**：餵 `makeCassetteFetch('replay', 'tests/cassettes/<domain>.json')`（`tests/support/cassette.ts`），零 live、可重複，取代 v1 的 fixture-gated `skipIf` 半套。**happy-path 走 cassette、error 分支（403/500/stale/併發）走 `cassette.stubError(method, urlPattern, status, envelopeBody)`**——兩者都離線，不因種子 cassette 只有 200 而測不了錯誤。executor 格的錯誤處理測試一律用 stubError，不打 live。

## 兩個後端（SKILL.md 的偵測決定用哪個）

- **Claude subagent 後端（預設、通用）**：見下方「Claude subagent 後端」段。任何人可用，不需 agy。
- **agy 後端（lance 本機省額度選項）**：見「agy 後端」段。需前置（pwd 放行 + 絕對路徑 + trusted workspace）。

---

## Claude subagent 後端（預設）

主 Claude 用 `Agent` tool 派 subagent 寫每格，不需 agy、不需禁令段（subagent 有完整 shell/檔案工具）：

- **派法**：keys 格先派一個 `Agent`（`subagent_type: general-purpose`），收齊後其餘五格**並行**（同一訊息多個 `Agent`）。每個 subagent 的 prompt = 該格職責 + 契約報告路徑 + 參考格路徑（下方「六格 prompt 模板」的職責描述通用，去掉 agy 禁令段即可）。
- **模型按格選**（省成本）：keys/renderer（純轉寫、契約給足）→ `haiku`；module/executor/diff（整合、read-merge-write 慣例）→ `sonnet`。
- **無 fallback 需求**：subagent 就是 Claude，本來就會寫；失敗即一般 subagent 除錯，非 agy 的零產出問題。
- 產物路徑可相對可絕對（subagent 在 repo cwd）。

---

## agy 後端（lance 本機專屬，memory `agy-work-allocation`）

### ★ 兩個前置（2026-08-19 追到底的零產出根因）

agy 段② 能用，取決於兩件事**都**成立（缺一即零產出）：

1. **agy allowlist 有 `pwd` + 唯讀定位指令**（`~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow`）：agy 寫檔前習慣跑 `pwd`，若不在白名單即 auto-deny→零產出。已放行：pwd/which/dirname/basename/realpath/test/stat/date（寫入/執行/網路/憑證維持批准）。
2. **目標檔用絕對路徑 + repo 在 `trustedWorkspaces`**：headless `-p` 模式 agy **無 active workspace**，相對路徑會掉進 agy 自己的 scratch 資料夾（不是 repo）；絕對路徑則需該路徑落在 trusted workspace 內才准寫。→ **prompt 與 manifest 的目標檔一律用絕對路徑**（如 `/Users/…/mcp_poc/src/modules/product/<domain>/keys.ts`），且確認 repo 已在 `trustedWorkspaces`。

## agy headless 禁令段（每個六格 prompt 都要內建，逐字）

```
【重要環境限制——違反即整次作業報廢】headless 模式你的 shell 權限只有唯讀：
cat/ls/head/tail/grep/rg/find/wc/pwd/which/dirname/basename/realpath/test/stat/date、
git status|log|diff|show。**禁止** mkdir/mv/cp/sed/tee/echo重導/npm/npx/tsc/vitest/git add|commit
——這些會被 auto-deny 讓你零產出。所有檔案的建立與修改一律用你的內建檔案編輯工具，
**目標檔用絕對路徑**（相對路徑會掉進 scratch、不進 repo）。不跑測試、不 commit。
prompt 內不用「先 grep」這類誘導你跑 shell 的動詞。
```

> **fallback（次要路徑，非預設）**：前置成立時 agy 段② 正常運作；若某格仍連兩次零產出 → 該格改由 Claude 親自寫。run-agy-batch.sh 的 `EMPTY` 是此訊號。bundle 首發時前置未備齊（pwd 未放行、給相對路徑），故全走 fallback——前置修好後 agy 應可直接寫（2026-08-19 實測絕對路徑 + trusted workspace + pwd 放行後 agy 成功寫 repo）。

## 六格 prompt 模板

每格模板填三個佔位：`{{contract_report}}`（`docs/be2-mcp/sit-<domain>-contract.md` 路徑）、`{{reference_file}}`（契約報告「參考格對照」指定的現成格）、`{{action_type}}`。keys 先產。

### keys（先跑，其餘 import 它）
```
<禁令段>
任務：寫 src/modules/product/<domain>/keys.ts——{{action_type}} 的 itemKey 純函式。
參考 {{reference_file}}（同名 keys.ts）的形狀。keys.ts 是 isomorphic leaf：不得 import
zod/gateway/node 任何 server-only 模組（server 與面板 UI 共用它）。itemKey 規則照契約報告
{{contract_report}} 的「item 欄位形狀」定（如 prod_oid:pkg_oid）。
```

### module（schema/authz/isItem/scopeOids/validate 組裝）
```
<禁令段>
任務：寫 src/modules/product/<domain>/module.ts——組出 ActionModule。參考 {{reference_file}}。
欄位值全照契約報告 {{contract_report}}：itemSchema(zod,照「item 欄位形狀」)、authz.codes(照
「businessList 授權碼」)、authz.onMissing(有授權 gate→warn 否則 block)、isItem/scopeOids/
scopeErrorKey/validate/invalidItemsMessage/scopeNotReadMessage。import keys.ts 的 itemKey、
自己的 diff/executor/renderer。介面定義見 src/core/changeset/module.ts。
```

### diff / executor / renderer（各一格，同結構）
```
<禁令段>
任務：寫 src/modules/product/<domain>/<diff|executor|renderer>.ts。**逐字照 {{reference_file}}
的同名檔改**，只換 endpoint/欄位為契約報告 {{contract_report}} 所列。保留參考格的錯誤處理慣例
（read-merge-write、per-item catch、status 聚合、DiffError、ConfirmView 等）。
若有授權 gate（executor 格）：executor 產出骨架 + 對 SIT 標 PENDING（不跑真 200，同 3a）。
```

### ui（僅批次型 domain）
```
<禁令段>
任務：寫 src/modules/product/<domain>/ui.ts——面板分頁 descriptor。isomorphic：只 import 自己
keys.ts 與 core 型別(type-only)，不 import module.ts/executor/gateway。參考 {{reference_file}}。
```

## 呼叫與收攏

1. 六格各生 prompt 檔（填佔位）。
2. 組 manifest：`格名<TAB>prompt檔<TAB>目標檔`（如 `keys\t/tmp/p_keys.txt\tsrc/modules/product/<domain>/keys.ts`）。
3. `MAX_PARALLEL=3 bash .claude/skills/module-factory/scripts/run-agy-batch.sh manifest`。
4. 讀 `RESULT <格名> OK|EMPTY`；EMPTY → fallback（重派帶強化禁令；仍 EMPTY → Claude 親寫）。
5. 改 `src/core/changeset/types.ts` 的 `ActionType` union 加 `{{action_type}}`；`src/modules/index.ts` `registerModule`。

## 對抗驗證（conformance-verifier，Claude subagent）

派一個 Claude subagent 對抗式檢查，跑 `npm run ci` 且逐格挑歷次模組化 review 反覆抓的 bug：
- **itemKey server/ui 同源**（兩處判別法不一致是老 bug）
- **diffVersion 非恆定 hash**（恆定 = 靜默停用 stale 防護）
- **schema 互斥**（他型 item 被吞）
- **無 diff fall-through / per-type 判別不一致**
在 `tests/core/moduleConformance.test.ts` 的 SAMPLES/DIFF_SAMPLES 加該 domain 樣本，自動繼承 conformance。
