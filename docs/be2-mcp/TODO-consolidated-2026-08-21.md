# be2 MCP — 待辦彙整(2026-08-21,交接新 session)

> 這是截至 2026-08-21 的**全部 open todo**,供新 session 一次掌握。BAA wizard 三塊(公告C/庫存數量A/庫存排程B)+ code-review 收尾已 **merge 進 main(PR #19,`9396d8f`)**。以下是剩下的。

## A. 開發功能(spec 級,走主管線 brainstorming→spec→agy→plan→subagent)

### A1. 上下架 / 排程 4 項強化 —— 詳見 `shelf-schedule-followups-handoff.md`
1. 單次批次只能全上架或全下架(不可混)——目前**未強制**,要加 validate + UI 單一方向。
2. **商品層**上下架進 wizard(現只有方案層;`shelf_toggle_product` module 有、沒接 wizard)。
3. 面板顯示**當前上架/下架狀態**(`batchView.is_active` 已讀、沒呈現,低工)。
4. 排程**逐筆編輯**(現在只能加/取消整組 full-replace,不能編輯單筆)。

### A2. 登出 / 撤銷(logout / revoke)——**✅ DONE:PR #24 已 merge 進 main(`8603a57`,2026-08-22)**
- 交付:RFC 7009 `POST /oauth/revoke`(grant 級撤銷 `revokeGrant`,保留 web_session/static_bearer)+ discovery `revocation_endpoint` + `/confirm/connections`「斷開所有 Claude 連線」頁(Origin 檢查擋 localhost CSRF + PRG)。spec/plan 皆 agy APPROVED(各 rounds=2);ci 635 綠;雙軸 code-review 收畢;dev server 冒煙通過。
- **live 驗收 PASS(2026-08-22)**:真人 Desktop 實斷 2 條 → 401 → 自動 re-auth 復原,二輪重測過(證據見 PR #24 comment + oauth-runbook)。
- **環境備忘**::8787 server 改從**釘在 main 的獨立 worktree** `/Users/lance.chien/Documents/Projects/.be2-mcp-server-main` 起(共用主 repo 的 sit-220 sqlite,`BE2_MCP_DB_PATH` 絕對路徑)——與開發工作區脫鉤,並行 session 切 branch 不再波及 server。升級 server 版本:`git -C .be2-mcp-server-main fetch origin main && git -C .be2-mcp-server-main checkout origin/main`,再重啟。
- 邊界(已寫進 oauth-runbook「使用者主動撤銷」節):be2-mcp 撤銷 ≠ be2-web SSO 登出(auth-service JWT 在 ~50min TTL 內仍有效);Claude Code 端快取 DCR client/token 不會自己消失,下次 401 自動重走 OAuth。

### A3. 價格域 3b(next domain)——照 `module-onboarding.md` 上車
- 契約:`sit-price-contract.md`。這是「module 介面通用性」的第一次實戰(繼公告非-product domain 後)。

### A4. 方案維護 3c(改名/排序/刪除)—— phase0 判低價值,擺最後。

### A5. OAuth 外殼 DCR + CIMD 雙模相容 —— 設計文件 `~/Downloads/mcp_hybrid_design_doc.md`(待搬進 repo)
- **動機**:MCP 客戶端認證正從 **DCR(動態註冊)** 遷往 **CIMD(Client ID Metadata Documents)**——新版客戶端直接用一個 HTTPS URL 當 `client_id`、AS 即時抓該 URL 的 metadata,**免預先註冊**。目前 be2-mcp OAuth 外殼只做 DCR(見 `oauth-runbook.md`、`RegisterController` 借鏡 dev-tools)。
- **目標**:雙模並存 + adapter pattern,舊版 AI 客戶端(DCR)與新版免註冊客戶端(CIMD)皆能接。無狀態、client_id 自動分流(`https://` 開頭 → CIMD 抓取;否則 → DCR 查 store)。
- **落點**:(1) discovery `.well-known/oauth-authorization-server` 同時宣告 `registration_endpoint` + `client_id_metadata_document_supported: true`;(2) 新增 `ClientResolver` adapter 統一解析(`getClientMetadata` 分流);(3) 既有 DCR register 端點保留。
- **安全(design doc §4,必做)**:CIMD 抓取要防 **SSRF**(禁 localhost/內網 IP)、**網域一致性**(`redirect_uris` 的 origin 須 == `client_id` URL 的 origin)、抓取結果**快取**(避免每次 tool call 打外部)、DCR **rate limit**、公開客戶端**強制 PKCE S256**。
- **前置/對齊**:先確認我方 OAuth 客戶端(Claude Code/Desktop)實際走哪模、以及 be2-mcp 內網部署下 CIMD 外抓的可行性(egress);與現有 redirect_uri allowlist / PKCE 機制整合。走主管線(brainstorming→spec→agy→plan)。**動工前先把 design doc 搬進 `docs/be2-mcp/`**(目前在 `~/Downloads`,不在 repo)。

## B. 技術債 / 重構(GitHub issues 已開)
- **#20** `batch-wizard.ts` 逐型 `actionType` switch(17 處)收進 `WizardDescriptor`(純重構,加新 action_type 時最痛的點)。
- **#23** **mid→prod_oid 解析防呆**(策略A:tool 分 `prod_mid`/`prod_oid` 欄位、共用 resolver、canonical oid 進 scope-gate)。be2-web 網址是 mid、API 吃 oid,使用者複製網址數字會 not_found。**demo 也踩過**。
- **rate budget 重估**:`RATE_CHANGESET_DAY` = 10/天、**所有功能共用一個 per-user 桶**(key 無 action_type)。對真 power user(如 vivian 一天數百次)太低 → 上線前改 per-type / 分級 / 提高。

## C. Live-write 驗收(待外部授權,非程式問題)—— issues 已開
- **#21** live-write 驗收 gate:所有域的**真 200 寫入**都待授權——
  - 庫存數量 quantity PUT:be2-220 **AU9403**(stage 曾 200);
  - 公告 create:svc-b2c **403/502**;
  - 上下架 shelf_toggle switch:**403**(此帳號對測試商品無寫權;端點已證正確、屬 per-URI 授權);
  - 塊B 排程到點執行:到點會撞 AU9403。
  - **解法**:一個此帳號有寫權的商品/環境,或補 stage service key。跑法見各 runbook。
- **#22** 公告 **POST wire body UNVERIFIED**(best-guess,待一次真 create 攔 + PATCH merge 語義)。

### C-補. 面板 UI 驗收殘項(非阻擋)
- shelf_toggle_product/_bundle 完整 e2e(本 session 只驗 plan;bundle 那次測資選錯 pkg)。
- shelf_toggle 的 changeset-panel / SSO 確認頁 UI(dev query harness 餵不了 changeset_id,需 Desktop 真 host 或 SSO 頁)。

## D. 收尾決策 / loose ends
- **`src/limits/rateBudget.ts` 未 commit**:加了 `BE2_MCP_DISABLE_CHANGESET_BUDGET` env 開關(demo 用,現在 :8787 帶著跑)。決定:commit 成正式 env-gated 功能 / revert / 留本機。**生產勿設此旗標。**
- `docs/be2-mcp/demo-runbook-2026-08-21.md`(untracked,保留)。
- **OAuth authorize 頁 TTL**:optional defense-in-depth(現況 60s auth code 已鎖關鍵窗;登入頁本身無 server TTL,低優先)。
- **prod service key**:`PRODUCTION_AUTHSVC_SERVICE_KEY` 待正式確認(prod 部署前)。
- **prod BE2_DOMAIN 白名單**:OAuth popup 上線前請 auth-service 把 be2-mcp origin 納入(SIT 已 `ALLOW_LOCAL_LOGIN`)。
- 本機 server::8787(current main、sit-220、dev panel、budget disabled)還開著;sit-220 db 測試交易資料已清、認證保留。

## E. Phase 4a wizard 收尾 session 補入（2026-08-21，review minors backlog + 流程收尾）

### E1. Wizard 便宜清潔批（四條皆數行，可一個 agy 批收掉）
1. 「套用到所有已勾選」重複點擊會累加重複 queue entries（push 前去重或改覆寫；檢視頁可見＋full-replace 兜底，非急）。
2. filter 藏起的列被兄弟連動勾選時「將一併變更」badge 當下不可見（`syncSiblings` 連動時順手 `rowEl.hidden=false` 一行解）。
3. 20-item 上限無前端提示（server zod `.max(20)` 兜底，超額只回通用錯誤）。
4. 確認頁 `renderPlatformPage` pkg_name 雙重 escape（含 `&`/`<` 的方案名顯示成字面 entity；over-escape 方向安全、純外觀）。

### E2. Review minors（接受中，擇機收——多數適合模組化後處理）
- `inventory_platform` executor 無跨 change-set mutex（布林覆寫後寫贏；**多 instance 部署前必須**上分散式鎖，與 Phase 3a execInventory 的 in-process mutex 一併升級）。
- `shelf_schedule` 同 PUT 多 pkg 共用結果的稽核群組註記未落地（runbook 已文件化）。
- `recomputeAffectedPkgs` 零佐證（claimed prods 全查無）時不標 `affected_pkgs_unverified`（低風險：列身分/現況為 server 推導）。
- wizard 檢視頁對 `affected_pkgs_unverified` 無人話警語（確認頁有；面板 raw JSON 顯示）。
- `panel.smoke.test` 在 CI 環境 `skipIf` 整檔跳過（build 產物斷言只在本機跑）。
- live 驗收腳本 `landed=false` 防護分支未實跑（best-effort，踩到 read-after-write lag 再驗）。

### E3. 流程收尾（session 級）
- **job-retro**：Phase 4a＋OAuth 收尾兩大段的教訓萃取（部分已進 memory/vault：fakeDom CSS 盲區、agy headless 禁令、`CREATE TABLE IF NOT EXISTS` 非 migration 三連踩、hidden 屬性 vs display class）；08-16 後半（返回導航、dev harness、PR merge）未補 vault。
- **specs/CHANGELOG.md 追溯補記**：`2026-08-14-be2-mcp-baa-wizard-design.md` 的 agy 三輪修改（item×supplier 粒度、read-oids 三層、live 重算禁經 packages）——CHANGELOG 規則晚於該 spec 生效，補記留痕。
- **正式全量 code review（選項 B）**：prod 前對 main 跑一次 `/review` 級總審（PR #1 comment 有審查鏈摘要，但無單一跨 phase 總審）。
- 面板驗收回饋未回收：tabs/not-found、取消排程 UX、狀態膠囊、空時間防呆、返回導航——demo 後若無異常請標驗訖。
- per-方案多時間點（spec §9 降級砍項）→ 併入 A1-4 排程逐筆編輯一起設計。

## F. Phase 3a session(8/10)殘留待辦(2026-08-21 逐項對 repo 現況重驗後併入;原誤標 E、與上節撞號改 F)

> 背景:8/10 那個 session 交付 Phase 3a(庫存 per-date change-set)+ probe 契約收斂(正門 `POST inventories/search`、寫入 `PUT .../{supplier}/quantity`、`modify_type` 1=set/0=adjust、AU9403 root-cause)。其後 module-factory 重建把庫存域改成現制 `inventorySetting` module。以下是重驗後**仍真的 open** 的項目;已被後續工作解掉的(讀取側換門、spec CHANGELOG 建檔、stage 真 200)不再列。

### F1.(已決策 2026-08-21)3a per-date/adjust 縮編 —— 記帳完成,回移列 backlog
- **決策**:先縮編記帳,per-date/adjust 不回移;已記 `docs/superpowers/specs/CHANGELOG.md` 2026-08-21 條目。**回移觸發條件**:pilot 出現「逐日批改」形狀的使用者(phase0 的 vivian power-user 每月 ~11.8k 筆批改正是這形狀)。
- **範圍更正(初版本節誤述)**:縮編的只有 `dates[]` 逐日、`op: adjust`、`would_go_negative`、per-date `partial`;**busy guard、同 item×supplier per-key mutex、AFTER_READ_FAILED 隔離都已移植保留**在 `src/modules/product/inventorySetting/executor.ts`(12-24 行即 I-1 mutex),無併發護欄退化。(注意:上節 E2 提到的 `inventory_platform` module 無 mutex 是另一個 module 的事,不受本更正影響。)
- 回移時的參考:3a spec §3–§5、舊實作 git 歷史(`0182064..2f34a1f`)、`sit-write-contracts.md` §inventory(後端原生 `remain_qty` `{date:{fullday|event:qty}}` + `modify_type 0`=add/subtract)。

### F2. `scripts/probe-sit-inventory.ts` 已知是誤導版 —— 更新或刪除
- 重驗(2026-08-21):它仍打 S2S 專用 `GET .../inventories/{supplier}`(user token 必 403)並引導人工試錯誤的 PUT 候選端點。今天照它跑會重現 403 並得出「帳號沒權」的錯誤結論。
- 改法:換成已收斂契約(`POST .../inventories/search` 讀、`PUT .../{supplier}/quantity` 寫、`supplier-mappings` 查 supplier),或直接刪掉並在 `sit-write-contracts.md` §inventory 註明以該節為準。

### F3.(已完成 2026-08-21)8/10 session 的教訓已蒸餾雙寫
- memory:`be2-403-check-endpoint-first`、`kibana-request-uuid-tracing`(AI 召回層)。
- vault:`_inbox/2026-08-10-be2-mcp-phase3a-inventory-403-root-cause.md` + BE2 Index 連結(人類脈絡層)。

### F4. eval 至今從未真跑過
- 歷來 `npm run eval` 都因無 `ANTHROPIC_API_KEY` 而 documented SKIP。ci 605 綠但 agent 行為層(選對工具、draft-only、注入抵抗、庫存 4 案例)零次實測。找一次帶 key 跑通並記結果。

### F5.(補充到 C/#21)SIT AU9403 的精準開權文案已寫好
- `sit-write-contracts.md` §inventory「2026-08-10 再追加」節有可直接貼給 auth-service/be2 授權管理者的請求(含 uri_pattern `api/v1/items/{*}/inventories/{*}/quantity`、AU9403、CheckTargetRuleCache 證據)。stage 已真 200 後此項降為「SIT 錨定環境要不要也開」的選項,非阻擋。

## 環境備忘(demo / 驗收用)
- 真 prod_oid(非網址 mid):庫存/平台/公告 **38352**、上下架 **35992**。2358 無限量(庫存數量不支援)。
- `.env BE2_ENV=sit-220`。dev 面板:`/dev/panel/batch-wizard?action_type=<X>&prod_oids=<oid>`、`/dev/panel/announcement-wizard`。
- Desktop 無 F5:換操作按面板「**開始新批次**」(全重置)或請 Claude 重開精靈。

## 相關文件
- handoff:`shelf-schedule-followups-handoff.md`、`baa-wizard-expansion-handoff.md`
- 契約:`sit-write-contracts.md`、`sit-announcement-contract.md`、`sit-price-contract.md`
- 上車:`module-onboarding.md`、`module-catalog.md`
- runbook:`demo-runbook-2026-08-21.md`、`oauth-runbook.md`、各 phase runbook
- GitHub issues:#20(switch 重構)、#21(live-write gate)、#22(公告 wire body)、#23(mid→oid)

---

## G. 工作台(workbench)彙整 session — 2026-08-24/25

**做完(feat/workbench,`5888c6d`→`ddbddf2`,尚未 merge)**:
- 9-task workbench plan(TDD,subagent-driven)+ 跨模型 whole-branch review 3 項 Important 已修(復原被覆寫的 app-view IDOR/nonce 安全測試、>20 拆批未接線、公告 de-N+1 註記)。
- >20 筆**自動拆多 change-set**(splitBatches/buildActionChunks 逐批 create→view→confirm、結果彙總)。
- 上下架改**對象×時機**兩軸 → 再依使用者定案重做為 **版型 B**(深色 nav/暖橘/步驟條/兩欄即時摘要),再因 MCP 面板窄框重排為**單欄+功能頁籤**(max-width 760)。
- 上下架單一清單(整個商品+一般方案+組合方案同框)+全域排程 toggle(排程僅一般方案、`shelf_schedule` 單 datetime→reserve_queue 一筆;商品層/組合方案灰掉+提示)。
- 結果頁 item_key → 「商品名·方案名」(resultNameByKey)。
- **live 連線修復**:mcp-remote 殭屍 lockfile/多副本競爭 → 照 oauth-runbook SOP 清 `~/.mcp-auth` + lockfile;server 從 `.be2-mcp-server-main` worktree 起。
- **上下架 create INVALID_ITEMS 根因修復(live 揪出)**:`itemShape=z.union(所有 module schema 依註冊序)`,product schema `{prod_oid,target_is_active}` 是方案/組合方案 item 的純子集且排前面,zod 剝掉 pkg_oid/bundle_pkg_oid → 過 plan/bundle isItem 就 INVALID_ITEMS。修:`itemSchemaProduct.strict()`(module 層、不動 core);面板改顯示真實 errors[];加回歸測試。CI 660 綠,SDK live 驗 create 拿到 changeset_id。

**還沒做(this session TODO)**:
- **G-A1** 三功能全鏈路 e2e 冒煙:用 `/dev/panel/workbench`(dev harness,本 session 補進 ALLOWED_PANELS)+ playwright 跑 load→select→檢視(draft-only,不 approve 免真寫)。
- **G-A2** push `feat/workbench`(領先 main 20 commits) + merge 決策。
- **G-B3** `be2_open_workbench` prefill(feature/prod_oids)面板未消費 = 死功能 → 接線或移除;順便對齊上限(tool max20 vs app_get_batch_view max10)。
- **G-B4** 公告 de-N+1 共用 perPage=100 + 依賴回傳帶 prod_oid → live svc-b2c 通了按真實形狀校準(已加註,best-effort 不阻擋)。
- **G-B5** `.be2-mcp-server-main` worktree 測完切回 main + 重啟(現停在 feature commit `ddbddf2`)。
- **A5(既有)** OAuth DCR + CIMD 雙模相容 — 見上 A5,設計 doc `~/Downloads/mcp_hybrid_design_doc.md` 待搬進 repo。
- **C(既有)** live 寫入真 200 仍待可寫商品/環境(#21);上下架真 endpoint prod_oid=35992、庫存/平台/公告=38352。
