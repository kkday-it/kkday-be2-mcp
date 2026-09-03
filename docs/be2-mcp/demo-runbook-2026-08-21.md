# be2 MCP 面板 Demo 操作劇本（2026-08-21，給 Tina demo）

> 環境:本機 :8787（**current main 碼**、`.env` 指 be2-220（`AUTHSVC_URL`/`GATEWAY_URL`）、`APP_DB_PATH=./data/be2-mcp-sit-220.sqlite`、dev panel 開、fresh token）。

## 🔑 黃金規則:每個操作「前」先重載面板
**每跑一個功能前,先重新整理面板網址（F5 / 重開 `/dev/panel/xxx`）。**
- 面板重載 = 乾淨 session,不帶上一次的 change-set / nonce / 排程佇列。
- 舊版「反覆操作卡死」的根因就是**沿用同一 session 的殘留狀態**;重載即根治。
- 已實測:連做兩次完整寫入(平台切過去→切回來),中間各重載一次,兩次都「已完成」、無卡死。

## ⚠️ 商品編號:用「真 prod_oid」,不是 be2-web 網址上的數字
網址 `/v2/product/{X}/…` 的 X 是 **mid**,面板要填**真 prod_oid**:
| 用途 | 網址 mid | **面板填真 prod_oid** | 備註 |
|---|---|---|---|
| 庫存平台切換 / 庫存數量 / 公告 | 10759 | **38352** | item_by_amount 方案:item 1594815 / supplier 1305 |
| 上下架 | 2247 | **35992** | 65 方案 |
| (庫存數量勿用) 2358 | 2358 | 2358 | 無限量方案,非 item_by_amount,不支援 |

（mid→oid 自動解析已列 follow-up #4(原 mcp_poc#23);demo 期間先手動用真 oid。）

## Demo 流程

### A. 庫存平台切換（inventory_platform）— ✅ 可 live 200,已驗、可逆(最推薦當「真的會寫」示範)
1. **重載** `/dev/panel/batch-wizard`
2. 商品填 `38352` → 載入 → 出現方案表 + BE2/BE2_SCM/EXTERNAL radio
3. 勾一個方案（如 item 1594815）→ 選目標平台（如 BE2_SCM）→ 下一步
4. step2 看 diff（`BE2→BE2_SCM`）→ 前往批准 → 確認執行
5. step4 ledger「已完成」= 真的寫進 be2-220
6. **⟳ 還原**:重載 → 同商品同方案 → 目標選回原本平台（BE2）→ 批准 → 已完成

### B. 上下架（shelf_toggle）— draft/preview 為主
1. **重載** → 商品 `35992` → 載入（65 方案）
2. 勾方案/或用商品層下架 → 下一步 → 看 diff → 批准
3. ⚠️ 真執行寫入視帳號 owner;非自己商品會 403（fail-closed,正常）。demo 建議停在 diff/批准頁展示,或只對自己 owner 的商品執行。**若執行且成功→記得還原(切回上架)**。

### C. 庫存數量（inventory_setting）— draft 安全
1. **重載** → 商品 `38352`（action_type 需 inventory_setting;model 入口或面板選）
2. 勾 item_by_amount 方案（1594815,現量會顯示）→ 填新數量 → 下一步 → diff
3. ⚠️ 真執行 PUT 目前 be2-220 卡 **AU9403**（授權待 grant,見 #2(原 mcp_poc#21)）→ 執行會 fail-closed。demo 展示到 diff 即可。

### D. 商品公告（announcement）— draft 安全
1. **重載** `/dev/panel/announcement-wizard` → 商品 `38352` → 填 name/語系/內文/生效時間 → 下一步 → diff → 批准
2. ⚠️ 真執行卡 svc-b2c 403（#2）→ fail-closed。demo 展示到 diff/確認頁。

## 每次操作「後」清理（避免下次出問題）
1. **重載面板**（最重要,清 session 狀態）。
2. **有真寫入的**（A 一定、B 若執行成功）→ **還原資料**（切回原平台 / 切回上架 / 數量改回）。
3. draft 沒執行的（C/D）→ 不影響 be2 資料,change-set 是 draft-only、會自然過期,不用特別清。

## 卡住時的復原
- 面板沒反應 / DIFF_STALE → **重載面板**（新版 DIFF_STALE 會給「重載」按鈕,非死路）。
- 呼叫回 `REAUTH_REQUIRED`（token 過期,約 50 分）→ 終端跑 `APP_DB_PATH=./data/be2-mcp-sit-220.sqlite npm run bootstrap-user` 重取,再重載面板。
- 商品 not_found → 確認用的是**真 prod_oid**（38352/35992）不是網址 mid。

## demo 前 30 秒檢查
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/healthz` → 200
- 面板載 38352 出得來方案 → auth 新鮮。若 REAUTH → 先 bootstrap。
