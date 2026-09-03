# Demo 彩排紀錄 — 2026-08-16（演前完整走一輪）

> 照 `demo-guide.md` 動線彩排，SIT be2-220 真實環境。方法：能自動化的步驟真跑（MCP 協定直打 + dev panel harness + playwright），需要真人/真 Claude 的步驟標註。結論：**流程可演，揪出 1 個 be2 業務規則卡點（已修）+ 2 個 guide 補充點（已更新）**。

## 逐步結果

| 步驟 | 方式 | 結果 |
|---|---|---|
| 演前 checklist | 逐項執行 | ✅ server/build:ui/.env(SIT 220)/identity 0.3h/bootstrap-user 皆過 |
| Step 1 接入 | 授權頁渲染 + 狀態機（另見 PR #6 驗證） | ✅ 頁面與狀態流可演；真人 POPUP 登入部分演當天做 |
| Step 2 對話查詢 | MCP 協定直打 `be2_get_product_plans` 34133/9468 | ✅ 兩商品真實方案齊；LLM 表格呈現行為由 eval pin（`pos-multi-product-plans`），演當天以真 Claude 驗 |
| Step 3 批次精靈 | dev panel harness + playwright 全鏈路 | ⚠️→✅ 第一輪執行 **422**（見下）；修正後重跑：排程「下架」寫入成功 + ✓ 讀回驗證 + 取消排程還原成功 |
| Step 4 安全展示 | MCP 直打 + DB 查核 | ✅ 未讀 oid 建 change-set → `SCOPE_NOT_READ`；tools/list 僅 6 個 model 工具（0 個 app-only 曝光）；audit 114 列、明文 token 0 命中 |
| Step 5 架構總結 | 文件 | ✅ `design-overview.md` 就緒 |

## 發現 1（重要）：be2 排程規則 131105——demo 千萬別排「與現況相同」的狀態

第一輪對 pkg `1944031`（現況**上架中**）排「上架」，執行時 be2 回 422：
> `131105` 套餐預約狀態錯誤：第一筆預約狀態必須與當前上架狀態不同。

**已修（本次 commit）**：
1. `computeScheduleDiff` 加預檢——第一筆排程狀態與現況 `is_active` 相同時，建 draft 當下就拒（DiffError 帶人話訊息），不再等執行才炸。create 與批准前 live-diff 都走同一檢查。
2. `GatewayClient` 錯誤解析補認 be2 的 `{meta:{status,desc}}` 與 `{metadata:{status,desc}}` envelope——先前只顯示 `HTTP_422: gateway error`，丟失 131105 與中文訊息，排查多花 20 分鐘。

**Demo 操作守則**：1944031 目前上架中 → 示範排程請選「**下架**」；或先示範取消排程模式。

## 發現 2：備案通道需要 flag

`demo-guide.md` 備案表的 dev panel harness 需要 server 以 `APP_DEV_PANEL=1 npm run dev` 啟動——沒帶 flag 路由是 404。**建議 demo 當天就帶著 flag 起 server**（local-only、勿用於 prod），臨場切備案零等待。（guide 已更新。）

## 附註

- 彩排產生的 change-set：一筆 422 failed（保留作 audit 展示素材也行）、一筆排程+一筆取消排程（皆 done、已互相還原，be2 現況 = 彩排前）。
- 彩排期間曾誤將一顆 static bearer 印進終端，已即時撤銷該 credential 並重發（教訓：bootstrap-user 輸出一律重導檔案）。
- L2 refresh 順帶再驗一次：identity 存量 token 過期後自動續期成功（`oauth-runbook.md` L2 節）。
