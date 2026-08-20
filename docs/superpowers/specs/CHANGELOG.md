# Spec CHANGELOG

> `docs/superpowers/specs/` 下任何檔案異動記一筆。格式：以 `## 日期` 分組，每筆 `檔案與節次 / 改了什麼 / 為什麼`。
> 發現規格自相矛盾時，先在此提出問題再改實作，不要靜默繞過。
>
> 追溯補記（2026-08-19 起才有本規則，先前的 spec 異動追溯登記於下）。

## 2026-08-16

- `2026-08-16-be2-mcp-modularization-design.md`（全檔，新建）/ Phase 5 模組化設計：ActionModule 介面 + registry、5 熱點收斂、純重構 DoD / 把「加一個 action_type 碰 8 檔」收斂成「一包 module 註冊」。
- 同檔 §3（agy review round 1 五修）/ DiffCtx/ExecCtx 分離、validate 注入 nowMs、ConfirmView 改內容物件、ExecCtx.span 保留 span 粒度、authz degrade 逐碼映射 / agy 抓到共用 ctx 會逼 modifyUser 變 optional、validate 失去可 mock 性等真問題（rounds=2 APPROVED）。

## 2026-08-18

- `2026-08-18-module-factory-design.md`（全檔，新建）/ Module Factory 設計：三段闘關（探索/產/驗收）+ 方案 A 六格並行引擎 + repo skill 載體 / 把 module-onboarding 人工 checklist 自動化。
- 同檔 §1/§2.1/§3.1/§6/§7（agy review round 1 三修）/ (1) ENDPOINTS.md 為每次跑的輸入、需複製進 repo 避免幻影路徑；(2) GATE 1 拆授權 gate（executor-only PENDING）與欄位 gate（欄位未知 block 段②，防盲寫）；(3) 六格編排寫成 run-agy-batch.sh 機械腳本 / agy 抓到「欄位未知卻說 schema 照產」是盲寫矛盾、幻影檔路徑、並行編排缺具體腳本（rounds=3 APPROVED）。

## 2026-08-20

- `2026-08-20-be2-mcp-inventory-quantity-wizard-design.md`（全檔，新建）/ 庫存數量進 wizard 設計（塊 A，即時 SET/fullday）：**就地改寫** Phase 3a `inventory_setting` module 為 fullday-SET 形狀（拿掉 dates[]/adjust/per-month）、**只支援 item_by_amount（1/0）其餘 fail-closed 擋 + 面板標示**、`inventoryShape.ts` FINALIZE（讀取改 `POST inventories/search`、主形狀 `data[itemOid].fullday`、保留 defensive、補 fixture）、折進既有 `be2_open_batch_wizard` grid 面板 / 對齊獨立版 BAA 庫存能力（原版僅 item_by_amount/fullday）。3 個關鍵決策經使用者拍板：(a) 砍掉重寫（舊 module 從未上線、讀取端點壞的，無相容包袱）(b) 只做 item_by_amount、其餘擋掉但 UI 標「目前不支援」(c) live 寫入 PENDING（quantity PUT AU9403，RD 處理中）。與 Session 1（公告，走 sibling 面板）幾乎零檔案衝突，剩 types.ts union / index.ts 行級小衝突。塊 B（排程）另 session。
- `2026-08-20-be2-mcp-announcement-wizard-design.md`（全檔，新建）/ 商品公告進 wizard 設計：新 `announcement` domain module（首個非 product 形狀）+ module-local svc-b2c client（不碰 core GatewayClient）+ 獨立入口 `be2_open_announcement_wizard` + 專用建立表單面板 / 把 BAA 塊 C（公告）補進 MCP，驗 `ActionModule` 介面對非 product domain 的通用性。首發動作=create 全欄位；生效走原生 startTime/endTime、不做排程；live 寫入卡 svc-b2c S2S 403（build+draft 可）。3 個關鍵決策經使用者拍板：(1) create 全欄位 (2) 專用建立表單面板 (3) 獨立入口 sibling tool（因 uiResourceUri 一 tool 綁一面板、無法動態切，且避 Session 2 衝突）。
- 同檔 §4.3/§5.1/§5.9/§8/§10（agy review round 1 兩修一納）/ (1) **§4.3**：user-uuid header 改由 accessToken 自解 platformId（讀 diff/view/寫 executor 三處統一），原設計「從 ExecCtx 拿 modifyUser」對讀取路徑不成立（DiffCtx/AppToolContext 刻意不含 modifyUser、只含 accessToken）；(2) **§5.9**：通用 changeset-panel.ts 的 itemKeyOf 硬寫只認 inv/shelf，announcement diff（僅 prod_oids[]）會 fallback 回 "undefined" → CONFIRMED_KEYS_MISMATCH 永遠無法批准 → 加 announcement 分支；(3) §5.1 itemKey 用 [...prod_oids].sort() 非就地 mutate / agy 抓到讀取路徑無 modifyUser、通用面板 itemKey fall-through（rounds=2 APPROVED）。

## 2026-08-19

- 建立本 CHANGELOG（追溯補記上述 2026-08-16/18 的 spec 異動）/ 落實新增的「規格變更」規則。
- **待議（規格 vs 實作衝突，先記不靜默繞過）**：`2026-08-18-module-factory-design.md` §4 分工表寫「段② 六格由 agy 並行實作」，但實測 agy 在 headless accept-edits 下每次都想跑 shell（`pwd` 等非白名單指令）被拒→零產出，bundle 首發五格全由 Claude fallback 寫。→ **spec §4/§3.1 的「agy 主寫、Claude fallback」與現實不符，實際是「Claude 主寫、agy 為機率性加速」**。改 spec 前先解 agy allowlist（見下 evaluation），視放行後 agy 是否可用再定 spec 措辭。allowlist 評估（放行 8 個唯讀指令 pwd/which/dirname/basename/realpath/test/stat/date、寫入/執行/網路/憑證維持批准）已提交使用者、待改 agy settings.json 後實測驗證。
- `2026-08-18-module-factory-design.md` §4（agy 分工措辭修正）/ 把「agy 主寫、Claude fallback」改為「agy 段② 需兩前置（pwd 放行 + 絕對路徑/trusted workspace），前置備齊即可用；bundle 首發因前置未備才全走 fallback」/ **解掉 2026-08-19 待議的 spec-vs-實作衝突**——2026-08-19 追到底並實測確認 agy 前置修好後能寫 repo，故非「agy 不可用」而是「前置未備」。
- `2026-08-18-module-factory-design.md` §4（段② 實作者可插拔）/ 分工表「② 六格 = agy 並行」改為「可插拔實作者：預設 Claude subagent（通用），agy 為 lance 本機省額度選項」/ **可攜性**——skill 不該把 agy 寫死（agy 是特定使用者本機設定，別人用 Claude subagent）。同步改 SKILL.md 後端偵測、stage2-produce.md 加 Claude subagent 後端段、memory agy-work-allocation 標 lance 專屬。




<!-- agy-peer-reviewed: 2026-08-20T07:01:00Z rounds=2 verdict=approved -->
