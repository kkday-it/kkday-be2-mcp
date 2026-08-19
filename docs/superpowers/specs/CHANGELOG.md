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

## 2026-08-19

- 建立本 CHANGELOG（追溯補記上述 2026-08-16/18 的 spec 異動）/ 落實新增的「規格變更」規則。
- **待議（規格 vs 實作衝突，先記不靜默繞過）**：`2026-08-18-module-factory-design.md` §4 分工表寫「段② 六格由 agy 並行實作」，但實測 agy 在 headless accept-edits 下每次都想跑 shell（`pwd` 等非白名單指令）被拒→零產出，bundle 首發五格全由 Claude fallback 寫。→ **spec §4/§3.1 的「agy 主寫、Claude fallback」與現實不符，實際是「Claude 主寫、agy 為機率性加速」**。改 spec 前先解 agy allowlist（見下 evaluation），視放行後 agy 是否可用再定 spec 措辭。allowlist 評估（放行 8 個唯讀指令 pwd/which/dirname/basename/realpath/test/stat/date、寫入/執行/網路/憑證維持批准）已提交使用者、待改 agy settings.json 後實測驗證。
- `2026-08-18-module-factory-design.md` §4（agy 分工措辭修正）/ 把「agy 主寫、Claude fallback」改為「agy 段② 需兩前置（pwd 放行 + 絕對路徑/trusted workspace），前置備齊即可用；bundle 首發因前置未備才全走 fallback」/ **解掉 2026-08-19 待議的 spec-vs-實作衝突**——2026-08-19 追到底並實測確認 agy 前置修好後能寫 repo，故非「agy 不可用」而是「前置未備」。


