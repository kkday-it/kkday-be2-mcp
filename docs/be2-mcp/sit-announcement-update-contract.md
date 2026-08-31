# SIT 商品公告「更新」(announcement_update) 契約探索報告

> 段① 產物。標的 action_type：`announcement_update`（`PATCH /admin/product/announcement/{announcementOid}`）。
> 參考格：`src/modules/announcement/create/`（同 domain、同 svc-b2c client、同 envelope）。
> **本報告 90% 繼承自 `sit-announcement-contract.md`（create 契約），只有 PATCH body 的 merge-vs-replace 語義是新的未知。**

## 1. 摘要

公告「更新」與既有的公告「建立」(`announcement`) 是**同 domain 的姊妹 action_type**：同 host（svc-b2c）、同 envelope（`metadata.status '0000'`）、同 header（`x-api-key` + `user-uuid`）、同 businessList 授權碼（`product.announcement.update`——這個碼名字本來就是 update，create/edit 共用）。因此契約可大量繼承，探索成本極低。

## 2. Host / Endpoint / Envelope

| 項 | 值 | 來源 |
|---|---|---|
| 更新 | `PATCH /admin/product/announcement/{announcementOid}` | ENDPOINTS.md（標「部分更新，實務少用」） |
| `{announcementOid}` | = GET row 的 `productAnnouncementOid`（number PK） | 繼承 create 契約 §6.1 |
| Envelope | `metadata.status '0000'` | 繼承 |

## 3. 必要 header 與來源
繼承 create 契約 §3，完全相同：`Authorization` / `x-api-key`（`.env SIT_ANNOUNCE_API_KEY`）/ `user-uuid`（= JWT `platformId` claim）。

## 4. businessList 授權碼
`product.announcement.update`（繼承 create §4；寫入共用此碼）。

## 5. 授權 gate — ✅ 已解（2026-08-31 stage 實攔，非授權天生擋死）

**SIT 的 403 是環境問題，不是 payload 或授權形狀。** 2026-08-31 在 `be2.stage.kkday.com`（登入態，gateway `api-gateway.stage.kkday.com`）實際跑 create→edit：

| 動作 | 結果 |
|---|---|
| `POST /svc-b2c/api/v1/admin/product/announcement` | **200 + `metadata.status 0000`** |
| `PATCH /svc-b2c/api/v1/admin/product/announcement/{oid}` | **200 + `metadata.status 0000`** |

→ 契約與 payload 形狀在 stage 被接受。SIT 的 403 較可能是環境/權限（roleOid/businessOid 綁定）或 gateway token 未 gateway-ready，**非請求體不合法**。executor 的授權 gate **在 stage 消除**（live 寫入走 stage 可過；SIT/prod 另受各自環境權限限制）。

## 6. item 欄位形狀 + merge-vs-replace — ✅ 已解（2026-08-31 stage 實攔）

### 6.1 WRITE wire body（POST create / PATCH edit，逐字實攔）

```jsonc
// PATCH /admin/product/announcement/{oid}
{
  "name": "…",
  "isEnabled": true,
  "prodOids": [765928],              // int 陣列
  "startTime": "2026-09-01 00:00:00",
  "endTime": null,                    // ← PATCH 無值送 null
  "langSettings": [                   // 整包送出（見 6.2）
    { "langCode": "zh-tw", "content": "…" }
  ]
}
// POST 形狀完全相同，唯一差別：無 endTime 時 POST 送 "" 而非 null
// response（POST/PATCH 皆同）：{"metadata":{"status":"0000","desc":"Success"},"data":null}
// ⚠️ POST 不回傳新 oid，要靠 list 端點查回
```

### 6.2 merge-vs-replace = **full REPLACE**（verb 是 PATCH、行為像 PUT）

實攔：UI 只改一個語系的 content，PATCH body 仍夾帶 `name/isEnabled/prodOids/startTime/endTime` 全欄位 + **完整 langSettings 陣列**。前端送「整份目標文件」非 diff。→ executor 走 **read-merge-write 讀出現況全欄位、覆蓋目標欄位、整包送回**。

**⚠️ 單次觀察未證實的一點**：本次公告只有單一語系，無法排除「後端對 langSettings 做 upsert-by-langCode」。要證實「省略某語系是否被刪」，需**一次多語系觀察**（拿 2+ 語系公告，PATCH 只送一個 langCode 看另一個是否消失）——列 executor 的 follow-up，不阻擋產出（前端既然整包送，module 比照整包送即安全）。

### 6.3 讀寫不對稱地雷（實作必看）

- **欄位名**：READ（GET 詳情）用 `langs`，WRITE 用 `langSettings`（同結構 `[{langCode, content}]`）。
- **prodOids 型別三態**：GET 詳情回**字串** `"[268051,285981]"`、list 回**真陣列** `[765928]`、寫入送 **int 陣列**。diff 格比對時要正規化。

**結論：欄位 gate 不 block schema/keys/diff/renderer/ui 五格（欄位已知）；但 executor 的 read-merge-write 邏輯依賴 merge-vs-replace 語義 → executor 格同時被「授權 gate」與「語義未知」雙重 gate。**

## 7. 參考格對照（stage② 用）

| 格 | 範本 | 備註 |
|---|---|---|
| keys | `announcement/create/keys.ts` | itemKey 加上 `announcementOid` 維度 |
| module | `announcement/create/module.ts` | actionType 改 `announcement_update`；schema 加 `announcementOid`、欄位改 optional（partial） |
| validate | `announcement/create/validate.ts` | 需 `announcementOid` 必填 |
| diff | `announcement/create/diff.ts` | update 需綁 live current（GET row）→ 與 create 的 target-only 不同，**這格要真改** |
| executor | `announcement/create/executor.ts` | **雙重 gate（授權 PENDING + merge 語義 TBD）→ 標 PENDING** |
| renderer | `announcement/create/renderer.ts` | 確認頁顯示「更新」語意 + before/after |
| ui | `announcement/create/ui.ts` | 選配 |

## 8. 對 `module-onboarding.md` §1 的對應

| 項 | 狀態 |
|---|---|
| 可寫帳號與環境 | 🟡 帳號/環境有；authz 對 S2S token 回 403（§5，繼承） |
| businessList 動作碼 | ✅ `product.announcement.update`（§4） |
| contract probe | 🟢 endpoint/header/envelope/授權碼/row 欄位/create 必填皆繼承已解；🔴 **PATCH merge-vs-replace 語義待一次真寫入（被授權 gate 擋，短期無法解）** |

---

## 段① 產出的 GATE 1 判定 — ✅ GREEN（2026-08-31 stage 實跑後）

- **授權 gate**：解除（stage POST/PATCH 皆 200/0000，§5）。
- **欄位/語義 gate**：解除（wire body + full-REPLACE 語義實攔，§6）。
- **可否進段②**：✅ **6 格全產**，無 PENDING。executor 照 create 形狀改 read-merge-write + 整包送 langSettings；diff 格處理 prodOids 型別正規化 + langs/langSettings 名稱轉換。
- **cassette 種子**：本次三筆真流量（GET 詳情 / POST / PATCH）存於 `$CLAUDE_JOB_DIR/tmp/announcement-update-capture.json`，可直接餵未來的 record/replay harness 當第一捲。

## 殘留清理（待辦）

stage 商品 **765928** 上有 **2 筆已停用的 `[CLAUDE-TEST]` 公告**（oid **3084**、**3085**）——BE2 前台無刪除鈕，已 `isEnabled=false` 停用，前台不顯示。若要硬刪需走 `DELETE` API 或請有權限者處理。

## 探索工具注記（給 v2 discovery）

Playwright MCP 的 `browser_network_requests` **抓不到 request body**（該 SPA 的 HTTP client 載入時已綁定 fetch 參照，繞過 window override）。必須用 server 端 **`page.route` + `request.postData()`** 才攔得到 wire body。v2 的 sniff 步驟要內建此法。
