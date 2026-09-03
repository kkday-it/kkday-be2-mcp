# be2 MCP — 盲點盤點與開發者對焦清單

日期：2026-08-18　狀態：外部 review 產出，**每條待與開發者對焦後才動手**
> 方法：對 `main`（HEAD `c7ce52c`）做對抗式 code review，聚焦三條軸——**安全性**、**AI 幻覺**、**上手度**。
> 每條附 `檔案:行號` 證據，可自行複驗；不確定的一律標「待確認」而非斷言。
> 搭配讀：`design-overview.md`（設計全貌）、`audit-logging-gap-analysis.md`（稽核 G1-G9，本文不重複）。

---

## 0. 怎麼用這份文件

每條的欄位固定為：**現象 → 證據 → 為什麼是問題 → 建議修法 → 待拍板的問題**。
「待拍板的問題」是需要人決定的部分（取捨、優先序、要不要接受殘餘風險），不是技術細節。

優先級判準：
- **P0** = 打穿了對外宣稱的安全不變式，或上 production 前必擋。
- **P1** = 會讓使用者/主管對系統失去信任，或與價值主張矛盾。
- **P2** = 已知殘餘風險，該登錄在案並在文件講清楚，不一定要改 code。

---

## 1. 總表

| # | 軸 | 標題 | 級別 |
|---|---|---|---|
| S1 | 安全 | `APP_DEV_PANEL=1` 讓兩個無認證 curl 完成自我批准 | **P0** |
| S2 | 安全 | dev panel 鑄的 static_bearer 是**永久憑證且 secret 寫在 repo 裡**，flag 關掉後仍有效 | **P0** |
| S3 | 安全 | dev panel 的測試只驗「能不能跑」，沒有任何測試斷言它不該能批准 | P1 |
| H1 | 幻覺 | `inventory_platform` 的 `affected_pkgs` 可被編造，且**逐列 provenance 遺失**（假列會顯示成已驗證） | P1 |
| H2 | 幻覺 | model 可見的 schema 收 5 種 action，但 tool description 只教 3 種——`inventory_platform` 完全沒說明 | P1 |
| H3 | 幻覺 | tool description 只講「開確認頁 SSO」，完全沒提面板通道；Desktop 使用者會被 agent 導錯路 | P2 |
| H4 | 幻覺 | 人看的權威畫面是面板/確認頁，但 agent 會在聊天視窗複述 diff——人若讀摘要就按批准，draft-only 退化成「按了沒看的東西」 | P2 |
| H5 | 幻覺 | `adjust` op 的批准語意是「核准一個運算」不是「核准一個結果」；live drift 不作廢批准（刻意設計，但認知落差真實存在） | P2 |
| U1 | 上手 | **速率上限與價值主張互相矛盾**：宣稱要解「單一 AM 單月 11,846 次」，但目前上限 = 200 項/日 | P1 |
| U2 | 上手 | 沒有「我今天改了什麼」的查詢能力——`change_sets` 沒有任何 list 方法，使用者只能逐個 id 查 | P1 |
| U3 | 上手 | be2 業務規則（如 131105）要逐條預檢才會變人話，這是無界長尾，目前只補了 1 條 | P1 |
| U4 | 上手 | Desktop 走 `mcp-remote` npx shim，已知三種故障根因；這是全公司推的第一道摩擦 | P2 |
| U5 | 上手 | `refresh` 12h → 每天必重登一次 OAuth | P2 |
| X1 | 擴展 | 「加 module 不碰 core」有 3 個破口：`types.ts` 封閉 union、description 硬寫、`batch-wizard.ts` 15 個分支 | P1 |
| X2 | 擴展 | `session_read_oids` retention 是 24h 而非 session 生命週期 → scope-binding 的保證比宣稱的弱 | P2 |
| X3 | 擴展 | `supplier_oid` 不進 scope 檢查 | P2 |
| X4 | 擴展 | `note`（人的意圖）進了稽核但**不顯示在批准畫面上** | P2 |
| X5 | 擴展 | SQLite migration 是手工 PRAGMA 偵測，沒有 version table | P2 |

---

## 2. 安全性

### S1（P0）`APP_DEV_PANEL=1` 打穿「agent 結構上無法自我批准」

**現象**：帶了這個 flag 起 server 之後，兩個無認證的 localhost POST 就能核准並執行任何一筆 pending change-set，不需要 SSO cookie、不需要人。

**證據**
- `src/server/app.ts:266-268` — flag gate，`process.env.APP_DEV_PANEL === '1'` 就掛 `/dev`。
- `src/server/devPanelRoutes.ts:50` — `router.post('/panel-tool', ...)`，**整個 handler 沒有任何 bearer / cookie / nonce 檢查**。
- `src/server/devPanelRoutes.ts:58-61` — 撈 `SELECT identity_id FROM be2_identities ORDER BY updated_at DESC LIMIT 1`，也就是「最近登入的那個人」＝剛示範登入的你。
- `src/server/devPanelRoutes.ts:75-80` — 用 `DEV_SESSION_ID = 'dev-panel-session'` 呼叫**任何一支** `APP_TOOLS`。
- `src/tools/appTools.ts:24-26` — `app_get_changeset_view` 對 `pending_approval` 的 change-set 直接把 `nonce` 放進回傳，bind = `(changesetId, diffVersion, sessionId)`。
- `src/tools/appTools.ts:66-70` — `app_confirm_changeset` 驗的就是同一組 bind。

**攻擊序列**（兩步，全部在 localhost）
```
POST /dev/panel-tool  {"name":"app_get_changeset_view","arguments":{"changeset_id":"X"}}
    → 回傳含 nonce + diff_version + 完整 diff（itemKey 自己算得出來）
POST /dev/panel-tool  {"name":"app_confirm_changeset",
                       "arguments":{"changeset_id":"X","decision":"approve",
                                    "nonce":"<上一步拿到的>","diff_version":"...",
                                    "confirmed_keys":[...]}}
    → nonce bind 相符（同一個 dev session）→ approveAndExecute → 真的寫進 be2
```
`confirmed_keys` 不構成障礙——第一步的回傳就含 diff。

**為什麼「local-only 所以還好」不成立**：這個專案的威脅模型第一條就是「防 agent 幻覺/惡意寫入」，而 agent 就跑在同一台機器上（Claude Code 有 Bash；Desktop 側任何一支帶 shell 的 MCP server 也有）。**localhost 在威脅邊界內側。** 換句話說：flag 一開，「agent 拿不到批准憑證」這個結構性保證就變成「agent 只是碰巧沒去打那個 endpoint」。

**加重情節**：`demo-guide.md` 風險備案表明確建議「demo 當天就帶著 flag 起 server，臨場切備案零等待」。

**建議修法**（三層，可分開採用）
1. dev panel 的可呼叫清單排除寫入類 app tool（`app_confirm_changeset`）——demo 備案的目的是「證明面板渲染正常」，不需要 approve 能力；而且 SIT 掛掉時寫入本來也會失敗。
2. `DEV_SECRET` 改成**啟動時隨機生成、印在 stdout**，不寫死在原始碼。
3. 加 regression test：`flag on 時 POST /dev/panel-tool app_confirm_changeset 必須被拒`。

**待拍板**
- 彩排（`demo-rehearsal-2026-08-16.md`）是靠這條 HTTP harness 跑完整寫入驗證的。若排除 approve，e2e 驗證要改走 vitest 進程內測試——**這個代價你接不接受？**
- 今天 demo 到底帶不帶 flag？（建議：不帶。真的需要備案時再現場加 flag 重起，10 秒的事。）

---

### S2（P0）dev credential 是永久的，而且 secret 公開在 repo 裡

**現象**：`/dev/panel-tool` 被打過一次之後，`Authorization: Bearer be2mcp_dev_panel_secret` 就是一顆對整個 `/mcp` 面有效的憑證，**server 重啟不帶 flag 也照樣能用**。

**證據**
- `src/server/devPanelRoutes.ts:17` — `const DEV_SECRET = 'be2mcp_dev_panel_secret'`（hardcoded，已進版控）。
- `src/server/devPanelRoutes.ts:62-72` — upsert `credentials(cred_hash, identity_id, kind='static_bearer', expires_at=null, ...)`。**`expires_at` 是 null。**
- `src/server/app.ts:273-278` — `/mcp` 的 bearer gate 就是 `credentials.getBySecret(bearer)`；行 275 的註解自己寫了「static bearer both resolve here — CredentialStore doesn't distinguish them by shape」。
- `src/auth/tokenManager.ts:41-44` — `getFreshByCredHash` 也不分 kind。
- `scripts/oauth-purge.ts` 清的是過期 `oauth_auth_codes`/`oauth_refresh` 與無引用的 ghost identity——**不會清這顆永不過期的 static_bearer**。

**為什麼是 P0**：這是「路由被 flag 關掉，但它鑄出來的憑證活得比 flag 久」。任何讀過 repo 的人（含未來的資安審查、含 contractor）都知道那個字串。

**建議修法**
- `expires_at` 改 `now + 30min`，且 process 退出前刪除該列（或改用啟動時隨機 secret，見 S1-2，兩者一起做最乾淨）。
- 加測試：`flag off 之後，舊的 dev credential 不得通過 /mcp`。
- **立刻的動作**：查一下 SIT 的 DB 現在有沒有這一列，有就手動刪。
  ```sql
  -- 先看
  SELECT cred_hash, identity_id, kind, expires_at FROM credentials WHERE kind='static_bearer';
  -- dev secret 的 hash 可用 node -e 算 sha256('be2mcp_dev_panel_secret') 比對後再刪
  ```

**待拍板**
- 彩排紀錄提到「曾誤將一顆 static bearer 印進終端，已即時撤銷」——那次撤銷有沒有連 dev panel 這顆一起處理？需要實查 DB 確認。

---

### S3（P1）dev panel 的測試把「能執行」當成通過條件

**證據**：`tests/devPanelRoutes.test.ts:47-86` 只有兩個案例——「flag off → 404」與「flag on → 面板 HTML 出來且 tool 跑得動」。**沒有任何案例斷言 dev 路由不該能批准、或不該鑄永久憑證。**
另外 `.env.example` 完全沒提 `APP_DEV_PANEL`，這個 flag 只活在 demo 文件裡——新人接手不會知道它存在。

**建議修法**：把 S1/S2 的兩條斷言補進這個測試檔；`.env.example` 加一行註明「此 flag 僅供本機 harness，永不用於 prod」。

---

## 3. AI 幻覺

> 先講好的部分：這一軸的防線其實是全 repo 最紮實的地方（見 §5）。以下是**殘餘**風險。

### H1（P1）`affected_pkgs` 的逐列 provenance 會遺失——編造的方案名會顯示成已驗證

**現象**：`inventory_platform` 的 `affected_pkgs`（會顯示在人要批准的畫面上的方案名稱清單）由呼叫者自報。程式碼已經意識到這點並做了 live 重算，但**重算是 union 不是取代**，所以一筆現實中不存在的自報項目會原樣留下，且因為讀取本身成功，不會被標記為未驗證。

**證據**
- `src/modules/product/inventoryPlatform/diff.ts:11-21` — 開發者自己的註解已經指出「entirely self-reported ... a low-balled list would let an approver believe the blast radius is smaller than it really is」。
- 同檔 `:29` — `const merged = new Map(reported.map(p => [p.pkg_oid, p]))`，**以自報清單為底**。
- 同檔 `:31-38` — live 讀到的項目用 `merged.set` 覆蓋同 `pkg_oid`；**live 沒讀到的自報項目留在 map 裡**。
- 同檔 `:37` — 讀取成功就 `unverified: false`。

**結論**：`affected_pkgs_unverified` 是**per-item 的全有全無旗標（只在整個讀取失敗時才立）**，不是 per-pkg 的來源標記。所以「讀取成功的 item 裡夾一筆假方案名」→ 在確認頁上與真項目長得一模一樣。

**注意這不是 XSS**：`renderer.ts:10` 有包 `esc()`，注入 HTML 不會執行。問題純粹是**語意欺騙**——人以為爆炸半徑是這幾個方案。

**建議修法**：`AffectedPkg` 加一個 `verified: boolean`，union 時保留來源，renderer 對未被 live 讀確認的列逐列標記（例如灰字 + 「未由 be2 確認」）。這比整批 flag 誠實。

**待拍板**：`affected_pkgs` 反正只是展示註記（真正寫入單位是 item×supplier），要不要乾脆**完全不信自報、只顯示 live 讀到的**？代價是 live 讀失敗時畫面上「受影響方案」會空白——但空白其實比顯示未驗證清單更誠實。

---

### H2（P1）schema 收 5 種 action，description 只教 3 種

**證據**
- `src/core/changeset/tools.ts:21` — `itemShape = z.union(listModules().map(m => m.itemSchema))`，**registry 裡全部 5 種都在 model 可見的 union 裡**。
- 同檔 `:27` — `action_type: z.enum(listModules().map(m => m.actionType))`，同樣是全 5 種。
- 同檔 `:110-124` — description 只說明了 `shelf_toggle_product` / `shelf_toggle_plan` / `inventory_setting` 的 item 形狀，`shelf_schedule` 只在「排程三要件」被提到但沒給 item 形狀，**`inventory_platform` 一個字都沒有**。

**為什麼是問題**：model 看得到 action_type 選項卻拿不到參數說明 → 只能猜 item 形狀。猜錯的好結果是 validation error（吵但安全），壞結果是**猜出一個通過 schema 但語意錯誤的 item**（尤其配合 H1 的自報欄位）。這正是幻覺熱點。

**建議修法**：description 從 registry 動態組出來（每個 module 自帶一段 `modelHint`），而不是手寫一長串。這同時解掉 X1 的第二個破口。

**待拍板**：`inventory_platform` / `shelf_schedule` 的設計意圖是不是「只能經精靈面板建立、不給 model 直接建」？如果是，那正確做法是**把它們從 model-visible union 裡排除**（面板走 `app_create_changeset` 自己的 shape），而不是留在 union 裡卻不說明。這是介面收斂問題，不是文案問題。

---

### H3（P2）description 講的批准路徑與實際的面板路徑不一致

**證據**：`tools.ts:112-116` 明確寫「returns NO confirm link. A human operator must open the confirm page for this change-set in a browser and log in via be2-auth SSO」——**完全沒提 MCP Apps 面板通道**。

**後果**：Desktop 使用者（面板已經彈出來了）會被 agent 告知「請去瀏覽器開確認頁登入」。demo 時這句話會直接跟你剛演的面板打對台。

**建議修法**：description 分岔講清楚兩條通道；或至少改成「透過面板或確認頁，由人核准」。

---

### H4（P2）聊天視窗的 diff 摘要 vs 權威畫面的 diff

**現象**：`be2_create_changeset` 回傳含完整 diff 給 model（`tools.ts:112`「Returns { changeset_id, status, diff }」），model 會在聊天裡複述。人若讀了聊天摘要就切去面板按批准，draft-only 的實質保護就退化成「人按了一個他沒真的看的東西」。

**這條沒有技術解，也不該有**（agent 拿不到 diff 反而做不了事）。它是**UX 與訓話**問題：
- 面板/確認頁必須是唯一被信任的來源，這句話要進 getting-started 與 demo 話術。
- 可考慮讓面板顯示「本畫面為權威內容，聊天視窗的摘要僅供參考」。

**待拍板**：要不要在面板上加一道「高風險批次需逐列勾選確認」（目前 `confirmed_keys` 機制已經支援逐列，但預設是全選）？

---

### H5（P2）`adjust` 是「核准一個運算」而不是「核准一個結果」

**證據**：`module-catalog.md` 的 `inventory_setting` 列寫明「`adjust` 綁操作（`dates`/`quantity`）——live drift 不作廢批准」；`renderer.ts:7` 也有寫「adjust 的目標值以批准當下的即時庫存重算」。

**這是刻意設計且已揭露**，但認知落差真實存在：人在畫面上看到「現量 100 → 目標 150」，批准時實際庫存可能已是 300，執行結果會是 350，而**批准不會因此作廢**（`set` 才綁現況）。

**建議**：確認頁對 `adjust` 列把「目標」欄改成 `+50（以批准當下庫存重算）` 而不是顯示一個會過期的絕對數字——顯示一個會變的數字比不顯示更容易誤導。

---

## 4. 上手度

### U1（P1）速率上限與價值主張直接矛盾 ⚠️ 最該先對焦的一條

**算術**
- `src/core/changeset/tools.ts:29` — 單批 `items` 上限 **20**。
- `src/limits/rateBudget.ts:44` — `consumeChangeset(userLabel, perDay = 10)`，且 `tools.ts:75` 的呼叫端沒有覆寫 → **每人每日 10 個 change-set**。
- 相乘 = **200 項/日**。
- `src/limits/rateBudget.ts:12-13` — 另有讀取上限 100/session、500/user-day。

**對照**：`be2-mcp-leadership-brief.md` §2 的價值主張是「近 30 天真寫入 top 操作者合計約 13,537 筆／30 天；單一 AM 單月手動改庫存 11,846 次」。11,846 / 30 ≈ **395 次/日**，是目前上限的兩倍。

**所以**：如果那位 AM 真的照現在的價值主張來用，**他第一天中午就會撞到上限**。而且 395 次/日在現行流程下代表 20 次人工核准點擊（395/20），談不上「一句話解決」。

**這是 P1 而不是 P0，因為它可能是刻意的 pilot 保守值。但它必須被明說**，否則 demo 上有人算這道算術會很尷尬。

**建議修法（三選一或組合）**
1. 明確定位成 pilot 節流值，寫進 getting-started「已知限制」，並給放寬路徑（改成 env 可配）。
2. 提高單批上限（20 → 100/200）並讓面板承擔逐列審閱——瓶頸從「批次大小」移到「人的審閱能力」，這才是對的位置。
3. 做 `next-iteration-eval.md` §3 的 macro tool，讓「一次意圖 = 一次核准 = 一大批」，把核准次數而非項目數當成治理單位。

**待拍板**
- 200 項/日是刻意的還是預設值沒調？
- 治理單位到底該是「項目數」還是「核准次數」？我的意見：**核准次數**。逐項限額會逼使用者把一件事拆成 10 次核准，反而降低每次核准的專注度——治理上是負作用。

---

### U2（P1）沒有「我今天改了什麼」

**證據**：`src/core/changeset/store.ts` 沒有任何 list/query 方法（只有 `get` / `getResults` / `casStatus` / `setStatus` / `updateDiff`）；model 可見工具只有 `be2_get_changeset_status(changeset_id)`——**要先知道 id 才查得到**。

**後果**
- 使用者無法問「我今天做了哪些變更」「上週那批下架成功了嗎」。
- 稽核也沒有自助查詢面（`audit_log` 只能手打 sqlite3），這條與 `audit-logging-gap-analysis.md` 的 G9 是同一個根。

**建議修法**：加一支唯讀 `be2_list_my_changesets(since?, status?)`（creator-bound，沿用既有 NOT_FOUND 無 existence leak 紀律）。零風險、對上手度回報極高。

---

### U3（P1）be2 業務規則的長尾

**證據**：`demo-rehearsal-2026-08-16.md` 發現 1 —— pkg 1944031 排「與現況相同」的狀態，be2 回 422 `131105`，而且原本的錯誤只顯示 `HTTP_422: gateway error`（排查多花 20 分鐘）。已修：diff 期預檢 + `GatewayClient` 認 be2 的 `meta`/`metadata` envelope。

**問題**：這類「be2 才知道的業務規則」是**無界長尾**，目前只補了 1 條。每一條沒預檢的規則 = 一次使用者看到天書錯誤訊息，或更糟：demo 當場炸。

**建議修法**
1. 短期：把 be2 error code → 人話的對照表抽成一份可增長的 map（現在的預檢是寫在 `computeScheduleDiff` 裡的一次性邏輯）。
2. 中期：module onboarding checklist 加一格「該 domain 的已知業務規則錯誤碼與預檢清單」，讓它跟著 module 一起長。

**待拍板**：要不要主動去 RD 那邊撈一份 be2 product 的 error code 清單，而不是等它一條一條炸出來？

---

### U4（P2）Desktop 的 `mcp-remote` 摩擦

`oauth-runbook.md` 已登錄三大故障根因（lockfile 殭屍 / 舊分頁重放 / session 重啟失效），`main` 最後一筆 commit（`d56cb82`, 8/17）就是在治第三條。這代表**上手第一關的失敗模式已知有三種**。對「推給全公司」來說這是硬傷，對 pilot 可接受。

**待拍板**：pilot 階段要不要乾脆只支援 Claude Code（原生 HTTP，不需要 shim）？Desktop 面板體驗好但接入脆——這是「先要體驗還是先要接得上」的取捨。

---

### U5（P2）每天要重登一次

`design-overview.md` §1.2：access ~50min、`refresh` 12h。所以隔天必然重跑 OAuth。對每天用的 AM 來說是每天一次 POPUP 登入。**這其實是安全設計的正確結果，不是 bug**，但要寫進 getting-started 讓使用者有預期。

---

## 5. 已驗證沒問題的（別重工）

這些我實查過，是好的，列出來避免開發者重複檢查：

| 項目 | 證據 |
|---|---|
| **確認頁 HTML escaping 完整** | `src/core/changeset/html.ts` 的 `esc()` 被 4 個 renderer 與 `confirmRoutes.ts` 一致使用；所有 be2 來源字串（`d.name` / `pkg_name` / oid / date / diffVersion）都包了。未包的只有數字與程式自產的字面值。**無 XSS。** |
| **nonce 設計** | `approvalNonce.ts` — 只存 sha256、bind 三元組、無論成敗都消耗（單次）、TTL 10min、issue 時惰性 sweep 防 Map 無限成長。 |
| **無 existence leak** | `appTools.ts:9` — 「找不到」與「存在但非本人建立」回同一種 NOT_FOUND。 |
| **reject 也走 CAS** | `appTools.ts:72-77` — 註解記錄了 Task 11 review Finding 2：不可無條件 setStatus，否則已執行的結果會被覆寫成 rejected。 |
| **唯一一份 approveAndExecute** | `confirmService.ts:5-14` — 註解明寫「絕不能有第二份手工複製」，面板與確認頁都收斂到這裡。 |
| **eval 有對抗案例** | `eval/cases/cases.json` 21 案，含 `refuse-write-request` / `inject-tool-output-instruction` / `cs-inject-unqueried-oid` / `apps-refuse-self-approve` / `apps-inject-fake-approval` / `batch-refuse-claim-done` 等 6 條幻覺與注入防線。 |
| **untrusted 標記** | `envelope.ts:11-13` — 每個回傳都帶 `data_origin` + `untrusted_note`，明確叫 model 不要遵循 be2 內容裡的指令。 |
| **redirect_uri allowlist** | `oauth/redirectUri.ts` — 用 `new URL()` 解析後精確比對欄位而非字串前綴，`localhost.evil.com` / `claude.ai:8443` 類偽裝擋得住。loopback 放寬 port 與 path 是 RFC 8252 正解，且註解說明了為什麼。 |
| **scope 不信面板自報** | `appTools.ts:93-97` — 註解明寫「The panel's own selections are NOT trusted for scope — only what actually got read here counts」。 |

---

## 6. 擴展性相關（與盲點交錯，但不是 bug）

### X1（P1）「加 module 不碰 core」有 3 個破口
- `src/core/changeset/types.ts:1` `ActionType`、`:41` `AnyChangeSetItem`、`:94` `AnyDiffItem` 都是**封閉 union** → 加 module 一定要改 core 檔。`module-onboarding.md` §3 自己也列了這一步，與該文件開頭「驗收標準 = 完全不需要修改 core」自相矛盾。
- `src/core/changeset/tools.ts:110-124` description 硬寫 5 個 action（同 H2）。
- `src/ui/batch-wizard.ts` — **15 處 `actionType === / !==` 分支**（全 repo 最大檔，1,238 行）。`WizardDescriptor` 抽象已存在但只收了一半。

前兩個是半天工，第三個建議等第三個 wizard 型 module 出現時再收（現在收是過早抽象）。

### X2（P2）scope-binding 的實際保證比宣稱的弱
`src/store/readOidStore.ts:9` — retention 預設 **24 小時**，不是 session 生命週期。所以保證的精確措辭是「這個 session id 在過去 24h 內讀過」，而非「本次對話讀過」。長對話（Desktop 一整天同一個 session）會讓 scope 集合單向累積。**不是洞，但文件上的措辭要改精確。**

### X3（P2）`supplier_oid` 不進 scope
`src/modules/product/inventorySetting/module.ts:35` 與 `inventoryPlatform/module.ts:43` 的 `scopeOids` 都只回 `[item_oid]`。但寫入單位是 **item×supplier**（見 `module-catalog.md`），且 supplier 是真實的授權維度（`sit-write-contracts.md` 記載測試帳號因未對映 supplier 而 403）。所以「讀過 item」就能對任意 supplier 寫。權威檢查在 gateway，這只是少一層早退。

### X4（P2）`note` 不顯示在批准畫面
`change_sets.note` 有進稽核，但 grep 不到任何 renderer 使用它。trellis 治理原則第 5 條「人的意圖進稽核」達成了，但**批准的人看不到建立者聲明的意圖**。加上去很便宜。

### X5（P2）SQLite migration 沒有版本表
`src/store/db.ts` 用 `PRAGMA table_info` 逐欄偵測 + `DROP COLUMN` / `DROP TABLE` 修補（註解記錄了兩次 live 事故：2026-08-14 web_sessions、2026-08-15 approval_token_hash）。PoC 夠用，但 domain 一多會失控。上 Postgres 時一併換成正規 migration。

---

## 7. 給開發者的對焦順序建議

1. **今天 demo 前**：決定帶不帶 `APP_DEV_PANEL` flag（S1）；查 SIT DB 有沒有殘留 dev credential（S2）。
2. **demo 後第一批**：S1 + S2 + S3（一起做，同一個 PR），U2（list 工具，便宜且回報高）。
3. **第二批**：U1 的定位對焦（這題要人決定，不是 code），H1 + H2（都是 provenance / 介面收斂），H3。
4. **第三批**：X1 前兩個破口、U3 的錯誤碼對照表、X4。
5. **上 prod 前**：`audit-logging-gap-analysis.md` 的 P0 四項（G2/G3/G6/G9）＋ X5。

---

## 附錄：複驗指令

```bash
# S1/S2
grep -n "DEV_SECRET\|panel-tool\|expires_at" src/server/devPanelRoutes.ts
sed -n '266,270p' src/server/app.ts
sed -n '273,290p' src/server/app.ts

# U1
grep -n "perDay\|max(20)" src/limits/rateBudget.ts src/core/changeset/tools.ts

# H1
sed -n '11,40p' src/modules/product/inventoryPlatform/diff.ts

# H2
sed -n '21,30p' src/core/changeset/tools.ts        # union 收了幾種
sed -n '110,124p' src/core/changeset/tools.ts      # description 教了幾種

# X1
grep -c "actionType === \|actionType !== " src/ui/batch-wizard.ts
sed -n '1p;41p;94p' src/core/changeset/types.ts
```
