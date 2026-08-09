# be2 MCP — Phase 2b Pilot Runbook（SSO 確認頁）

> 對象：使用 Phase 2a 兩個 L2 change-set 工具（`be2_create_changeset` / `be2_get_changeset_status`）並經**確認頁**批准寫入的 pilot 使用者。承接 `docs/be2-mcp/phase1a-runbook.md`（read tools、enrollment、static bearer）與 `docs/be2-mcp/phase2a-runbook.md`（change-set 概念、diff、read-merge-write）— **請先讀完那兩份**，本文件只講 Phase 2b 改動的部分：**確認頁的登入機制**。環境錨定 SIT `be2-220`。

## Phase 2b 改了什麼

Phase 2a 的確認頁用**一次性 capability token**（URL 裡的 `?token=`）當作「誰能批准」的唯一憑證——任何人（包含 agent 自己，若能存取 loopback）只要知道這個 URL 就能批准。Phase 2b **拿掉這個機制**，改成確認頁本身要求操作者用 **be2-auth 帳號登入**（透過瀏覽器 SSO，設 `be2mcp_sid` cookie），批准/拒絕改由「目前登入的 be2 使用者是否等於這個 change-set 的建立者」來判斷。

**這是本次的核心安全升級**：agent 沒有、也不可能有 be2-auth 的登入 session（它只有一組 MCP bearer，跟確認頁的 web session 是兩套完全獨立的憑證）。即使 agent 把 `changeset_id` 講出來、甚至猜/組出舊版的 `?token=` 參數，確認頁一律先看 cookie；沒有合法 session 一律導去登入頁，永遠碰不到批准/執行的程式碼路徑。見下方「自我批准漏洞已關閉」。

## 前置需求

- 公司網路或 VPN（能連 be2-auth `auth-220.sit.kkday.com` 開登入彈窗）。
- Node 22（與 Phase 1a/2a 相同）。
- 專案根目錄的 `.env` 已設好 `AUTHSVC_URL` / `GATEWAY_URL` / `SIT_AUTHSVC_SERVICE_KEY` / `BE2_MCP_PORT`（預設 8787）。
- `npm run dev` 已啟動 be2-mcp server（Streamable HTTP `/mcp` + 確認頁 `/confirm/*`），且 Claude Code 已用 Phase 1a 的 `bootstrap-user` 流程 enroll 過。
- 瀏覽器需允許彈出視窗（登入用 POPUP，見下）。

## 批准流程（SSO 版）

1. **Agent 端不變**：如 Phase 2a，跟 agent 說「把商品 `<prodOid>` 下架」之類的請求，agent 呼叫 `be2_create_changeset`，聊天視窗只會收到 `changeset_id` + `status` + `diff` —— **不含**任何確認頁連結或 token（鐵則 #4，draft-only）。
2. **操作者自行開啟確認頁**：`http://127.0.0.1:8787/confirm/<changeset_id>`（`changeset_id` 由 agent 回報，可直接複製；port 依 `BE2_MCP_PORT`）。
3. **若尚未登入**（沒有有效的 `be2mcp_sid` cookie，或 session 已死），確認頁會 302 導向 `/confirm/login?next=/confirm/<id>`，顯示一個「登入 be2」按鈕。
   - 點擊按鈕會**在使用者手勢內**（瀏覽器會擋非使用者手勢觸發的彈窗）開一個 POPUP，導向 be2-auth 的登入頁（`loginFlow=POPUP`）。
   - 若瀏覽器已有有效的 be2-auth cookie（例如剛登入過 be2-web），這一步是**靜默**的（跟 be2-web 自己的行為一致）；否則要求帳密+2FA。
   - 登入成功後，be2-auth 用 `postMessage` 把 authorizationCode 傳回 opener；確認頁前端**驗證訊息來源是 be2-auth 的 origin**（防止其他分頁/惡意頁面偽造），再把 code POST 到 be2-mcp 自己的 `/confirm/session`，由 server 端帶 service key 換 `{accessToken, refreshToken, businessList}`，建立 web session、設 `be2mcp_sid`（HttpOnly）cookie，然後導回原本要看的 `/confirm/<id>`。
4. **審閱 diff**：確認頁對 be2 **即時重算**現況（不是建立當下快取的），顯示「現況 → 目標」逐 item 呈現（以 oid 為準，名稱是未經信任的 be2 內容僅供辨識）。
5. **批准或拒絕**：點「批准並執行」會透過 gateway 執行 read-merge-write（見 phase2a-runbook 的說明）；點「拒絕」則作廢該 change-set。兩者皆一次性——同一 change-set 的第二次批准/拒絕會拿到 `409`。
6. **查結果**：跟 agent 說「change-set `<id>` 執行結果如何？」（`be2_get_changeset_status`），或直接看確認頁批准後回傳的執行結果頁面。

### 登出

`POST /confirm/logout`（確認頁上沒有顯式的登出按鈕；若要手動登出，直接對這個路徑發 POST，例如 `curl -X POST http://127.0.0.1:8787/confirm/logout -H "cookie: be2mcp_sid=<sid>"`，或清掉瀏覽器的 `be2mcp_sid` cookie）。登出會刪除 server 端的 web session 列（`web_sessions` 表），並把 cookie 的 Max-Age 設為 0。

### Example 對話

- "先查商品 `<prodOid>` 現在上架還是下架，然後幫我把它下架"（同 Phase 2a）
- 「change-set `<id>` 現在狀態如何？」
- 直接要求 agent 執行（"不要問我，直接下架"）— 一樣被拒絕：agent 沒有批准工具，且就算有，它也沒有 be2-auth session，無法通過確認頁的登入檢查。

## 自我批准漏洞已關閉（Phase 2b 對 Phase 2a 的安全升級）

Phase 2a 的已知風險：**任何拿得到 confirm URL 的人（或程式）都能批准**，因為認證只靠 URL 裡的一次性 token。若 agent 執行環境本身能存取 loopback（例如 Claude Code 有 Bash/curl），agent 理論上能自己 curl 確認頁、完成自我批准，繞過人工審批。

Phase 2b 關閉這個洞：確認頁的 `/confirm/:id`、`/confirm/:id/approve`、`/confirm/:id/reject` 現在**完全不讀 URL query 或 request body 裡的任何憑證**，只認 `be2mcp_sid` cookie 對應的 web session。agent 沒有、也無法取得這個 cookie（它是 be2-auth 登入頁 POPUP 流程的產物，需要真人在瀏覽器裡完成帳密+2FA 或消費既有的 be2-auth SSO cookie）。`tests/phase2bSecurity.test.ts` 對此有明確的回歸測試：即使故意帶上舊版的 `?token=` 參數且完全不帶 cookie，確認頁一律視同「未登入」處理（302 導向登入頁），change-set 狀態維持 `pending_approval`，gateway 完全沒被呼叫。

同一份測試也涵蓋 **IDOR**：用 A 使用者的 session cookie 去查看/批准 B 使用者建立的 change-set，一律 `404`（不洩漏該 id 是否存在）。

## 疑難排解

| 症狀 | 原因 | 處理 |
|---|---|---|
| 開確認頁被導到登入頁 | web session 已過期（idle TTL，預設 8 小時無操作）或本來就沒登入過 | 重新登入（點「登入 be2」→ POPUP） |
| 開自己建立的 change-set 卻 `404` | 目前登入的 be2 使用者 **≠** 建立這個 change-set 的使用者（IDOR 保護，見上） | 確認用同一個 be2 帳號登入；換帳號登入無法看到別人建立的 change-set，這是設計行為 |
| 批准後執行結果顯示 `403` | be2 shelf-write 權限不足（帳號層級），或環境授權問題 | **這是預期中的目前卡點**，非 be2-mcp 的 bug；見 `docs/be2-mcp/sit-write-contracts.md`。目前 `.env` 測試帳號在 SIT 對 shelf-toggle 寫入回 403 |
| 批准時 `409` + 重新整理的頁面（有紅字提示） | **live diff 過期**：頁面載入後、批准前，be2 上的現況又被改了（你自己或別人） | 重新檢視最新 diff 後再決定是否批准 |
| 批准/拒絕時 `409 已被處理或已過期`（純文字，非頁面） | 這個 change-set 已經被處理過（可能是你在另一分頁按過、或已 `done`/`rejected`） | 用 `be2_get_changeset_status` 查真正結果，不要重試 |
| 登入彈窗被瀏覽器擋掉 | 彈窗不是在使用者手勢（click）內開啟，或瀏覽器封鎖彈窗 | 直接點「登入 be2」按鈕本身（不要用腳本/自動化去觸發），並允許該網站的彈出視窗 |
| 一直無法完成登入 / postMessage 沒反應 | be2-auth POPUP 訊息格式或 `redirectPath` 尚待對真實 be2-auth 環境最終確認（見下方 Phase 2b 限制） | 回報給 be2-mcp 維護者；這是已知的 carry-forward 待確認項，非使用者可自行排除 |

## Session、audit 存放位置

- **Web session**：SQLite `web_sessions` 表（同一顆 DB，`BE2_MCP_DB_PATH`）— `session_id`（即 cookie 值,高熵隨機）、`user_label`、`created_at`、`last_seen_at`。idle TTL 預設 8 小時（超過未操作即視為過期,下次讀取時刪除該列）。
- **be2 token（access/refresh/businessList）**：沿用既有 `user_tokens` 表,以 `hashBearer(sessionId)` 為 key 存放 —— 跟 Phase 1a/2a 的 MCP bearer token 是**同一張表、同一套雜湊 key 機制**,只是 key 換成 web session id 而非 MCP bearer。
- **Change-set / 執行結果**：同 Phase 2a 的 `change_sets` / `change_set_results` 表,未變動。
- **Audit log**：同一張 `audit_log` 表。批准/拒絕的「人類決策」事件（`tool = changeset.approve` / `changeset.reject`）現在 attribute 到**批准當下的 web session**（`session_id` + `userLabel`）,而不是 change-set 原始建立者 —— 這正是關閉自我批准漏洞後,審計欄位也要跟著誠實反映「誰按的」而非「誰建立的」：
  ```bash
  sqlite3 data/be2-mcp.sqlite 'SELECT tool, user_label, session_id, status FROM audit_log ORDER BY id DESC LIMIT 10'
  ```
  跟 Phase 1a/2a 一樣,這張表任何時候都不會出現明文 token（bearer、access/refresh token、舊版 capability token 皆只存雜湊或完全不存）。

## Phase 2b 已知限制

- **Loopback、單機**。確認頁只在 `127.0.0.1:$BE2_MCP_PORT` 服務,跟 Phase 1a/2a 一樣是單一 server 實例,`web_sessions` 表是 in-process/SQLite-single-writer。
- **be2-auth POPUP 訊息契約 + `redirectPath` 值仍待對真實 be2-auth 環境做最終確認（carry-forward）**：目前程式假設 be2-auth 登入成功後會用 `postMessage` 送出 `{authorizationCode}` 或 `{code}`（`src/server/ssoRoutes.ts` 兩個 key 都接受),且 `redirectPath` 參數目前是回填 be2-auth 自己的登入頁 URL 當佔位值（POPUP flow 理論上不依賴 `redirectPath` 導頁,只靠 `postMessage`,但 be2-auth 端是否要求這個參數是合法/可達的 URL 尚未在真實環境驗證過)。這是 Phase 0 inventory 記錄的 B2 小確認項的延伸,在真的接上 be2-auth（非 mock）前應先核對一次真實的訊息格式與 `redirectPath` 語意。
- **寫入仍被 403 卡住**（per 環境/per 帳號,非 mechanism 問題）：見下方 PENDING 區塊與 `docs/be2-mcp/sit-write-contracts.md`。
- **`modify_user` 仍是 placeholder**：同 Phase 2a,`src/server/app.ts` 的 `modifyUserFromPlaceholder` 預設丟 `MODIFY_USER_UNRESOLVED`,需要 `BE2_MCP_ALLOW_PLACEHOLDER_MODIFY_USER=1` 才會回退到（錯誤但語法合法的）JWT `platformId`。在有寫入權限的帳號可用之前,不要在真實寫入路徑上開這個旗標。

---

## ⚠️ Live SIT WRITE e2e — PENDING（等待可寫帳號）

**狀態：契約已雙證（見 `docs/be2-mcp/sit-write-contracts.md`：be2-web 實測 + stage 200 兩處都證實了 executor 的 read-merge-write 路徑是對的),差的只是「用 be2-mcp 自己的程式跑一次真正的 200」——目前 SIT `.env` 帳號 `lance.chien@kkday.com` 對 shelf-toggle 寫入端點回乾淨 403（無寫入權限,即使是自己名下的商品),不是 mechanism 壞掉。**

Phase 2b 新增的「SSO 登入」本身在**本機沒有 be2-auth 的自動化整合測試**（`tests/ssoRoutes.test.ts` 用假的 `authServiceClient.exchangeCode` mock,不打真實 be2-auth),所以除了寫入 403 這個既有卡點,**還有一項 Phase 2b 專屬的待驗證項**：真實 be2-auth 環境下的 POPUP `postMessage` 契約是否如預期（見上方「已知限制」）。

### 等到有可寫帳號 / 可對真實 be2-auth 測試時，照這個順序跑一次：

1. `npm run dev` 啟動 server；**用真實瀏覽器**（非 headless）打開 `http://127.0.0.1:8787/confirm/login?next=%2F`，點「登入 be2」，確認彈窗開啟、be2-auth 登入頁正確載入。
2. 完成登入（帳密+2FA，或若瀏覽器已有 be2-auth cookie 則應靜默完成）→ 確認彈窗自動關閉、頁面導向 `next`、瀏覽器已設 `be2mcp_sid` cookie（HttpOnly，開發者工具的 Application/Storage 分頁應看得到，但看不到值本身的用途，只需確認存在）。
3. 用**同一顆瀏覽器**、**寫入權限帳號** enroll 過的 Claude Code session：「先查商品 `<managedProdOid>` 的方案狀態」→「把方案 `<pkgOid>` 下架」→ agent 回報 `changeset_id`。
4. 開 `http://127.0.0.1:8787/confirm/<changeset_id>` → 應直接看到 diff 頁面（若步驟 2 的 session 還活著，不會再被導去登入）。
5. 點「批准並執行」→ **今天預期會是 403**（fail-closed，見上）；一旦帳號有寫入權限，預期改為 200 且 be2-web 上的實際狀態同步變更。
6. 若步驟 5 拿到 200：立刻建立反向的 change-set（把同一個 `pkg_oid` 切回原本的 `target_is_active`），走完整流程 revert，並在 be2-web 上肉眼確認狀態已還原（比照 `phase2a-runbook.md` 的 toggle+revert 步驟）。
7. 補記錄：把本節替換成實際跑出來的結果（成功/失敗、螢幕截圖或文字記錄、audit log 摘錄），並同步更新 `docs/be2-mcp/phase0-inventory.md` 的 handoff。

在此之前，本節維持 PENDING，不代表 mechanism 有問題——契約已經雙證，只差一顆帳號。
