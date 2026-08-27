# Spec CHANGELOG

> `docs/superpowers/specs/` 下任何檔案異動記一筆。格式：以 `## 日期` 分組，每筆 `檔案與節次 / 改了什麼 / 為什麼`。
> 發現規格自相矛盾時，先在此提出問題再改實作，不要靜默繞過。
>
> 追溯補記（2026-08-19 起才有本規則，先前的 spec 異動追溯登記於下）。

## 2026-08-27

- `2026-08-27-be2-mcp-cloud-ready-phaseA-design.md` §9/§10.1/§10.2/§3/§14/§15(agy review rounds 1-3 四修)/ (1) **rootDir**:`tsconfig` include 多 sibling → tsc 推 rootDir=`.` → 進入點其實在 `dist/src/index.js`(非 `dist/index.js`),原 start/CMD 會開機 MODULE_NOT_FOUND;加 `tsconfig.build.json`(只 include src+scripts、排除 eval/tests)、start/CMD 改 `dist/src/index.js`;查證 `appResources.ts` UI 路徑是 cwd-based 故不受巢狀影響;(2) **scheduler graceful race**:`start()` stopper 只 clearTimeout 下輪、不等 in-flight tick → db.close 打斷 await 中的 tick 會「database is closed」+ 卡 executing;改 `start()` 回 `()=>Promise<void>` 等 in-flight tick,shutdown 先 await 它再關 db;(3) **OTel flush**:otel.ts 自帶 SIGTERM listener 的 async shutdown 會被同步 exit 砍斷;改匯出 async `shutdownOtel()`、移除自帶 listener、index.ts 單一協調者 await 它;(4) **setTimeout 硬逾時放頂層 = 開機即 arm** 且 Express 讓 loop 活著 `.unref()` 無效 → 開機 GRACE_MS 後保證 hard-crash;移進 `shutdown()` 內只在收訊號後計時 / agy 抓到 rootDir emit 路徑、scheduler 關機 race、otel flush 被砍、頂層 timer 開機自殺四個都是真會 ship-bug 的問題(rounds=3 APPROVED)。
- `2026-08-27-be2-mcp-cloud-ready-phaseA-design.md`(全檔,新建)/ cloud-ready 遷移 Phase A:把 be2-mcp 從本機 PoC 搬上 stage EKS 單副本。修 3 硬阻斷(bind→`BE2_MCP_BIND_HOST` env default 127.0.0.1、public URL→新增 `BE2_MCP_PUBLIC_BASE_URL` config 注入 app.ts:142/255、Host 白名單→`BE2_MCP_ALLOWED_HOSTS` 已是 env 純設值)+ 上線工程(tsc build→node dist、multi-stage Dockerfile node:22-bookworm-slim、/readyz 查 DB、SIGTERM graceful、Node 釘 22)。明文 token at-rest 交 DevOps 加密 PVC(不做 app 層加密)。k8s manifests 歸 DevOps、live stage e2e 標 PENDING(依 DevOps 部署 + STAGE service key + 寫入權限)。**明確排除** Postgres/Redis/HA(留 Phase C)、store schema/migration 重構 / 範圍 grilling 七問定案(2026-08-27):better-sqlite3 同步 API→換 Postgres 是全鏈路 sync→async 重構,故本波只 Phase A;產出邊界 app code+Dockerfile;驗收我方可控。

## 2026-08-21

- `2026-08-21-be2-mcp-logout-revoke-design.md` §6.2/§7/§9(agy review round 1 四修)/ (1) CSRF 改顯式 Origin 檢查(SameSite 對 127.0.0.1 不分 port,同機異 port 可跨站 POST 固定路徑的 revoke-all);(2) SsoDeps 接線補 oauthStore+baseOrigin;(3) requireSession 抽共用 sessionGate;(4) revoke-all 改 POST-Redirect-GET / agy 抓到 localhost CSRF 與缺依賴注入是真問題(rounds=2 APPROVED;「family 已亡 edge 不可能」的質疑經 oauth-purge 場景推翻獲 CONCEDE)。
- `2026-08-21-be2-mcp-logout-revoke-design.md`(全檔,新建)/ A2 登出/撤銷設計:RFC 7009 `POST /oauth/revoke`(grant 級撤銷 = identity 的 oauth_refresh family + oauth_access,保留 web_session)+ discovery 宣告 `revocation_endpoint` + `/confirm/connections` 連線管理頁(同 userLabel 橫跨 identity「斷開所有 Claude 連線」)/ OAuth 連線先前無使用者主動撤銷手段,只能等 30 天過期;方案 1 使用者拍板(2026-08-21),grant 級語義與既有 refresh-reuse family revoke 同形狀。
- `2026-08-10-be2-mcp-phase3a-inventory-design.md` §0/§3/§4/§5(縮編記帳,spec 本文未改)/ 模組化重建後的現制 `inventorySetting` module 刻意縮窄為「fullday 絕對值 set」:`{item_oid, supplier_oid, quantity}`,**不含** 3a spec 的 `dates[]` 逐日、`op: set|adjust`、`would_go_negative`、per-date `partial`;安全護欄 busy guard、per-key mutex、AFTER_READ_FAILED 隔離**已移植保留**(`src/modules/product/inventorySetting/executor.ts`)。後端契約原生支援 per-date 與 adjust(`sit-write-contracts.md` §inventory:`remain_qty` 吃 `{date:{fullday|event:qty}}`、`modify_type 0`=add/subtract),故此為**產品範圍決策非技術限制** / 使用者拍板(2026-08-21):先縮編記帳,per-date/adjust 列 backlog 等 pilot 回饋(power-user 逐日批改形狀出現 = 回移觸發條件);詳見 `docs/be2-mcp/TODO-consolidated-2026-08-21.md` §F1。

## 2026-08-16

- `2026-08-16-be2-mcp-modularization-design.md`（全檔，新建）/ Phase 5 模組化設計：ActionModule 介面 + registry、5 熱點收斂、純重構 DoD / 把「加一個 action_type 碰 8 檔」收斂成「一包 module 註冊」。
- 同檔 §3（agy review round 1 五修）/ DiffCtx/ExecCtx 分離、validate 注入 nowMs、ConfirmView 改內容物件、ExecCtx.span 保留 span 粒度、authz degrade 逐碼映射 / agy 抓到共用 ctx 會逼 modifyUser 變 optional、validate 失去可 mock 性等真問題（rounds=2 APPROVED）。

## 2026-08-18

- `2026-08-18-module-factory-design.md`（全檔，新建）/ Module Factory 設計：三段闘關（探索/產/驗收）+ 方案 A 六格並行引擎 + repo skill 載體 / 把 module-onboarding 人工 checklist 自動化。
- 同檔 §1/§2.1/§3.1/§6/§7（agy review round 1 三修）/ (1) ENDPOINTS.md 為每次跑的輸入、需複製進 repo 避免幻影路徑；(2) GATE 1 拆授權 gate（executor-only PENDING）與欄位 gate（欄位未知 block 段②，防盲寫）；(3) 六格編排寫成 run-agy-batch.sh 機械腳本 / agy 抓到「欄位未知卻說 schema 照產」是盲寫矛盾、幻影檔路徑、並行編排缺具體腳本（rounds=3 APPROVED）。

## 2026-08-20

- `2026-08-20-be2-mcp-inventory-schedule-design.md`（全檔，新建）/ 塊 B 排程層設計：probe 實證 be2 無庫存原生排程（`probe-inventory-native-schedule.md`）→ core 泛用排程能力（`ChangeSetStatus` 增 scheduled/cancelled/missed、批准 CAS→scheduled + 持久化批准者 identityId、server 內建 poller 以既有 DB CAS 認領=免 leader election/免新增 Redis、TOCTOU 時間回聲綁定、keep-alive refresh 讓 horizon 成立、grace 超窗標 missed 寧可不執行）+ module `schedulable` opt-in（僅 inventory_setting 開）/ 塊 B 唯一使命：庫存數量是唯一無原生排程的域；wizard 只是 UX、能力在 change-set 排程層。時區規則：牆鐘+`BE2_TZ` 換算 UTC 一次、呈現回放原文不反推（一級需求）。假設清單替代逐題釐清（背景 session）。

- `2026-08-20-be2-mcp-inventory-schedule-design.md` §3/§4/§5/§6/§7/§11（agy review rounds 1-3 八修）/ (1) keep-alive 多實例防撞:be2_identities 加 keepalive_claimed_at DB claim,殘餘風險歸屬 §1.5 原語 #1;(2) TokenManager 新增公開 getFreshByIdentityId + keepAlive(封裝不穿透);(3) identityId threading 進 UserAuthContext/ApproveWho;(4) schema 加 executor_session_id(audit 歸屬批准者,禁 fallback creator);(5) 批准過期排程 409 SCHEDULE_IN_PAST,且閾值刻意與建立不同(批准只驗「仍在未來」,避免 tight schedule 永遠批不過);(6) transient refresh 失敗放回 scheduled 重試(terminal 才 failed);(7) stranded-approved 回收(schedule_claimed_at + staleClaimMs);(8) executor 起點改 casStatus(approved→executing) 輸即 abort=exactly-once 執行 / agy 抓到 spec 引用的 TokenManager API 是 private、ApproveWho 拿不到 identityId、多實例 keep-alive 撞 rotation 誤刪 credential、背景排程不能沿用「人在場一次定生死」的錯誤處理(rounds=4 APPROVED)。

- `2026-08-20-be2-mcp-inventory-schedule-design.md`(實作期偏離與收尾修正,附記)/ (1) 假設 A4「horizon env 可調」實作收窄為 `SCHEDULE_POLICY` 常數(policy.ts 註明 YAGNI,env 覆寫留待真需求);(2) spec §7「啟動時對 stranded executing 記 audit 警示」final review 抓到漏做,已補(`schedule.stranded_executing` + `listExecutingScheduled`);(3) purge 保護(§6)擴大涵蓋「claim 後短暫 approved」窗口(status='approved' AND execute_at_utc 非 null 也排除);(4) keep-alive terminal 連坐 fail 的 audit 歸屬修正為批准者(§11);(5) 面板取消流程實作修正:取消前重新 view 取新鮮 nonce(批准已消耗原 nonce)+ 驗錯誤信封防假成功——spec §8 未寫到 nonce 單次性與取消的互動,實作以「同 gate 同紀律」補齊 / 塊 B 實作全程 3 輪 task review + 1 輪 final whole-branch review 的產物,實作與 spec 的偏離全數記錄於此,不靜默。

- `2026-08-20-be2-mcp-inventory-quantity-wizard-design.md`（全檔，新建）/ 庫存數量進 wizard 設計（塊 A，即時 SET/fullday）：**就地改寫** Phase 3a `inventory_setting` module 為 fullday-SET 形狀（拿掉 dates[]/adjust/per-month）、**只支援 item_by_amount（1/0）其餘 fail-closed 擋 + 面板標示**、`inventoryShape.ts` FINALIZE（讀取改 `POST inventories/search`、主形狀 `data[itemOid].fullday`、保留 defensive、補 fixture）、折進既有 `be2_open_batch_wizard` grid 面板 / 對齊獨立版 BAA 庫存能力（原版僅 item_by_amount/fullday）。3 個關鍵決策經使用者拍板：(a) 砍掉重寫（舊 module 從未上線、讀取端點壞的，無相容包袱）(b) 只做 item_by_amount、其餘擋掉但 UI 標「目前不支援」(c) live 寫入 PENDING（quantity PUT AU9403，RD 處理中）。與 Session 1（公告，走 sibling 面板）幾乎零檔案衝突，剩 types.ts union / index.ts 行級小衝突。塊 B（排程）另 session。
- `2026-08-20-be2-mcp-inventory-quantity-wizard-design.md` §3/§4.3/§8/§10（授權 gate 現況更新）/ live 重測（塊 A brainstorm 期）發現 **stage quantity PUT 首次真 200**（正確契約 e2e 驗完）、SIT be2-220 仍 403（AU9403，RD grant 未生效）、stage 憑證已補齊；spec 從「live 寫入一律 PENDING」改為「live 綠寫入走 stage、SIT 待 grant」，§8 加 stage net-zero live 驗收 exit gate / 反映真實可寫路徑，讓 writing-plans 能放真的 live-acceptance 步驟。同步 `sit-write-contracts.md` §inventory + memory `be2-mcp-phase3-plan`。
- `2026-08-20-be2-mcp-announcement-wizard-design.md`（全檔，新建）/ 商品公告進 wizard 設計：新 `announcement` domain module（首個非 product 形狀）+ module-local svc-b2c client（不碰 core GatewayClient）+ 獨立入口 `be2_open_announcement_wizard` + 專用建立表單面板 / 把 BAA 塊 C（公告）補進 MCP，驗 `ActionModule` 介面對非 product domain 的通用性。首發動作=create 全欄位；生效走原生 startTime/endTime、不做排程；live 寫入卡 svc-b2c S2S 403（build+draft 可）。3 個關鍵決策經使用者拍板：(1) create 全欄位 (2) 專用建立表單面板 (3) 獨立入口 sibling tool（因 uiResourceUri 一 tool 綁一面板、無法動態切，且避 Session 2 衝突）。
- 同檔 §4.3/§5.1/§5.9/§8/§10（agy review round 1 兩修一納）/ (1) **§4.3**：user-uuid header 改由 accessToken 自解 platformId（讀 diff/view/寫 executor 三處統一），原設計「從 ExecCtx 拿 modifyUser」對讀取路徑不成立（DiffCtx/AppToolContext 刻意不含 modifyUser、只含 accessToken）；(2) **§5.9**：通用 changeset-panel.ts 的 itemKeyOf 硬寫只認 inv/shelf，announcement diff（僅 prod_oids[]）會 fallback 回 "undefined" → CONFIRMED_KEYS_MISMATCH 永遠無法批准 → 加 announcement 分支；(3) §5.1 itemKey 用 [...prod_oids].sort() 非就地 mutate / agy 抓到讀取路徑無 modifyUser、通用面板 itemKey fall-through（rounds=2 APPROVED）。

- 同檔 §5.2/§5.7（plan 的 agy review round 1 兩修，回頭補齊 spec 內部一致性）/ (1) §5.2 `AnnouncementDiffItem` 補 `contents` 欄位——原本 §5.5 hash 與 §5.7 renderer 都引用 contents 但 diff item 沒帶 → 確認頁看不到內文 = blind write；(2) §5.7 renderer 明訂 start/end 走**伺服器端雙時區**（UTC + GMT+8 固定偏移）/ agy 審 plan 時抓到 diff item 缺 contents（內部矛盾）與確認頁只顯示 UTC 單時區（§5.7/§10 要雙時區）。

- 同檔 §5.2/§5.3/§5.5/假設#4（code-review 收尾兩修）/ (1) `en-default` warn 明訂放在**確認頁 renderer + 面板 step-3**（validate 是 error-or-null 無 warn 通道）——實作前漏了這條 warn，code-review Spec 軸抓到；(2) `AnnouncementDiffItem.existing_count` 由 `number`(用 -1 當未知哨兵) 改為 `number | null`（null=未知），去除 primitive-obsession 哨兵（code-review Standards 軸）/ agy 雙軸 code-review（PR #19）發現的 2 個塊 C 真落差。

- `2026-08-20-be2-mcp-inventory-quantity-wizard-design.md` §5.3（code-review 收尾）/ `would_go_negative` 欄位：SET-only 改寫後恆 false=死欄位，spec 從「欄位保留供 renderer/型別一致」改為「刻意移除，YAGNI；重引入 adjust 再加回」——對齊實作已移除的事實（code-review Spec 軸發現 spec 說留、code 沒留）/ agy 雙軸 code-review（PR #19）發現的塊 A 落差。
- 跨模組（code-review Standards 軸 Duplicated Code 收斂，非 spec 檔異動，附記）/ 抽 `src/gateway/httpJson.ts` 共用 HTTP-JSON 原語（fetch+timeout+json+unreachable→502），`GatewayClient`(get/put/post) 與 announcement `svcB2cClient`(list/create) 皆改用之，消除各自手刻 fetch 骨架的重複；行為不變（gatewayClient/svcB2cClient 測試 15/15 綠）。

## 2026-08-19

- 建立本 CHANGELOG（追溯補記上述 2026-08-16/18 的 spec 異動）/ 落實新增的「規格變更」規則。
- **待議（規格 vs 實作衝突，先記不靜默繞過）**：`2026-08-18-module-factory-design.md` §4 分工表寫「段② 六格由 agy 並行實作」，但實測 agy 在 headless accept-edits 下每次都想跑 shell（`pwd` 等非白名單指令）被拒→零產出，bundle 首發五格全由 Claude fallback 寫。→ **spec §4/§3.1 的「agy 主寫、Claude fallback」與現實不符，實際是「Claude 主寫、agy 為機率性加速」**。改 spec 前先解 agy allowlist（見下 evaluation），視放行後 agy 是否可用再定 spec 措辭。allowlist 評估（放行 8 個唯讀指令 pwd/which/dirname/basename/realpath/test/stat/date、寫入/執行/網路/憑證維持批准）已提交使用者、待改 agy settings.json 後實測驗證。
- `2026-08-18-module-factory-design.md` §4（agy 分工措辭修正）/ 把「agy 主寫、Claude fallback」改為「agy 段② 需兩前置（pwd 放行 + 絕對路徑/trusted workspace），前置備齊即可用；bundle 首發因前置未備才全走 fallback」/ **解掉 2026-08-19 待議的 spec-vs-實作衝突**——2026-08-19 追到底並實測確認 agy 前置修好後能寫 repo，故非「agy 不可用」而是「前置未備」。
- `2026-08-18-module-factory-design.md` §4（段② 實作者可插拔）/ 分工表「② 六格 = agy 並行」改為「可插拔實作者：預設 Claude subagent（通用），agy 為 lance 本機省額度選項」/ **可攜性**——skill 不該把 agy 寫死（agy 是特定使用者本機設定，別人用 Claude subagent）。同步改 SKILL.md 後端偵測、stage2-produce.md 加 Claude subagent 後端段、memory agy-work-allocation 標 lance 專屬。



<!-- agy-peer-reviewed: 2026-08-20T07:20:00Z rounds=3 verdict=approved -->
