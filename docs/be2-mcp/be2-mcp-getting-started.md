# be2 MCP — Getting Started（PoC）

日期：2026-08-11　狀態：PoC 草稿（SIT be2-220 錨定）
> 文件結構參考 Shopline MCP 的單頁 getting-started 形態（intro → 能力 → 工具表 → 連線 → 安全 → 測試 prompt），安全章節依內部工具需求展開（Shopline 對商家隱藏的細節，正是我們對 RD/資安的賣點）。

## be2 MCP 是什麼

be2 MCP 讓你在 Claude（Claude Code / Desktop）用自然語言操作 be2 商品後台的批次任務：查商品、查方案、查庫存，並建立**待核准的變更草稿**。**任何真正的寫入都需要你本人在瀏覽器確認頁（be2 登入）看過 diff 後手動核准**——AI agent 結構上無法代替你按下核准。

## 能力

1. **批次查詢彙整**：一句話查多個商品的名稱、狀態、方案、庫存設定，agent 幫你彙整成表。
2. **批次變更草稿 + diff**：「把這 5 個方案下架」→ 產生一份逐項 `現況 → 目標` 的 diff 草稿，已在目標狀態的自動標記略過。
3. **全鏈路稽核**：每次查詢、每次核准執行都留 append-only 稽核（誰、何時、改了什麼、before/after）。

## 工具一覽

| 工具 | 讀/寫 | 一句話 |
|---|---|---|
| `be2_find_products` | 讀 | 依 prod_oid（1–20 個）查商品名稱、workflow 狀態、上下架 |
| `be2_get_product_plans` | 讀 | 查商品的方案（package）清單與各方案上下架狀態 |
| `be2_get_inventory_settings` | 讀 | 查 item 的庫存/場次設定（可指定 supplier、月份） |
| `be2_create_changeset` | 建草稿 | 建立待核准的變更草稿並回 diff——**不執行任何寫入** |
| `be2_get_changeset_status` | 讀 | 查草稿狀態；已執行者含逐項 before/after 結果 |

支援的變更類型（`action_type`）：`shelf_toggle_plan`（方案上/下架）、`inventory_setting`（庫存逐日 set/adjust）。參數細節見 `phase2a-runbook.md` / `phase3a-runbook.md`。

> agent 面**沒有**任何「送出／核准／執行」工具——這是刻意設計，不是還沒做。

## 連線（Claude Code）

1. 請管理員在 server 端為你註冊（目前 PoC 流程：`npm run bootstrap-user`，會產出一組一次性 bearer）。
2. 在你的終端機執行：
   ```
   claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp \
     --header "Authorization: Bearer <你的 bearer>"
   ```
3. 開新 Claude Code session，貼下方任一測試 prompt。

建議使用 Sonnet 等級以上模型。Claude Desktop：Settings → Connectors → 加自訂 connector（同 URL）——PoC 階段以 Claude Code 為主要驗證 client。

> **規劃中**：OAuth 登入取代 bearer——接上 connector 時瀏覽器自動跳轉 **be2 官方登入頁**輸入帳密（帳密不經過 AI、也不經過 be2-mcp 以外任何中介），見 `next-iteration-eval.md` §2。

## 安全模型（為什麼可以放心用）

- **你的權限 = 你本人的 be2 權限 ∩ MCP 已支援的工具。** agent 以你的身分行動，不會也不能越權；權限資料（businessList）來自 kkday-auth-service，be2-mcp 不自建帳號或 RBAC。
- **draft-only 是 server 端結構性強制，不是「建議開啟的確認框」。** 寫入只能由確認頁觸發，而確認頁要求 be2 登入 session——agent 只有 MCP 憑證、拿不到瀏覽器 session，兩條憑證域完全隔離（有回歸測試保證）。
- **核准當下重驗**：確認頁核准時會重抓 be2 現況重算 diff，期間若有人改過目標欄位，本次核准會被拒絕並要求重新確認——不會拿舊資料盲蓋。
- **稽核與撤銷**：append-only audit log + before/after 快照 + trace id；離職/停權在下次 token 驗證即 fail-closed。稽核任何時候不含明文 token。
- **prompt injection 防線**：工具回傳的商品名稱等內容標記為不可信資料；change-set 只能引用**本 session 內查詢過**的商品（憑空的 oid 一律拒絕）；單一草稿上限 20 項。
- **你仍需為核准負責**：確認頁上的 diff 就是會發生的事，按核准前請逐項看過。

## 測試你的接入（可直接貼）

1. `幫我查商品 [prod_oid] 的名稱和上下架狀態。`
2. `列出商品 [prod_oid] 的所有方案和各自的上架狀態。`
3. `查 item [item_oid] 在 [YYYY-MM] 的庫存設定。`
4. `把商品 [prod_oid] 的方案 [pkg_oid] 下架——先建草稿給我看 diff，不要直接執行。`
5. `我剛剛那個變更草稿現在什麼狀態？`

### 完整流程範例（draft-only 閉環）

```
你：把商品 546965 的「平日票」「假日票」兩個方案下架。
AI：（呼叫 be2_get_product_plans 查現況）目前「平日票」上架中、「假日票」已是下架。
    已建立變更草稿 cs_xxx：1 項將變更（平日票 上架→下架）、1 項將略過（假日票已在目標狀態）。
    請由管理確認頁核准後才會執行。
你：（開瀏覽器確認頁 → be2 登入 → 逐項看 diff → 按核准）
你：結果如何？
AI：（呼叫 be2_get_changeset_status）已執行完成：平日票 下架成功（before: 上架 / after: 下架）、假日票 skipped_noop。
```

注意範例中 AI **沒有**「幫你核准」的選項——它只能等你在確認頁動作後查詢結果。

## 已知限制（PoC 現況）

- 錨定 **SIT be2-220**；寫入的 live 驗證受 SIT 帳號授權限制（詳見 `phase0-inventory.md`）。
- 單機 loopback 部署（`127.0.0.1:8787`），需與 server 同機或內網可達；多實例/正式部署未做。
- 庫存讀寫契約尚未對真環境雙證，走保守容錯路徑。
- 接入採一次性 bearer（OAuth 瀏覽器登入規劃中）。
