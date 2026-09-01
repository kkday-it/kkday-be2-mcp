# Workflow 載體（D1：可續跑）

段②（六格並行產出）與段③（驗收）預設用 Claude 的 `Workflow` 工具當載體，取得**中途當機可續跑**。取代 v1 的「主 Claude + bash script 直接編排」——那個死一格就從頭。

> agy 後端（`run-agy-batch.sh`）**保留為省 Claude 額度的選項**（見 `stage2-produce.md`）；預設走 Workflow 的 `agent()`。

## 兩個機制別搞混

- **resumeFromRunId = 單支 Workflow 中途當機的續跑。** 同 script 同 args 再呼叫一次，已完成的 `agent()` 快取秒回，只重跑編輯過/沒跑到的格。用於：某格 API 抽風、程序被砍、改了某格 prompt 想只重那格。
- **人工 gate = 兩次 Workflow 呼叫「之間」的邊界，不是 script 內暫停。** Workflow 背景跑、問不了人，所以每個 stage 各自一支 Workflow：跑完把結果回主對話 → 主 Claude 用 `AskUserQuestion` 攔人 → 核准後才呼叫下一支。**不要**想在 script 裡呼叫 AskUserQuestion。

## 分工：什麼進 Workflow、什麼不進

| 階段 | 載體 | 為什麼 |
|---|---|---|
| 段① 探索（browser sniff、契約報告、cassette 錄製）| **不進 Workflow**，主 Claude/subagent 跑 | 需 live browser attach（`page.route` sniff、登入 session）；Workflow script 無瀏覽器 |
| GATE-plan（段②後）| 主 Claude 的 `AskUserQuestion` | 問不了人的事只能在主對話做 |
| 段② 產（六格並行 + conformance）| **Workflow A** | 六格獨立可並行、中途死要能續 |
| GATE-live-write（段③後）| 主 Claude 的 `AskUserQuestion` | 真實寫入前的人工把關 |
| 段③ 驗收（ci/e2e/error-handling）| **Workflow B** | 多步驟、要能續跑 |

段① 的產物（`docs/be2-mcp/sit-<domain>-contract.md` + 種子 cassette `tests/cassettes/<domain>.json`）透過 `args` 餵進 Workflow。

## Workflow A：段② 產（六格並行 + conformance）

```js
export const meta = {
  name: 'module-factory-produce',
  description: '六格並行產出一個 be2 action_type module + conformance 對抗驗證',
  phases: [{ title: 'Produce' }, { title: 'Conformance' }],
}
// args = { domain, actionType, contractReport, referenceCells, cassette, cells }
//   cells = [{ key:'keys', prompt, target }, { key:'module', ... }, ...]（keys 先、其餘依賴它）

const { cells } = args
const keysCell = cells.find(c => c.key === 'keys')
const rest = cells.filter(c => c.key !== 'keys')

// keys 先產（其餘 import 它的 itemKey）
phase('Produce')
const keysRes = await agent(keysCell.prompt, { label: 'cell:keys', phase: 'Produce', model: 'haiku' })

// 其餘五格並行；每格 phase 顯式指定避免 race
const produced = await parallel(rest.map(c => () =>
  agent(c.prompt, {
    label: `cell:${c.key}`,
    phase: 'Produce',
    // keys/renderer 純轉寫→haiku；module/executor/diff 整合→sonnet
    model: (c.key === 'keys' || c.key === 'renderer' || c.key === 'ui') ? 'haiku' : 'sonnet',
  })
))

// conformance 對抗驗證（跑 npm run ci + 逐格挑互斥性 bug）
phase('Conformance')
const conformance = await agent(
  `對抗式檢查剛產出的 ${args.actionType} module 六格：跑 npm run ci，逐格挑 itemKey server/ui 同源、` +
  `diffVersion 非恆定、schema 互斥、diff fall-through。回報 pass/fail + 每格疑點。`,
  { label: 'conformance', phase: 'Conformance', model: 'sonnet',
    schema: { type: 'object', properties: {
      ciGreen: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } },
    }, required: ['ciGreen', 'findings'] } }
)

return { keys: keysRes, produced, conformance }
```

跑法（主 Claude）：`Workflow({ script, args })`。中途死 → `Workflow({ scriptPath, args, resumeFromRunId })`，已產的格快取、只補未完的。

跑完 → 主 Claude 收 `{produced, conformance}`，攤六格 diff + conformance 給人 → **GATE-plan（AskUserQuestion）**。核准才進 Workflow B。

## Workflow B：段③ 驗收（cassette-backed，離線）

```js
export const meta = {
  name: 'module-factory-verify',
  description: '離線驗收一個 be2 module：ci replay 全綠 + error 分支 + 忠實度',
  phases: [{ title: 'Verify' }],
}
// args = { domain, actionType, cassette }

phase('Verify')
// happy-path 走 cassette；error 分支走 cassette.stubError（見 tests/support/cassette.ts）
const verify = await agent(
  `離線驗收 ${args.actionType}：(1) npm run ci 在 replay 模式全綠（cassette=${args.cassette}）；` +
  `(2) error-handling 分支用 cassette.stubError 注入 403/500/stale/併發，離線覆蓋；` +
  `(3) 忠實度：executor 有無照契約 read-merge-write、有無繞 verifyUserToken。回報 ci 結果 + 未覆蓋清單 + PENDING 項。`,
  { label: 'verify', phase: 'Verify', model: 'sonnet',
    schema: { type: 'object', properties: {
      ciGreen: { type: 'boolean' }, uncovered: { type: 'array', items: { type: 'string' } },
      pending: { type: 'array', items: { type: 'string' } },
    }, required: ['ciGreen', 'uncovered', 'pending'] } }
)
return verify
```

跑完 → 主 Claude 攤驗收結果 + PENDING → **GATE-live-write（AskUserQuestion）**。核准後，**live 寫入 e2e 由主 Claude 對 stage 跑一次**（非 Workflow——要 live browser/token），再開 draft PR（見 `stage3-verify.md`）。

## 收尾

段③ 全綠 + 兩道 gate 過 + live 寫入驗收 → 開 draft PR、登記 `module-catalog.md`。PR 只在人說開才開（見 `stage3-verify.md` 第 4 節）。
