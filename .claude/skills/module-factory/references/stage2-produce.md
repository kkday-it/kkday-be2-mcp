# 段② 產（六格並行 + 對抗驗證）

Claude 編排、agy 實作六格。每格 prompt = 禁令段 + 契約報告 + 參考格 + 該格職責。

## agy headless 禁令段（每個六格 prompt 都要內建，逐字）

```
【重要環境限制——違反即整次作業報廢】headless 模式你的 shell 權限只有唯讀：
cat/ls/head/tail/grep/rg/find/wc、git status|log|diff|show。**禁止** mkdir/mv/cp/sed/tee/
echo重導/npm/npx/tsc/vitest/git add|commit——這些會被 auto-deny 讓你零產出。
所有檔案的建立與修改一律用你的內建檔案編輯工具（目標目錄已存在，直接寫檔、不需 mkdir）。
不跑測試、不 commit。prompt 內不用「先 grep」這類誘導你跑 shell 的動詞。
```

> **fallback**：某格 agy 連兩次零產出（soft-deny）→ 該格改由 Claude 親自寫（本專案已多次救場）。run-agy-batch.sh 的 `EMPTY` 就是這個訊號。

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
