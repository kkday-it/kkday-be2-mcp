# 契約報告骨架（段① 產物模板）

> 產出到 `docs/be2-mcp/sit-<domain>-contract.md`。真實範本見 `docs/be2-mcp/sit-announcement-contract.md`。憑證明文一律不入文件，用 `<存於 .env XXX>` 佔位。每個事實標來源（playwright 攔截 / bundle 逆向 / 輸入文件）。

## 1. 摘要

〈一句：這個 domain 是什麼、最像不像 product 形狀、選它驗證 factory 的什麼〉

## 2. Host / Endpoint / Envelope

| 項 | 值 | 來源 |
|---|---|---|
| host（SIT/prod） | | |
| 讀 / 建 / 改 endpoint | | |
| 成功契約 | HTTP 200 且 `<meta.status 值>` | |

## 3. 必要 header 與來源

| header | 值 / 來源 | 實證 |
|---|---|---|
| authorization | `Bearer <token>` | |
| 〈其他，如 x-api-key / user-uuid〉 | `<存於 .env XXX>` / `<= JWT 某 claim>` | |

## 4. businessList 授權碼

| 動作 | code | 來源 |
|---|---|---|
| 讀 | `<domain>.<...>.query` | bundle 逆向 |
| 寫 | `<domain>.<...>.update` | bundle 逆向 |

## 5. ⚠️ 未解 gate 項（授權 gate 判定依據）

〈若寫入身分過不了 verify（如 S2S token 403）——列於此，標紅、列可能解法。**這觸發授權 gate：executor-only PENDING，不 block 段②**。無則寫「無」。〉

## 6. item 欄位形狀（★ 欄位 gate 判定依據）

> **這節填實與否決定 GATE 1 的欄位 gate。** 未填實 → 段② 整個 block（factory 絕不憑空補欄位）。

- **列表 GET 200 的 row 欄位**：〈欄位名 + 型別；未取得則標 TBD + 來源阻擋原因〉
- **建立/更新 body 必填欄位**：〈欄位；PUT/POST body 形狀〉
- **merge-vs-replace 語義**：〈整筆覆蓋 or 欄位級 merge〉
- **modify_user 來源**：〈通常 = JWT platformId〉
- **可逆性**：〈能否 read→改→還原〉

## 7. 參考格對照（stage② 用）

| 六格 | 最像的現成格 | 理由 |
|---|---|---|
| keys | `<module>/keys.ts` | |
| module | `<module>/module.ts` | |
| diff | `<module>/diff.ts` | |
| executor | `<module>/executor.ts` | |
| renderer | `<module>/renderer.ts` | |
| ui（若批次型） | `<module>/ui.ts` | |

## 8. 對 module-onboarding §1 的對應

| onboarding §1 項 | 狀態 |
|---|---|
| 可寫帳號與環境 | |
| businessList 動作碼 | |
| contract probe（endpoint/必填/merge-replace/modify_user/可逆） | |
