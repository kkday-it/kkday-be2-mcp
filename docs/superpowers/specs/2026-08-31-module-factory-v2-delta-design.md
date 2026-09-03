# Module Factory v2 — delta 設計（可續跑 + 離線 replay + 環境退避）

日期：2026-08-31　狀態：draft（待 agy-peer-review）
> **這是 delta spec。** 基底 = `2026-08-18-module-factory-design.md`（agy APPROVED）+ 其實作 `.claude/skills/module-factory/`。本文只規範 v2 的變更，不重寫三段闘關流程；未提及的部分一律沿用 v1。
> 搭配讀：v1 spec、`.claude/skills/module-factory/SKILL.md`、`docs/be2-mcp/sit-announcement-update-contract.md`（2026-08-31 實跡跑產物，本 spec 多處證據來源）。

## 1. 背景：為什麼要 v2

2026-08-31 用 v1 factory 對 `announcement_update` 標的做了一次**實跡跑**（只到段①），逼出四個真實摩擦點，加上探索過程的兩個發現，構成 v2 的動機。全部有實證，非臆測：

| # | 摩擦點 | 實證 | 對應 delta |
|---|---|---|---|
| P1 | **不可續跑** | v1 載體是 bash script + `Agent` subagent，段②六格並行或段③驗收中途死一格 → 無 checkpoint、從頭再來 | **D1** Workflow 載體 + resume |
| P2 | **無離線 replay** | 契約報告是 markdown 散文，沒有可回放 fixture；每次重驗都重打 live | **D2** cassette 錄放（依賴 D0） |
| P3 | **discovery 被環境卡死的誤判** | v1 對 SIT 撞 403/502 會判「授權天生擋死」→ executor 標 PENDING。實測改打 stage 直接 200 → **原判定是環境問題誤判** | **D3** 環境退避（SIT→stage） |
| P4 | **重造已知契約** | announcement_update 90% 欄位/header/授權碼可從姊妹 `announcement`(create) 契約離線繼承，v1 仍要求走完整 live 探索 | **D4** 姊妹契約繼承 |
| P5 | **sniff 抓不到 request body** | Playwright `browser_network_requests` 對 BE2 SPA 抓不到 body（fetch 參照已綁定）；要 server 端 `page.route`+`request.postData()` | **D5** sniff 用 page.route |
| P6 | **factory 綁 repo、無法一鍵啟動** | `.claude/skills/module-factory` 是 repo-local，Skill 工具在 repo 外叫不到 | **D6**（次要）可攜性 |

**foundational 前置 D0**：D2 的 cassette 錄放需要一層 record/replay harness（見 §3.0）。D0 先落地，D1–D5 才站得住。

## 2. 目標與非目標

**目標**：把 v1 三段闘關升級成「可續跑、離線可測、會自己換環境、能繼承姊妹契約」的版本，並把人工 gate 從 3 收斂到 2，同時**不弱化 v1 GATE 1 的欄位/授權 gate 正確性核心**。

**非目標（明確不做）**：
- 不重寫三段闘關流程本身（段①探索 / 段②六格並行產出 / 段③驗收的骨架不動）。
- 不改 core 治理層（沿用 module-onboarding「不碰 `src/core/`」驗收）。
- 不重做已上線 module（shelfToggle 等 7 個 action_type 不回頭重產）。
- 不做「零人工全自動到 merge」——保留 live 寫入的人工 gate（見 §4）。
- D6 可攜性只做「文件化如何在 repo 外觸發」，不做 skill 全域安裝機制（YAGNI，等真有跨 repo 需求）。

## 3. Delta 規格

### 3.0 D0（foundational）— record/replay cassette harness

**這是所有離線能力的地基，最先落地。** 於 `tests/support/cassette.ts` 提供 `makeCassetteFetch(mode, cassettePath): typeof fetch`：

- **攔截縫**：注入三個 client（`GatewayClient`/`AuthServiceClient`/`AnnouncementClient`）都吃的 `fetchImpl: typeof fetch`（現況已存在、測試已在用）。**選 `fetchImpl` 不選 `fetchJson`**——`AuthServiceClient` 直接呼叫 `this.fetchImpl` 不走 `fetchJson`，選低一層會漏 auth handshake。
- **record 模式**：呼叫真 fetch → 擷取 (method, url, body, status, response) → 寫 cassette JSON。
- **replay 模式**：以 (method, 正規化 url, **正規化 body**) 比對已錄 interaction 回存好的 Response；**比不到就大聲丟錯，絕不偷偷 fallback 打 live**。
- **★ 比對正規化（修 agy issue #2）：match key 對進來的請求與已錄 reqBody 套用「同一條」正規化管線後才比。** 正規化 = 剝除易變欄位（`modify_user` UUID、時間戳、request-uuid）+ JSON key 排序。executor 在測試時會送含 `modify_user` 的全 body，若只單邊剝、另一邊留 → 永遠比不中。故**兩邊對稱正規化**，易變欄位一律不進 match key。
- **★ 脫敏 vs 比對分離**：寫檔前的脫敏（JWT 拒寫、剝 `Authorization`/`x-api-key`）是**落盤安全**；比對正規化（剝 `modify_user`/時間戳）是**match 穩定**。兩者都做、但語義不同：脫敏防洩密、正規化防 flaky match。沿用 `scripts/probe-sit.ts` 的 JWT 拒寫。cassette 要 commit 進 repo。
- **★ 錯誤注入 API（修 agy issue #3）：harness 提供 `cassette.stubError(method, urlPattern, status, envelopeBody)`**，讓段③ error-handling agent 能對特定 route 注入 403/500/stale envelope，離線測 error 分支。種子 cassette 只錄 happy-path 200，錯誤分支靠 stub 不靠 live。
- **cassette 格式**：直接相容 discovery 的 capture 檔（見 D5），一筆 interaction = `{method, url, reqBody, status, resBody}`。

**種子**：2026-08-31 實攔的 `announcement-update-capture.json`（GET 詳情/POST/PATCH 三筆）是第一捲 cassette 的現成素材。

### 3.1 D1 — Workflow 載體 + resume（退休 v1 §5 的否決）

v1 §5 否決背景 Workflow，理由「三段要停下來問人、背景執行問不了人」。**此理由已過時**：`Workflow` 工具支援「回主對話等人核准 gate → 從斷點 resume」（`resumeFromRunId`，同 script 同 args → 快取命中的 agent 秒回，只重跑編輯過的 stage）。

- **載體改為 Workflow 腳本**：段②六格 = `parallel`/`pipeline` fan-out；段③驗收 = pipeline 後段。中途死一格，`resumeFromRunId` 只重跑該格與其後，前面快取命中。
- **人工 gate = Workflow 的自然暫停點**：跑到 gate 時 Workflow 回主對話 → 人核准 → 帶 `resumeFromRunId` 續跑。
- **段① 的 browser sniff 步驟**因需 live browser attach，維持在 Workflow 外由主 Claude/subagent 跑（Workflow script 無瀏覽器）；其產物（契約報告 + cassette）餵進 Workflow。
- v1 的 `run-agy-batch.sh` agy 後端**保留為選項**（省 Claude 額度時用），但預設走 Workflow 的 `agent()`。

### 3.2 D2 — cassette 錄放整合進三段

- **段①**：discovery 攔到的真流量除了寫契約報告，**同時存成 cassette**（D0 格式）。
- **段②**：六格產出的單元測試**預設 cassette-backed**（餵 `makeCassetteFetch('replay', …)`），零 live、可重複。取代 v1 的「fixture-gated skipIf」半套做法。**happy-path 走 cassette、error 分支（403/500/stale）走 `cassette.stubError(...)`（D0）**——兩者都離線，不因種子只有 200 而測不了錯誤。
- **段③**：`npm run ci` 在 replay 模式全綠（離線、無憑證）；error-handling agent 的 403/500/stale/併發 測試靠 `stubError` 離線覆蓋；**live 寫入 e2e 另開 tag**，只在人核准後對 stage 跑一次。

### 3.3 D3 — discovery 環境退避（SIT→stage）

段① endpoint-prober 撞 4xx/5xx 時，**不立即判授權 gate**，先自動換環境重試：

1. 預設 SIT；撞 403/502 → 自動改打 `be2.stage.kkday.com` / gateway `api-gateway.stage.kkday.com` 重試（config `APP_ENV=stage`）。
2. stage 過 → 授權 gate 解除、契約以 stage 流量為準（實證：announcement_update SIT 一直 403、stage 直接 200/`0000`）。
3. stage 仍卡 → 才判真授權 gate（executor-only PENDING，v1 邏輯不變）。
4. 契約報告新增「探索環境」欄，註明契約攔自哪個環境（避免把 stage 契約誤當 SIT/prod 保證）。
5. **★ 憑證環境感知（修 agy issue #4）**：D3 只轉流量還不夠。`src/modules/announcement/create/svcB2cClient.ts` 目前硬編 `process.env.API_ANNOUNCE_KEY`，無視 `APP_ENV`——update module 若沿用此 client、部到 stage/prod 仍會抓 SIT key。故 D3 附帶一項**必做重構**：把 announce 的 `x-api-key` 載入改為**依 `APP_ENV` 從 `config.ts` preset 取**（新增 `API_ANNOUNCE_KEY`/`API_ANNOUNCE_KEY` 到 preset，與既有 `*_AUTHSVC_SERVICE_KEY` 同形狀）。凡 factory 產出「繼承既有 client 但該 client 有硬編環境憑證」的 module，都要一併把憑證載入改成 env-aware，避免跨環境 key 洩漏。此重構列入該 module 的實作計畫（不改 core）。

### 3.4 D4 — 姊妹契約繼承（discovery 加速模式）

段① reference-reader 判定「最像的現成格」時，若標的與某既有 action_type **同 domain**（如 announcement_update ↔ announcement），啟用繼承模式：

- host / envelope / header / businessList 授權碼 / row 欄位 **直接繼承姊妹契約**（離線，不重打 live）。
- **★ live sniff 範圍 = executor 真正需要的所有 endpoint（修 agy issue #1）**：不是只 sniff 寫入 verb。若標的是 **read-merge-write**（如 announcement_update），executor 需先 GET 現況全欄位再覆蓋——**GET 詳情端點也必須 sniff 並錄成 cassette**，即使姊妹的 create 契約沒有它（create 是 target-only 無 GET 詳情，`sit-announcement-contract.md` 只有 GET list + POST）。判定規則：**先看範本格的 executor 用了哪些 read endpoint，逐一確保 discovery 都攔到**；缺任何一個 read → 段② 的 diff/executor 會缺讀步驟形狀或幻覺。announcement_update 實測需 sniff 三支：GET 詳情 + POST（差異）+ PATCH。
- 契約報告標明哪些節「繼承自 `sit-<sibling>-contract.md`」、哪些節「本次實攔」，並列出「本標的 executor 需要但姊妹契約沒有、故本次補攔」的 endpoint。

### 3.5 D5 — sniff 用 page.route

段① endpoint-prober 攔 request body **一律用 server 端 `page.route` + `request.postData()`**，不用 `browser_network_requests`（BE2 SPA 的 HTTP client 載入時已綁定 fetch 參照，繞過 window override → network_requests 抓不到 body）。capture 檔格式與 D0 cassette 相容。

### 3.6 D6（次要）— 可攜性

在 SKILL.md 補「如何在 repo 外觸發」段：主 Claude 於任意 cwd 用絕對路徑讀 `.claude/skills/module-factory/SKILL.md` 手動照跑；不做全域安裝。

## 4. Gate 模型重整（3 → 2 人工 gate）

使用者定調：只保留兩道**人工** gate。收斂方式 = 把 v1 的自動可判項改成自動、只在真需人決策處攔人：

| v1 gate | v2 處置 |
|---|---|
| GATE 1（契約報告：欄位 gate / 授權 gate） | **自動化**：D3 環境退避 + D4 繼承後，若 discovery GREEN（欄位齊、授權過）→ **自動放行不攔人**；只有「換 stage 仍卡的真授權 gate」或「欄位確實拿不到」才攔人。判定邏輯（欄位 gate block 段② / 授權 gate 只 executor-PENDING）**完全保留**，只是綠燈時不再問。 |
| GATE 2（六格 diff + conformance） | **併入人工 Gate①（計畫核准）**：段②產完，把六格 diff + conformance 結果 + 實作計畫一起攤給人核准。 |
| GATE 3（merge + live 寫入） | **人工 Gate②（live 寫入）**：段③ replay 全綠後，真實寫入 stage/prod 前攔人核准。 |

→ 最終兩道人工 gate：**Gate①=計畫/產出核准**（段②後）、**Gate②=live 寫入核准**（段③）。discovery 綠燈全自動。**正確性核心（欄位/授權 gate 判定）不因收斂而弱化——只是綠燈時自動放行。**

## 5. 前置依賴與落地順序

```
D0 cassette harness（tests/support/cassette.ts）      ← 先做，地基
  └─ D2 錄放整合、D5 capture 格式相容都依賴它
D1 Workflow 載體 + resume                              ← 可與 D0 並行
D3 環境退避 / D4 姊妹繼承 / D5 page.route              ← 段① 內的獨立小改，可並行
D6 可攜性文件                                          ← 收尾
Gate 重整（§4）                                        ← D1 載體到位後一起改 SKILL.md
```

## 6. 影響檔案

- **新增**：`tests/support/cassette.ts`（D0）、`tests/cassettes/*.json`（種子含 announcement-update）、Workflow 腳本（D1，落點待 writing-plans 定）。
- **改**：`.claude/skills/module-factory/SKILL.md`（Gate 重整 §4、D3/D4/D5/D6）、`references/stage1-explore.md`（D3 退避、D4 繼承、D5 page.route）、`references/stage2-produce.md`（D2 cassette-backed 測試）、`references/stage3-verify.md`（D2 replay/live 分離）。
- **改（D3 憑證 env-aware，隨 announcement_update module 一起）**：`src/config.ts`（preset 加 `API_ANNOUNCE_KEY`/`API_ANNOUNCE_KEY`）、`src/modules/announcement/create/svcB2cClient.ts`（`makeAnnouncementClient` 依 `APP_ENV` 取 key 而非硬編 `API_ANNOUNCE_KEY`）。此為既有洩漏隱患的順帶修正，不碰 core。
- **不改**：`src/core/`、已上線 7 個 module 的行為（svcB2cClient 的 key 載入重構屬安全修正、不改對外行為）。

## 7. 測試與驗收

- D0：cassette harness 自身單元測試（record 一筆→replay 命中→比不到丟錯）；用 announcement-update 三筆真流量當 fixture。
- D1（**2026-09-02 下修**）：交付 = Workflow 載體文件 `references/workflow-carrier.md`（腳本骨架 + `resumeFromRunId` 用法 + gate 邊界）齊備即達標。**「故意中斷一格 → 實測 resume 快取命中」的 live 實證延後**——它屬 factory **執行期**驗證（需真跑 Workflow 多代理），非本 delta 的 code；等首次用 v2 Workflow 載體實跑一個 module 時順帶驗。原「實測可續跑」為 code-review 指出 plan 相對 spec under-scope、diff 忠實跟隨 plan，故據實對齊。
- D3：對一個已知 SIT-gated 標的跑 discovery，驗證自動退避 stage 並取得 200。
- D4：對 announcement_update 跑 discovery，驗證繼承節（host/envelope/header/授權碼/row 欄位）標「繼承自 create」、且 executor 需要的三支 read-merge-write endpoint（GET 詳情 + POST 差異 + PATCH）都有 sniff 並錄成 cassette（不是只 sniff PATCH）。
- 整體 dogfood：用 v2 實際產出 `announcement_update` module（契約已 GREEN，見 contract 報告），當 v2 的第一個真實驗收標的 + 第一捲 cassette。

## 8. 開放問題

1. **merge-vs-replace 的多語系邊界 — ✅ 已解（2026-09-02 stage live e2e）**：實測 = per-lang **full REPLACE**，PATCH 省略某 langCode **會刪掉該語系**（建 `[en,zh-tw]` → 只送 zh-tw → en 消失）。→ executor 送整包 `it.contents` 為正確且必要（item 須帶完整語系集）。詳見 contract `sit-announcement-update-contract.md` §6.2。（原「未證實」已由 dogfood Gate② 消除。）
2. **stage 殘留清理**：實跡跑在 stage 商品 765928 留 2 筆已停用 `[CLAUDE-TEST]` 公告（oid 3084/3085），BE2 前台無刪除鈕，需 DELETE API 或有權限者處理。
3. **cassette 過期**：stage fixture 會被定期 restore（見 memory `be2-stage-fixture-volatile`），cassette 是快照不受影響，但「契約本身變動」需重錄——是否加 cassette 版本戳 + 定期對 live 校驗，留 writing-plans 評估。

<!-- agy-peer-reviewed: 2026-08-31T16:00:28Z rounds=3 verdict=approved -->
<!-- agy-peer-reviewed: 2026-09-02 rounds=1 verdict=approved note=§7-D1-downscope+§8-Q1-resolved factual-alignment re-confirmed -->

