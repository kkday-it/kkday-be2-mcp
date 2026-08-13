# be2 MCP — Phase 0 盤點 tracker

> Phase 0 目標（主 spec §11）：把開工前的不確定性清掉。分三類：**A 認證/ token 串接**（多數可從原始碼查證，已做）、**B 外部依賴**（需跟別的 team / 資安）、**C be2 product endpoint + 權限等價性盤點**（真正剩下的工）。
> 狀態圖示：✅ 已查證　🟡 幾乎確認　⬜ 待辦　🔴 卡關（需人）

## 現況與下一步（handoff，2026-08-09）

**已定案**：認證 = Option 1（be2 token 存內網 server store、給 Claude 不透明參考；登入 redirect be2-auth；委派 `/verify`）；spec `docs/superpowers/specs/2026-08-07-be2-mcp-design.md` 已 agy approved。**開發環境錨定 SIT `be2-220`**（見 CLAUDE.md）。

**Phase 0 狀態**：
- 認證串接：多數 ✅ 實證（userType `be2`、host、gateway、refresh rotate+fresh businessList、cookie 非必需）。
- **B1 service key：SIT 版已取得**（`.env` 的 `SIT_AUTHSVC_SERVICE_KEY`）→ SIT 開發不卡。
- B2 redirect：🟢 SIT 實測跑通（POPUP flow）。B3 公網：不需要（Code+Desktop 本機）。B4：Option 1 已消。
- C 盤點：**方案(package)域已盤完**（見下）；庫存/價格域待盤；權限 403 低權實測待人工。

**Phase 優先序（重要修正）**：raw 頻率誤導了 3 次（POST=讀、package/info=改名）。定論：`package-configs`(方案上下架) = Phase 2 首發好 endpoint；Phase 3 真價值 = 庫存+價格；寫入優先序近 Phase 2 時用語義信號定。

**下一步**：開新 session → `superpowers:writing-plans` 規劃 **Phase 1a**（MCP server skeleton + 3 個 L0 read tools + OTel + 稽核 + eval 骨架；Claude Code static bearer；**無外部依賴、不等 C 盤完**）→ agy-peer-review → subagent-driven-development + TDD。

**Phase 1a 進度（2026-08-09，Task 16）**：**已實作完成 + Live SIT be2-220 e2e 驗收通過**——MCP server（Streamable HTTP）+ 3 個 L0 read tools（`be2_find_products`／`be2_get_product_plans`／`be2_get_inventory_settings`）+ OTel + 稽核（append-only audit_log）+ rate budget + eval 骨架,全走 TDD,測試 **70 passed / 0 skipped**（fixture-gated 測試已用真實 be2-220 資料實跑）,plan 已 agy-approved。Pilot 文件見 `docs/be2-mcp/phase1a-runbook.md`。

**Live 驗收（2026-08-09,對 SIT be2-220）**：先前 `AU9010` 是 `.env` 誤指 stage,改回 `auth-220.sit`/`api-gateway-220.sit` 後 `.env` 帳密正常（`AU0000`）。以真實 bearer 透過 MCP 協定跑通 3 個工具(拿到真實商品名稱/方案/庫存狀態)、壞 bearer 拒絕、audit 無 token 明文、session_read_oids(§6.2 substrate)寫入、注入字串優雅處理。Live 揪出並修掉 3 個真實契約缺陷: fixture 需存 unwrapped、方案名是 `pkg_name`、inventory 端點須走 product-service-direct(`/product/api/v1/items/{itemOid}/inventories/...`,原 `/be2/api/v1/...` 系統性 500)。**未竟(非 Phase 1a read 阻擋項)**: inventory 依 supplier 的數量因測試帳號對該 marketplace 商品無 supplier 權限(403)未實測、需用帳號自管商品+supplier_oid 驗;trace_id 需 `OTEL_MODE=console|otlp` 才有值。

**Phase 2a 進度（2026-08-09,Task 1–10）**：**已實作完成**——2 個 L2 change-set 工具（`be2_create_changeset`／`be2_get_changeset_status`）+ change-set service（§6.2 scope 讀取閘門、businessList action-only fail-fast、per-user 每日 change-set budget）+ capability-URL 確認頁（`GET/POST /confirm/:id`，一次性 token 只存 hash、creator-bound、`Referrer-Policy: no-referrer`、approve 時 live-diff 重算 + stale 409 + compare-and-swap 防重複執行）+ executor（read-merge-write 經 gateway PUT、no-op 略過、`Promise.allSettled`、before/after + per-item audit）+ eval（draft-only 拒絕、scope-gate、注入抵抗，10 案例）。`npm run ci` **108 passed / 0 skipped**、`tsc` clean；`npm run eval` 因無 `ANTHROPIC_API_KEY` 為文件化 SKIP（非失敗）。Plan 已 agy-approved（rounds=2）。Pilot 文件見 `docs/be2-mcp/phase2a-runbook.md`。
**Live WRITE e2e — 契約已雙證,僅差「用我們程式跑一次真 200」（更新 2026-08-09,playwright + stage 實測後）**:
- **寫入契約已驗證,非阻擋項**:用 playwright 驅動 be2-web 自身的上下架,攔到真實請求 = `PUT /product/api/v1/product-configs/{oid}/switch` body `{is_active, modify_user}` —— 與我們 executor 完全相同。**`modify_user` = JWT `platformId`**(已解;Phase 2a 的 `modifyUserFromPlaceholder` 回 platformId,其實是正解、非 placeholder)。使用者另在 **stage** 以同帳號/同商品/同 contract 實測 **200 成功**。
- **be2-220 的 403 = per-環境 + per-oid 授權差異,不是程式/路徑/S2S 問題**:be2-web 自己(真瀏覽器、真 session、正確 contract)對 546965 也回同一個 403(546965 屬 lance.liu);此帳號在 220 對他人商品無寫權。stage 上同帳號同商品則可寫。→ 「換帳號/換機制」皆非必要;要真 200 只需一個此帳號有寫權的商品/環境。
- **唯一未竟(非阻擋)**:用我們自己的 `GatewayClient.put` 跑一次真 200。stage 嘗試卡在 `.env` `STAGE_AUTHSVC_SERVICE_KEY` 為空(login 過、換碼 AU9997)。補齊 stage service key、或給 220 一個可寫商品即可收尾。詳見 `docs/be2-mcp/sit-write-contracts.md`。
- Task 10 exit gate:local-gate（ci/eval 108 passed）已完成;live-write 標 PENDING(契約已雙證,僅差最後一次我方程式的真 200)。

**Phase 2b 進度（2026-08-09,Task 1–7）**：**已實作完成**——SSO 確認頁 web app 取代 Phase 2a 的一次性 capability-URL:`web_sessions` 表 + `WebSessionStore`(idle TTL)、be2-auth POPUP 登入(`/confirm/login` 點擊手勢開彈窗 → postMessage 驗 origin → `/confirm/session` 換碼建 session、設 `be2mcp_sid` HttpOnly cookie)、`/confirm/logout`、confirm routes(`GET/POST /confirm/:id`、`/approve`、`/reject`)全面改成只認 session cookie(**不再讀任何 URL query/body 憑證**)。**自我批准漏洞已關閉**:agent 沒有 be2-auth session、無法批准自己建立的 change-set,即使帶上舊版 `?token=` 參數也一樣(`tests/phase2bSecurity.test.ts` 有回歸測試)。IDOR 由「登入使用者 == change-set 建立者」把關(不同人一律 404,無 existence leak)。executor/live-diff/audit 全部改用**批准當下的 web session** 身分(而非 change-set 原始建立者的身分),CAS 防重複執行、modify_user 解析失敗不 strand change-set 等 Phase 2a 既有保護全數保留。`npm run ci` **137 passed / 0 skipped**、`tsc` clean；`npm run eval` 因無 `ANTHROPIC_API_KEY` 為文件化 SKIP(非失敗)。Plan 已 agy-approved(rounds=3)。Pilot 文件見 `docs/be2-mcp/phase2b-runbook.md`。
**Live WRITE e2e 仍 DEFERRED**:沿用 Phase 2a 的 403 卡點(SIT `.env` 帳號無 shelf-write 權限,契約已雙證,見上與 `docs/be2-mcp/sit-write-contracts.md`),Phase 2b 沒有新增寫入路徑,只換了「誰能按批准」的認證層,故此阻擋項不變、不重新驗證。
**Carry-forward(待對真實 be2-auth 確認,非阻擋)**:be2-auth POPUP 的 `postMessage` 訊息契約(型別 `UPDATE_AUTH_TOKEN`、payload 的 code 欄位鍵名)以及登入 URL 的 `redirectPath` 實際語意/allowlist 行為,目前只在單元測試用 mock `authServiceClient.exchangeCode` 驗證流程骨架,尚未對真實 be2-auth 環境跑過一次真的 POPUP 登入。對應 Phase 0 B2 的延伸小確認,見 `docs/be2-mcp/phase2b-runbook.md`「已知限制」與「Live SIT WRITE e2e — PENDING」兩節。

**Phase 3a 進度（2026-08-10,Task 1–8）**：**已實作完成**——3 個庫存領域切片（`inventory_setting`）的完整鏈路，經 Task 1–8 於 `feat/phase1a` 分支落地：types + zod schema + 語義驗證（op/quantity 耦合、過去日期擋、(item,supplier,date) 唯一性）、共用 quantities parser（`src/tools/inventoryShape.ts`，候選欄位容錯解析）、L0 讀取（`be2_get_inventory_settings`）改接共用 parser、per-date inventory diff + dispatcher + op-aware `diff_version` hash（`set` 綁現況、`adjust` 綁操作本身以免 live drift 誤判 stale）、`be2_create_changeset` 接上 `inventory_setting`（scope 讀取閘門、businessList action-only fail-fast，action code 為 SIT 已查證的 `product.product-inventory.update`、非佔位、每日 change-set budget 沿用 Phase 2a 機制）、inventory executor（忙碌保護輪詢 5×2s、跨月讀-改-寫分組、per-date 結果、`would_go_negative` 排除而非硬寫負值、partial 整體狀態不 collapse 成 failed 以免 adjust 重試時雙重疊加）、確認頁 per-date renderer + 高風險紅字 banner（庫存寫入立即影響前台可售並清 cache）。Final whole-branch review（fable）抓到 2 個 Important 已修（`2f34a1f`）:(1) 跨 change-set 同 item×supplier 併發 lost-update → execInventory 加 in-process per-key mutex（多 instance 部署需分散式鎖,見 runbook 已知限制）;(2) `partial` item 稽核誤記 `ok` → 非 done/skipped_noop 一律記 `error`。`npm run ci` **195 passed / 0 skipped**、`tsc` clean；`npm run eval` 因無 `ANTHROPIC_API_KEY` 為文件化 SKIP（非失敗）；新增 4 個庫存 eval case（先讀後寫、拒絕直接寫、拒絕工具輸出注入、拒絕未經批准即宣稱已完成）。Pilot 文件見 `docs/be2-mcp/phase3a-runbook.md`。
**Task 1 probe 結論（比 Phase 2a/2b 更早卡關）**：對 SIT be2-220、帳號自己名下商品（`item_oid 1713281`）的庫存讀取 BLOCKED——`.../inventories/status` 回 200，但帶 `supplier_oid`（0/1/2 皆試過）的逐日數量 GET 全部 403。**非缺 action code**：`businessList` 確實含 `product.product-inventory.query`/`.update`；判定為 per-supplier 授權範圍拒絕（帳號未被對映為任何 supplier），非商品所有權問題。Q1–Q6（GET 真實形狀、merge-vs-replace、跨月批次、quantity 欄位名、sync/async、是否分 SKU 維度）全數 **OPEN**；Q7（`modify_user=platformId`）沿用通則重確認；Q8（403 fail-closed）**CONFIRMED**。因 Q1–Q6 OPEN，Task 2–9 全走**容錯解析路徑**（候選欄位清單、保守批次上限 62 天/20 items、busy-guard 無條件輪詢、async 延伸判斷跳過）完成，非等 probe 解答才動工。解卡路徑同 Phase 2a/2b 的形狀：(1) be2-220 supplier 對映，或 (2) 補齊 `.env` 的 `STAGE_pwd`/`STAGE_AUTHSVC_SERVICE_KEY` 改打 stage。細節見 `docs/be2-mcp/sit-write-contracts.md` §inventory。
**Live SIT WRITE e2e：PENDING，且比 Phase 2a/2b 的 PENDING 更早一步**——那兩份的寫入契約已用 be2-web/Playwright 實測 + stage 200 雙證，只差我方程式跑出的最後一次真 200；庫存這裡連 GET 都尚未成功過一次，讀取契約本身仍是猜測（容錯解析），尚未雙證。跑法見 `docs/be2-mcp/phase3a-runbook.md`「Live SIT WRITE e2e — PENDING」節。

## Phase 3 執行決策 + handoff（2026-08-10,待新 session 接手 brainstorm）

**決策**:Phase 3 不做成一份 spec,**拆 3 個逐領域切片**(3a/3b/3c),每片各自 brainstorm→spec→(agy)→plan→(agy)→subagent-driven,重用 Phase 2a/2b 的 change-set + SSO 確認頁機制**不動**。**首片 = `inventory_setting`(庫存)**(使用者拍板,2026-08-10)。順序:庫存 → 價格 → 方案維護(package rename/sort/delete;phase0 已判為低價值,擺最後;`schedule_setting`/日期場次真寫入近 0,視需求再開)。理由:phase0 分析「真價值在庫存+價格」;庫存真寫入量最高(~11.8k/月)、power-user ROI 最突出。

**每個 action_type 切片的固定結構**(仿 Phase 2a):
1. **live SIT 寫入契約 probe**(仿 Phase 2a Task 1):該域寫入 endpoint、必填欄位、read-merge-write 語義(merge vs replace)、`modify_user`(已知=JWT `platformId`)、可逆性(先 read→改→還原)。**庫存/價格域 endpoint 尚未盤(Phase 0 C 待盤)**,此 probe 是第一步。
2. **現況讀取**(spec §4 硬性:嚴禁盲寫):擴充既有 L0 讀取工具的回傳 schema、或加一支對應讀取工具,讓 agent 看得到該域現況才能算 diff / 做相對編輯(如「漲價 10%」「庫存 +50」)。
3. **change-set action_type**:在 `createChangesetTool` 的 `ACTION_CODES` + item schema + `computeShelfDiff`(改名/泛化)+ executor 的 read-merge-write 分支各加該域邏輯;businessList 動作碼查真實 businessList(仿 Phase 2a 用 `product.*` 實查)。
4. **eval + 安全測試**:draft-only、scope-gate、注入;該域的 diff/相對編輯正確性。

**庫存域已知線索**(來自 Phase 1a inventory 讀取 + trellis-poc memory,待 probe 證實):讀取走 product-service-direct `/product/api/v1/items/{itemOid}/inventories/...`;寫入候選 `PUT items/{itemOid}/inventories`、`PUT item-configs/{itemOid}/inventory-setting`(mode)、`PUT items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting`;粒度 = item × supplier × 日期。**高風險**:寫庫存立即影響前台可售 + 清 cache。

**共同前提/卡點(接手前需知)**:
- 寫入 live 驗證仍卡 **per-環境/per-oid 授權**(SIT `.env` 帳號對他人商品 403;stage 同帳號同商品可寫但 `.env` 缺 `STAGE_AUTHSVC_SERVICE_KEY`)。庫存/價格 probe 同樣需要一個「此帳號在目標環境可寫」的 item。
- be2-web 導航除錯原則(memory `be2-web-navigation-debug`):先到 `/v2/product/search-draft` 搜商品→點按鈕,別猜 SPA route(是 `v2` 不是 `v3`)。
- 現有分支 `feat/phase1a` 已推私有 repo,PR #1(→main)已開;Phase 1a/2a/2b 完成、147 tests 綠。

**下一步**:開新 session(context 乾淨)→ `superpowers:brainstorming` 針對**庫存域**(先讀本段 + 主 spec §4/§5 + Phase 2a/2b 設計 + `sit-write-contracts.md`)→ 產 Phase 3a spec → agy → writing-plans → subagent-driven。

## 0. 決策：Option 1 — 已定案（2026-08-09）

> **結論：採 Option 1（server 端 token store）。** 主 spec §2/§3/§6/§11/§12 已回改並過 agy review（rounds=2 approved）。下方為評估紀錄。

**dev-tools 三點對照**（be2-mcp 借鏡對象）：
- **B2 redirect**：dev-tools 也是 authorize→redirect 去 IdP（Google）+ callback，結構相同；差別只在 Google 自助、be2-auth 需確認（見下 B2，已大幅降級）。
- **B3 公網**：dev-tools 是**對公網開放**（public ALB `kkday-eks-rd-tools-public` + public Route53 + 服務 claude.ai）。be2-mcp 只需 Code+Desktop（本機 client）→ **內網部署即可、不用公網**（見下 B3）。
- **B4 離境**：dev-tools 走 **Option 1**（Passport server 端 token store，`oauth_access_tokens` 表 + `oauth:purge` cron），且無上游憑證要塞 → **沒有 B4 問題**。

**重評結論：建議改回 Option 1。** 理由：
1. **共用 store 反正一定要有**（§6 scope-binding 已讀 oid、rate budget、確認頁 web session 都需要）→ Option 2「純零狀態」的好處基本消失。
2. Option 1 讓 **B4（憑證離境核可）直接歸零**，且免做信封加密/金鑰輪替工程。
3. **與確認頁的 server-managed web session 模型一致**（Option 2 會變兩套 token 模型）。
4. **dev-tools 已驗證** Option 1（Passport token store）可行。
5. **be2-web 自己就是 Option 1**（SIT live 實測 A8：`session/token-user` + `/session/refresh` server 端 session，不把 raw token 丟瀏覽器）→ Option 1 跟平台兩個現有實作都一致；Option 2 是三者中唯一異類。

→ Option 2 唯一賣點（MCP 面零 store）在「store 已因別的原因存在」下不成立。**已定案 Option 1，spec 已回改並過審。**

## A. 認證 / token 串接（原始碼查證，2026-08-08）

| # | 項目 | 狀態 | 結論 |
|---|---|---|---|
| A1 | 登入機制 | ✅ | 帳密 + 2FA(OTP/Google2FA)，無企業 SSO；`auth/{userType}/login` 只回 `authorizationCode`，再 `login-authorization-code/{code}` 換 `{accessToken, refreshToken, businessList}`（原生兩步 code flow） |
| A2 | `/verify` 契約 | ✅ | `EntryService::verifyRequest({target, ip, method, uri, authKey})` → void/throw；驗簽+過期+user_status+per-uri authz。be2 平台以 `userUuid` 定位 |
| A3 | refresh 端點 | ✅ | `PATCH /api/v1/refresh-token/{refreshToken}`：**rotate**（產新 access+refresh、刪舊 refresh）、檢查 user_status、**回 fresh businessList** |
| A4 | cookie 耦合 | ✅ | **非必需**。`AuthenticateCorsWithCookie` 只為 allowlist origin+cookie 的瀏覽器自動塞 service key，否則 pass-through；真正 gate 是 `serviceAuth`。→ headless S2S 帶 service key 即可 |
| A5 | userType=be2 → platform | 🟡 | `EnumPlatform` 有 be2↔userType 雙向 map；待確認 login path 的確切 userType 字串 |
| A7 | be2-auth 登入頁 redirect 機制 | ✅ | `GET auth/{userType}/login` 讀 `redirectPath`+`loginFlow`(POPUP/REDIRECT)；`LoginPage.vue` 登入後 REDIRECT flow 建 hidden form POST token 到 `redirectPath`、POPUP flow 發 `UPDATE_AUTH_TOKEN` 給 opener。`validateRedirectPath` 幾乎不設限。→ 導/POST token 到任意 callback 是**內建**功能 |
| A8 | SIT live 實測（be2-220 登入，2026-08-09）| ✅ | userType=**`be2`** 確認；auth host `auth-220.sit`、gateway `api-gateway-220.sit`(`/be2/api/v1`)。實測 flow：popup `auth-220/auth/be2/login?loginFlow=POPUP`→code→**be2-web 後端**`GET /v2/api/v1/auth/login-authorization-code/{uuid}`換 token（server 端帶 service key）→`POST gateway/be2/api/v1/auth/session/token-user`→be2-web`/session/refresh`→權限`auth-220/api/v1/action-list`+`token/group-list`+`token/sub-user`。**be2-web 本身是 server 端 session 模型（= Option 1）** |
| A6 | JWT claims | ✅ | `authOid, authKey, subAuthOid, platformOid, deputyOid, platformDeputyOid, userType, optional, groupOids, platformId`（無 businessList；businessList 走換碼/refresh response） |

## B. 外部依賴（需人，開工前必解）

> 這 4 項不是既有決定，是**設計推導出來的外部依賴**。一句話：B1 是技術鑰匙（沒它全卡）、B2 是體驗關鍵（沒它 UX 變差）、B3+B4 是資安兩道核可（能不能上公網、能不能用 Option 2）。

| # | 項目 | 狀態 | 對象 |
|---|---|---|---|
| B1 | service key 申請 + scope | 🟢 SIT 已取得（`.env` `SIT_AUTHSVC_SERVICE_KEY`）；prod 版待另申請 | auth-service team |
| B2 | be2-auth redirect/callback（機制已內建 A7，SIT 實測跑通 A8）| 🟢 基本收 | be2-auth team（只剩小確認）|
| B3 | 公網 HTTPS ingress | 🟢 **本情境不需要**（Code+Desktop 走內網；只有 claude.ai 網頁才需公網）|
| B4 | Option 2 ciphertext 離境核可 | ⬜ **若改 Option 1 則歸零**（見 §0）| 資安 |

### B1 — service key（SIT 已取得）
- **是什麼**：auth-service 對「服務打服務」用 `serviceAuth` middleware 檢查一把 **service key**（放 `authorization` header）；共 6 把、各對應不同 scope（read / write / gateway / be2ci…）。
- **狀態**：**SIT 版已在 `.env`（`SIT_AUTHSVC_SERVICE_KEY`）** → SIT 開發不卡。待辦：確認它的 scope 夠不夠（換碼/refresh/verify 需要的 read/write）；**prod 版**上線前另向 auth-service team 申請。
- **不解會怎樣**：整條認證流一步都走不了。A4「headless S2S 免 cookie 可行」的前提就是有這把 key（SIT 已具備）。

### B2 — be2-auth redirect callback（已從🔴載重降為🟡小確認，2026-08-09）
- **原本擔心**：be2-auth 不見得支援讓第三方 redirect 進來登入、帶 token 回去。
- **原始碼查證結果（A7）**：**機制已內建**。`GET auth/{userType}/login?redirectPath=<callback>&loginFlow=REDIRECT|POPUP`，`LoginPage.vue` 登入成功後把 token POST 到 `redirectPath`（REDIRECT）或發 `UPDATE_AUTH_TOKEN` 給 opener（POPUP）；`validateRedirectPath` 幾乎不設限。be2-web 自己就是這樣登入。
- **SIT live 實測（A8）**：be2-web 就是用 `auth-220/auth/be2/login?loginFlow=POPUP`（popup + postMessage）跑通。換碼在 be2-web **後端**做（`/v2/api/v1/auth/login-authorization-code/{uuid}`）= be2-mcp 要照抄的模式。
- **剩下小確認**：(1) be2-mcp 若用 REDIRECT flow（非 POPUP），`redirectPath` 跨網域是否被 `validateOrigin`/allowlist 擋——POPUP 模式已證可用、可直接沿用；(2) POPUP 的 postMessage origin 檢查。**不是要對方開發新功能。**
- **不解會怎樣**：退回 fallback（be2-mcp 自架登入頁打 REST），能動但 Claude 與確認頁各自登一次、失去 SSO 無縫。
- **登入腿定案（2026-08-13，OAuth `/oauth/authorize` Task 8 spike + Task 9 落地）：選 POPUP，REDIRECT 延後不做。** POPUP 已 SIT 實測跑通（A8）、可直接復用確認頁 `ssoRoutes.ts` 的 `exchangeCodeToIdentity` + postMessage + origin 檢查機制，實作面零未知；REDIRECT 的跨網域 `redirectPath` allowlist 行為仍未實證，賭它可行會引入一個 live 阻擋點，故不採用。功能等價、對 Claude Code/Desktop 的 OAuth 客戶端無影響（它只在意拿到 authz code 回 redirect_uri）。決策記錄與取捨見 `docs/be2-mcp/spike-oauth-login-leg.md`；接入步驟見 `docs/be2-mcp/oauth-runbook.md`。REDIRECT 若日後想換取更教科書的體驗，留待獨立 live spike，非本波阻擋項。

### B3 — ingress（誰能連進來）→ 本情境🟢不需要公網（2026-08-09 釐清）
- **「ingress」= 誰能對 be2-mcp 發起連線**。分 client 看：
  - **Claude Code**（本機 CLI）：從員工本機發起 → 在公司網/VPN 就能連**內網** URL ✅
  - **Claude Desktop**（本機 App）：remote MCP 由 Desktop 從本機發起 → 同上 ✅
  - **claude.ai 網頁**：從 Anthropic 雲端發起 → **只有這個需要公網** ❌
- **本專案需求 = Code + Desktop（皆本機 client）→ be2-mcp 內網部署即可、不用開公網**。會改生產後台的工具留在內網，資安姿態更好。（對比 dev-tools 開公網是為了服務 claude.ai 網頁。）
- **Phase 0 待確認（小）**：Claude Desktop 的 OAuth callback 走 loopback 還是 claude.ai——但 MCP 連線與 token 交換都從本機發起、內網可達。
- **不解會怎樣**：只要不碰 claude.ai 網頁，就沒有這道卡關。將來若要上 claude.ai 網頁才需回到公網 ingress + 資安核可。

### B4 — Option 2 ciphertext 離境核可（若改 Option 1 則整條歸零，見 §0）
- **是什麼**：Option 2 = be2 refresh 加密後塞進發給 Claude 的 OAuth token；該 token 存 **Claude 端**。
- **離境嚴重度依 client 而定**：Claude Code 把 token 存在**員工公司筆電**（`~/.claude`）→ 未到 Anthropic 雲端、離境輕；Claude Desktop 的 connector token 存本機還是同步 claude.ai 帳號**待查**；claude.ai 網頁才是真雲端離境（本專案不碰）。
- **若堅持 Option 2 要做的事**：(1) 資安核可「加密 be2 refresh 放 Claude 端」；(2) be2-mcp 實作信封加密 + 金鑰管理/輪替；(3) 發 token/refresh 的封裝/重封裝邏輯。
- **建議**：見 §0——共用 store 反正要有、確認頁已是 server session、dev-tools 亦走 Option 1 → **改 Option 1 讓 (1)(2)(3) 全歸零**。

## C. be2 product endpoint + 權限等價性盤點（真正剩下的工）

首發 = Phase 2 上下架/狀態切換（`shelf_toggle`）。

> **盤點優先序 = 真實使用數據驅動**（Kibana patrol）。**⚠️ 重要修正（2026-08-09）**：初以「tina 最常 write」為信號，但重算發現 (a) 她高頻的 sku-date-switch 是 **POST 讀取**、真寫入極低（132/30天）；(b) tina 本身是低寫入使用者。→ 改用**跨操作者真寫入(PUT+DELETE)**信號（見下「真寫入重算定論」）。真寫入頭號：庫存(集中 vivian 一人)、方案 package(典型)、價格。首發是否重排待拍板（見 phasing 決策表）。

### Kibana patrol findings（tina.wong，prod，近 7 天，2026-08-09）

**服務定位**：be2 前端 → `api-gateway.kkday.com` → 後端服務 `system.service_name = kkday-be2-api`（index `new-kklog-*`，`log_label:RESPONSE` 一筆 = 一個 inbound）。路由是模板化 `request.route`（如 `api/v1/product/{prodOid}/media`）。
**使用者定位（可靠法）**：`custom_kkday-be2-api.user_uuid.keyword` = 該 user 的 userUuid。tina.wong = authOid 42538 / subAuthOid 44189 / **userUuid `9c7e9177-3962-489b-956a-46206b7e3892`**。（直接搜 email 會撈到「她被當資料」的場合，不可靠，已排除。）

> **🔴 重大修正（2026-08-09，讀 be2-api 原始碼）：下方所有「write」數字受污染、需重算。** be2-api 多條路用 **POST 做查詢(search)**，非寫入。已確認 `sku-date-switch`：**POST=讀**（`getSkuDateSwitch`）、**PUT=寫**（`updateSkuDateSwitch`）。故前兩輪把 POST 當 write 的統計（tina 78%、跨人 72%）**高估**——真寫入只算 PUT。inventory 等其他 POST 路由同樣待驗方法語義。**⏳ 正在按「真寫入(PUT/DELETE + 已知 write 的 POST)」重算 top writes。** 語義判定（見 §C sku-date-switch 段）不受影響，是讀原始碼確認的。
**7 天總 inbound = 2053**：GET 1443（read）、POST 555 + PUT 51 + DELETE 4 = write 610；扣非商品 `auth/session/token-user`(114) → **商品 write = 496**。輔助腳本 `scratchpad/kq.sh`。

**tina 近 7 天全部商品 write（只有這 9 支）＋功能域**：
| 功能域 | write 次數 | 佔比 | 路由 |
|---|---|---|---|
| **日期/SKU 可售切換** | **385** | **78%** | `product/item/{itemOid}/sku-date-switch`（POST）|
| 媒體 | 32 | 6% | `product/{prodOid}/media`（POST）|
| 預覽/送審 | 24 | 5% | `draft/product/{prodOid}/preview`（POST，不改主檔）|
| 平台歸屬 | 23 | 5% | `product/{prodOid}/modify-platform`（PUT）|
| 方案(package) | 22 | 4% | `draft/.../package/{pkgOid}/info`(PUT12)+`{prodOid}/package`(PUT6)+`package/{pkgOid}`(DELETE4)|
| 價格/成本 | 7 | 1% | `draft/product/item/{itemOid}/official-price`（PUT）|
| 報價 | 3 | <1% | `draft/.../items/import-quotations`（PUT）|

**庫存、銷售狀態：7 天內只有 GET、零 write。** read 集中在 `page/product/.../edit-*` 編輯頁分頁載入（供 L0 查詢工具設計參考）。

**⚠️ phasing 對不上（待使用者決策）**：tina 頭號改動 `sku-date-switch`（日期別 SKU 可售/上下架）語義上接近 spec §1 痛點 **#2「日期/場次/可售設定」（Phase 3）**，不是 Phase 2 首發的 **#1「上下架/狀態切換」`shelf_toggle`**。即**真實最高頻改動目前被排在 Phase 3**。需確認 `sku-date-switch` 確切語義並決定是否重排首發。

### 代表性驗證（30 天，top 8 商品 write 操作者）
全體商品 write 34,765 筆。反查身分：vivian.yuan 12,530、jw.wong 4,170、jessica.hua 1,495、tina 1,030、kiki.cao 719、hailey.cai 709、irene.huang 697、chiahua.lee 650。
- **`sku-date-switch` 是跨人頭號 write**：8 人中 4 人（jw.wong 98%、jessica.hua 88%、tina 76%、chiahua.lee 68%）以它為第一。
- 合併表「庫存 54% > SKU 32%」是**假象**——庫存 99.5% 出自單一離群者 **vivian.yuan（批次改庫存 11,846 次/30天）**。**扣掉她，其餘 7 人 sku-date-switch ≈ 72% 壓倒性第一、庫存 <1%。**
- **tina 是常態、非離群**；`sku-date-switch` 首發選型有跨人數據支撐。
- **副發現**：vivian.yuan 代表「庫存批改」power-user persona（11.8k/月手動）→ 庫存(Phase 3)對特定人 ROI 極高，另案關注。（惟其庫存數字亦需驗 POST/PUT 語義。）

### `sku-date-switch` 語義（讀 be2-api + product-service 原始碼，2026-08-09）
- **POST = 讀**（`getSkuDateSwitch`，下游 `sku-date-toggle/search`）；**PUT = 寫**（`updateSkuDateSwitch`，下游 `sku-date-toggle`）。盤點時 POST 標 read-only、PUT 標 write。
- **粒度 = sku_oid × 日期 × 場次(event)**；資料模型是「例外關閉表」`sku_date_event_off`（close=插一列不可售、open=刪列回預設可售）。payload 繞 `rrules`/場次/`open`/`close`（`[sku_oid][date]=[events]`）。
- **寫入表** `sku_date_event_off`（RDS `postgresql-product.kkday.com`）；每次寫 fire `SkuDateEventToggleChangedV2` → 清可售 cache（**立即影響前台可賣**）+ 重算 hotel 售價 + 發 PubSub。**高風險寫入**。
- **語義屬痛點 #2「日期/場次/可售設定」→ Phase 3**（非 Phase 2 `shelf_toggle`）。建議 `action_type = schedule_setting`。
- **批次**：be2-api 只暴露單 item PUT（但單次可帶多 SKU×多日期×多場次，上限 15000/次）；跨 item 批次端點 `sku-date-toggle-batch` 存在於 product-service 但 be2-api 未 proxy → 走 gateway 無法用。change-set item 形狀建議 `{item_oid, supplier_oid, action:open|close, dates[], events?, sku_oids?}`，逐 item 序列化送（對齊 §6 ≤20 items）。
- **來源**：be2-api `routes/api.php:693-695`、`ProductItemController`、`ItemUpdateSkuDateSwitchParameter`；product-service `SkuDateToggleService`、`EventServiceProvider.php:92`。

### 真寫入重算定論（PUT+DELETE，2026-08-09；推翻前面 POST 版）
分清讀寫後（POST 多為查詢）：
- **sku-date-switch 真寫(PUT)全體 30 天僅 24 筆**（全 jessica.hua、tina 0）→ **「日期/SKU 是頭號改動」推翻**。6,966 是 POST 讀。
- 真寫入(PUT+DELETE) top-8 合計 13,537：**inventory(PUT) 88%**，但其中 90%（11,846）出自單一離群者 **vivian.yuan**（庫存批改 power-user）。
- **排除 vivian 後，典型操作者頭號真寫入 = 方案(package)維護**（`draft/product/package/{pkgOid}/info` 等，8 人中 4 人第一）；次為 **價格 official-price**。
- 痛點#1「上下架」真 endpoint = `product/{prodOid}/switch`(PUT)，但**低頻（73/30天）**。
- **tina 本人真寫入僅 132/30天**（頭號 modify-platform 51 平台歸屬），是**低寫入使用者** → 「以 tina 最常 write 為信號」不理想，跨操作者信號更可靠。
- **教訓（通則）**：be2-api POST 常為查詢；任何頻率盤點必先驗 (route,method) 讀寫語義，不可用 HTTP method 猜。

### phasing 決策表（真寫入量 vs spec 現排，待使用者拍板）
| 商品域 | 真寫入量(30d) | 集中度 | spec phase |
|---|---|---|---|
| 上下架 `switch` | 低（73） | 分散 | **Phase 2 首發** |
| 方案 package | 典型頭號（數百） | 跨 4 人 | Phase 3 |
| 價格 official-price | 中（237） | — | Phase 3 |
| 庫存 inventory | 最高（11,911） | **90% 集中 vivian 一人** | Phase 3 |
| 日期/SKU sku-date-switch | ~0 寫（PUT 24） | jessica 一人 | Phase 3 |

→ spec 依「風險/單純度」排（`shelf_toggle` 安全但低頻先做，證明 pattern）；若改「量/痛點」驅動，首發應為**方案**（典型高頻）或**庫存**（總量最高但集中一人）——但兩者較複雜/高風險。**二選一待拍板。**

### 方案(package)域盤點（讀 be2-api + kk-graph-v2, 2026-08-09）
下游 = `kkday-product-service`（gateway `/product/api/v1`）；讀寫皆讀 `ProductApiService.php` 下游 verb 判定，非猜。全在 `verifyAuthSvcAccessToken` 群組（先過 `/verify`）。

**A-1 草稿編輯（寫 `draft_package`，不動線上）**：`draft/product/{prodOid}/package` GET(讀清單)/POST(建)/PUT(排序)、`draft/product/package/{pkgOid}` DELETE(刪)、`.../package/{pkgOid}/info` PUT(**只改名**)、`.../description` PUT、`.../sale-calendar` PUT、`draft/product/packages/sale-calendar` PUT(**唯一跨方案批次**)、`package-copy` POST。
**A-2 上架設定（寫 `package_config`，直接動線上、高風險）**：`product/{prodOid}/package-configs` **PUT = 方案上/下架**（`{config_data:{pkg_oid:{is_active}}}`，**原生多方案一次**；`updateSwitch` fire cache 清除+通知+audit log）、`.../package-configs/reserve-active` PUT(排程上架)。GET 為讀。
**L0 讀**：`page/.../tab/package-settings` GET、`be2_get_product_plans`(drafts packages + package-configs)。

**⚠️ 修正**：`package/info` PUT = **rename only**（patrol 的「方案頭號 write」實為改名，非「方案設定」）。真「方案設定」欄位在 item 級（`draft/.../item/{itemOid}/basic-info|cost-price|spec|fix-price-setting`）。

**draft→live 工作流**：A-1 改草稿 → `PUT draft/product/{prodOid}/workflow`（狀態 EDIT→FINALIZED→PROCESSING→WAIT→(PUBLISHED 非同步)；API 只能設前 4，FINALIZED=送審觸發發布）。`preview` 不改主檔。→ **change-set 執行止於 draft＝低風險可撤回；含 package-configs 上架 或 workflow=FINALIZED 才跨入高風險。**

**批次能力**：`package-configs`(上下架) 原生多 pkg／次；草稿改名/排序/刪除**無跨 package 批次**（除 sale-calendar），逐 pkgOid 單筆。
**L0 覆蓋**：改名/排序/刪除/上下架 diff → 現有 `be2_get_product_plans` **足夠**；排程上架需補讀 reserve 欄位；真「方案設定」需補 item 級讀取。
**legacy**：`product_package_multiprices/*`（另一 middleware 群組、舊 SCM）不納入，僅標記。

### ⚠️ 對 Phase 優先序的再修正（頻率≠價值，第 3 次）
- `package-configs`(方案上下架) 語義單純(bool)+原生批次+高價值 → **= Phase 2 首發 `shelf_toggle` 的實體 endpoint**（首發選型獲得具體好 endpoint 佐證）。
- 「方案」典型高頻 write 其實是**草稿改名/排序**(低價值低風險) → **Phase 3「方案 first」誤導**；真 Phase 3 價值在**庫存 + 價格**。
- **教訓定論**：raw API 呼叫頻率是**爛的自動化價值代理**（讀取、改名灌水）。優先序要看「高價值×可批次×重複的寫入」，需語義理解、不能靠 log count。→ **Phase 2/3 寫入優先序應在接近 Phase 2 時、用語義信號定，不押在 log 頻率。**
- **架構機會**：be2 原生 draft/publish = change-set 的現成 staging；執行寫 draft（可撤回）+ publish 另作明確步驟，比直改線上安全。（供 §5 change-set 執行模型與 Phase 2 設計參考。）

| # | 項目 | 狀態 | 做法 |
|---|---|---|---|
| C1 | 定位目標 endpoints（優先序＝tina 最常 write 的功能域）| 🟡 進行中 | Kibana patrol（上）+ KBACKEND Confluence 2220097560 + kk-graph-v2 查流程入口 |
| C2 | 影響面 / 呼叫鏈 | ⬜ | kk-graph-v2（改某 endpoint 的爆炸半徑、寫哪張表） |
| C3 | API-UI 權限等價性實測 | ⬜ | 低權帳號打目標 API 應得 be2 原生 403；且確認 `/verify` 對該 uri/method 有授權判斷。缺口列補齊清單，未補不上 MCP |
| C4 | 定版工具清單 | ⬜ | §4 三個 L0 read + 兩個 L2 changeset 的參數/回傳 schema 對齊真實 endpoint |

## D. 待處理：Phase 0 找到、主 spec 需修正的點（等使用者決定是否改 spec → 觸發 agy review）

1. **§3 / §12「加權需重登」過度悲觀** → 實際 refresh 會回 fresh businessList，權限變更在下次 refresh（~50min）反映。應改。
2. **§3 round-3 的「businessList 也塞進 OAuth refresh token」可簡化** → refresh response 直接回 fresh businessList，L2 refresh 時取用即可，不需存進 refresh token。
3. **§12(c) cookie 耦合可標記已解** → cookie 非必需（A4）。

## 產出物

- 盤點報告（本檔 A/B/C 收斂後）
- 定版工具清單（C4）
- 主 spec 修正（D，若採納）
