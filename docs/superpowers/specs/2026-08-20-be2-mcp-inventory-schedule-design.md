# be2-mcp 塊 B:庫存數量到點派送排程層 — 設計 spec

> 日期:2026-08-20。分支基底:`feat/bundle-followup`(塊 A 庫存數量 SET/fullday 已進 wizard,PR #19)。
> Probe 前提:**be2 backend 無庫存數量原生排程端點**(`docs/be2-mcp/probe-inventory-native-schedule.md`,源碼實證+對照組)→ 走 handoff「若無」分支:be2-mcp server 端排程器。
> 北極星(已定案勿再爭):wizard 只是 UX 友善層,能力靠底層(change-set + 排程層)成立;時區是一級需求。

## 0. 假設清單(替代逐題釐清;背景 session 無人可答,錯了請退回)

| # | 假設 | 依據 |
|---|---|---|
| A1 | 排程只對 `inventory_setting`(fullday SET)開放;上下架有原生 reserve_queue、公告有原生 startTime/endTime,不用本層 | handoff §2 原生排程分類 |
| A2 | be2 營運時區單一,以 env `BE2_TZ`(IANA,預設 `Asia/Taipei`)為準;不做 per-user 時區 | 手冊/截圖 GMT+8/+9 混見 → 用 env 收斂,部署時定案 |
| A3 | 執行語意 = **declarative SET**:批准的是「時間 T 時庫存應為 X」;批准後至 T 的自然庫存漂移(銷售)**不視為 stale、不擋執行** | SET/fullday 語意;若擋,排程功能形同虛設 |
| A4 | 排程上限視野(horizon)預設 30 天(env 可調);超過拒建 | 庫存排程屬近期營運操作 |
| A5 | 執行結果不主動通知(v1);使用者靠 wizard ledger / `be2_get_changeset_status` / 確認頁查 | 通知通道(Slack/mail)另案 |

## 1. 範圍

**In**:core 排程能力(狀態機 + schema + scheduler + 延遲執行身分)、`inventory_setting` opt-in、wizard 批准步驟排程輸入、取消、misfire 策略、`deploy-architecture.md` §1.5 回改。
**Out**:其他 action_type 開排程(機制泛用但預設關)、週期性排程(只做一次性)、執行結果推播通知、多次重試策略(失敗即終態)。

## 2. 方案比較(結論:A)

| 方案 | 內容 | 取捨 |
|---|---|---|
| **A(採用)core 泛用排程** | `ChangeSetStatus` 增 `scheduled/cancelled/missed`;批准時 CAS→`scheduled` 並持久化批准者 identity 參考;server 內建 poller 以 DB CAS 認領到期件;module `schedulable` opt-in | 排程是 change-set 生命週期治理 → 歸 core 正當(塊 B seam 本來就是「change-set 執行/排程層」,非 module 上車);狀態機單一可見;多實例靠既有 CAS 免 Redis |
| B module-local 排程表 | inventory module 自帶 side table + 自己的 timer | 治理分裂:排程中的變更不在 change-set 狀態機裡,確認頁/稽核/預算全部看不到;每個未來要排程的 module 重造一次 |
| C client-side 到點送 | 面板/Desktop 開著才 dispatch(原版 BAA 語意) | 「Mac 醒著才送」不可靠;handoff 已標僅備選;server 常駐本來就是搬進 MCP 的理由 |

## 3. 狀態機擴充

```
pending_approval ──approve(即時)──> approved ──> executing ──> done|partial|failed
pending_approval ──approve(排程)──> scheduled ──到點認領──> approved ──> executing ──> …
pending_approval ──reject──> rejected        pending_approval ──TTL──> expired
scheduled ──cancel(人工)──> cancelled        scheduled ──超過 grace──> missed
approved(排程認領後) ──transient refresh 失敗 / stranded 回收──> scheduled(放回重試,§7)
```

- `ChangeSetStatus` union(`src/core/changeset/types.ts:2`)8 → 11:加 `scheduled`、`cancelled`、`missed`(皆終態除 `scheduled`)。
- 惰性 TTL 過期只作用於 `pending_approval`(`store.ts:30`,已確認),`scheduled` 不受影響——排程件已獲人工批准,存活至 T。
- 所有轉移沿用既有 `casStatus` 條件式 UPDATE(`store.ts:59`),跨實例安全。

## 4. Schema(`src/store/db.ts` change_sets 加欄,PRAGMA 補丁式遷移沿用)

| 欄位 | 型別 | 說明 |
|---|---|---|
| `execute_at_utc` | INTEGER(epoch ms)| 到點時間,**唯一用來比較/排序的時間欄** |
| `schedule_wall` | TEXT | 使用者輸入的牆鐘 `YYYY-MM-DDTHH:mm` |
| `schedule_tz` | TEXT | 建立當下的 IANA 時區(來自 `BE2_TZ`) |
| `executor_identity_id` | TEXT | 批准者的 be2_identities 參考(到點取 token 用) |
| `executor_label` / `executor_modify_user` | TEXT | 批准當下解析並凍結(audit + PUT body 用) |
| `executor_session_id` | TEXT | 批准者的 sessionId(`ExecutorIdentity.sessionId` 必填;audit 歸屬批准者,**不得** fallback 到 creator 的 `rec.session_id`) |
| `schedule_claimed_at` | INTEGER | scheduler 認領章(認領 UPDATE 同 statement 寫入);stranded-approved 回收的判準(§7) |
| `keepalive_claimed_at` | INTEGER | (加在 `be2_identities` 表,非 change_sets)keep-alive 認領章,防多實例重複 refresh(§6) |

**時區規則(一級需求)**:
1. 輸入 = 牆鐘字串 + server 端 `BE2_TZ`;server 用 `Intl.DateTimeFormat` 換算成 UTC epoch **一次**,之後所有比較只用 `execute_at_utc`。
2. 呈現(確認頁/wizard/稽核)一律回放 `schedule_wall + schedule_tz` 原文,**不從 epoch 反推**(避免 DST/邊界二次換算誤差;`Asia/Taipei` 無 DST,但規則要 DST-safe)。
3. 驗證:換算後必須 `now + MIN_LEAD(預設 5min) ≤ execute_at_utc ≤ now + HORIZON(預設 30d)`;無效牆鐘(不存在的時刻)拒絕。
4. 測試必含:跨日邊界(23:59/00:00)、月末、假想 DST 時區(如 `America/New_York` 春季跳時)確認換算函式泛用。

## 5. 排程的建立與批准綁定(防 TOCTOU)

- `createChangesetCore` input(`src/core/changeset/tools.ts:26`)加選填 `schedule: {wall: string}`;`getModule(action_type).schedulable !== true` 時帶 schedule 一律拒建(`SCHEDULE_NOT_SUPPORTED`)。model-visible `be2_create_changeset` 與 app-only `app_create_changeset` 同享(北極星:能力在底層,agent 可從自然語言「明天 09:00 把庫存改 50」直接建排程草稿)。
- **schedule 是 change-set 的不可變部分**(建立後不可改;要改=取消重建)。
- 批准綁定:`app_confirm_changeset` / `POST /confirm/:id/approve` 的 approve 參數新增 `expected_execute_at_utc` 回聲;server 比對不符 → 409(同 `confirmed_keys` 綁 items、`diff_version` 綁內容的既有模式,時間也要被人看到什麼就批什麼)。無 schedule 的 change-set 不得帶此參數,反之必帶。
- 批准流程(`confirmService.ts:52 approveAndExecute`)分岔:前段完全相同(confirmed_keys 校驗 → live-diff 重算 + stale 409 → 解析 modifyUser)→ 有 schedule 時**先驗未過期**(`execute_at_utc ≤ now` → 409 `SCHEDULE_IN_PAST`,人必須取消重建;不允許「批准過期排程→下個 tick 靜默 missed」。**注意閾值刻意與建立時不同**:建立要求 `now + MIN_LEAD`(5min)留審查餘裕,批准只要求「仍在未來」——若批准也用 MIN_LEAD,建立時剛好 5 分後的排程在人審完 diff 點批准的瞬間必然 409,tight schedule 永遠批不過)→ `casStatus(pending_approval → scheduled)`、持久化 `executor_identity_id/session_id/label/modify_user`、audit `changeset.approve`(帶 `scheduled_for`)、**不呼叫 executeChangeSet**、nonce 照常單次消耗。
- **identityId threading(結構性前置,現碼拿不到)**:`ApproveWho` 現只有 `{accessToken, userLabel, sessionId}`;`TokenManager.getFreshAccessToken` 回的 `UserAuthContext` 也無 identityId。需把 `identityId` 加進 `UserAuthContext` 與 `ApproveWho`(兩通道:面板=bearer credential 解出的 identity;確認頁=web session 綁的 identity),批准時才存得進欄位。這是本塊對 auth 層的唯一介面變更,向後相容(加欄位)。

## 6. 延遲執行身分(靠 Option 1 token store)

- 批准當下把批准者(面板=MCP bearer credential 對應 identity;確認頁=web session 對應 identity)解析成 **identityId** 存欄(threading 見 §5)。到點取新鮮 access token 組 `ExecutorIdentity`(sessionId 用凍結的 `executor_session_id`)執行。
- **TokenManager 公開 API(現碼不足,需新增)**:`freshFromIdentity` 是 private 且收 `Identity` 物件、`IdentityStore` 也封在 TokenManager 內——scheduler 結構上呼叫不到。新增兩個公開方法,**不**讓 scheduler 穿透封裝:
  - `getFreshByIdentityId(identityId): Promise<{accessToken, userLabel}>` — 內部走既有 `freshFromIdentity`(沿用 in-process single-flight 與 REAUTH_REQUIRED fail-closed)。
  - `keepAlive(identityIds: string[]): Promise<void>` — 內部自查各 identity 的 `accessExpiresAt`,只對「將於 keep-alive 窗內到期」者 refresh;到期判斷留在 TokenManager 內,scheduler 只給名單。
- **fail-closed 鏈完整保留**:到點 refresh 走 auth-service(檢查 user_status、回 fresh businessList);`REAUTH_REQUIRED`(4xx)→ change-set 標 `failed`(error_code `AUTH_EXPIRED`),不執行。離職/停權在 T 前生效即自動擋下。
- **keep-alive(讓 horizon 成立的必要機制)**:be2 refresh token 有 TTL,批准與 T 之間若無人活動,identity 可能過期。scheduler 每 tick 收集「被 `scheduled` change-set 引用」的 identityId 呼叫 `tokenManager.keepAlive()`(refresh rotate 順帶延長 refresh)。安全論證:僅為「已獲人工批准、待執行」的變更續命;每次 refresh 都過 auth-service user_status 檢查(撤權即斷)、都寫 audit(`schedule.keepalive`);不為任何未批准之物續 token。
- **keep-alive 多實例防撞(DB claim)**:single-flight 只擋 in-process 並發;多實例同時主動 refresh 同一 identity 會撞 rotation(輸方 4xx → `onReauthRequired` 誤刪 credential → 排程件誤標 failed)。故 `keepAlive` refresh 前先以條件式 UPDATE 認領 `be2_identities.keepalive_claimed_at`(`WHERE id=? AND (claimed IS NULL OR claimed < now - tickMs)`),輸方本 tick 跳過——同一原語、免 Redis。**殘餘風險(既有、非本塊新增)**:keep-alive 與「使用者活動觸發的 lazy refresh」跨實例相撞,屬 `deploy-architecture.md` §1.5 既列的 refresh single-flight 多實例限制(3 原語之一),多實例部署本來就需 Redis 收斂,本塊不改變該結論。
- **purge 保護**:`oauth-purge` 的 ghost identity 清理需排除「被非終態 `scheduled` change-set 引用」的 identity。
- web session 在 T 前登出/過期**不影響**排程執行(綁 identity 非 session)——寫進確認頁文案。

## 7. Scheduler 元件(`src/core/schedule/scheduler.ts`,新檔)

- `startScheduler(deps, {intervalMs=30_000, graceMs=1_800_000, now})` → 回 `stop()`;`buildApp` 組裝、`src/index.ts` 啟動(測試不啟動,直接呼叫 `tick()`)。
- 每 tick:
  1. 撈 `status='scheduled' AND execute_at_utc <= now()` 的 id 清單。
  2. 逐件:`now - execute_at_utc > graceMs` → `casStatus(scheduled → missed)` + audit(`schedule.missed`);否則 `casStatus(scheduled → approved)` 認領(同 statement 寫 `schedule_claimed_at=now`),贏者 `getFreshByIdentityId` 組身分 → `executeChangeSet`。
  3. **refresh 失敗分流(不得把暫時性故障變永久 failed)**:terminal(`REAUTH_REQUIRED`,4xx 撤權/過期)→ `setStatus('failed')`(error_code `AUTH_EXPIRED`)+ audit;**transient(5xx/timeout/網路)→ `casStatus(approved → scheduled)` 放回**,下個 tick 重試(是否還來得及由步驟 2 的 grace 判準決定)。背景排程沒有「人在螢幕前重按」的即時重試,不能沿用即時路徑的一次定生死。
  4. **stranded-approved 回收**:撈 `status='approved' AND execute_at_utc IS NOT NULL AND now - schedule_claimed_at > staleClaimMs(預設 10min)` → `casStatus(approved → scheduled)` 放回(claim 後、執行前 crash 的件才會停在這;放回後由步驟 2 決定執行或 missed)。**回收安全的前提是 executor 開頭改 CAS**(見下),否則回收與「還活著只是慢」的實例會雙重執行。
  5. keep-alive 掃描(§6,含 DB claim)。
- **executor 微改(exactly-once 執行起點)**:`executeChangeSet` 開頭的 `setStatus('executing')`(`executor.ts:37`)改為 `casStatus(approved → executing)`,**輸了就 abort(回 null/不執行、不寫結果)**。即時批准路徑不受影響(該路徑本來就從 `approved` 進來);排程路徑因此獲得結構性防雙執行:回收方與慢實例最多一方能贏這個 CAS。crash 發生在 `executing` 之後仍不自動復原(可能已部分寫入,沿用既有已知限制)。
- **多實例論證(回應 handoff「需 leader election」——不需要)**:到期認領與 keep-alive 認領都是單 statement 條件式 UPDATE,與既有防重複執行 CAS 同一原語,`deploy-architecture.md` §1.5 已認定跨實例安全。每實例都跑 poller,同一件只有一個實例 CAS 成功 → at-most-once,**scheduler 本身不新增 Redis/leader 依賴**。既有 3 個記憶體原語(refresh inflight/nonce/mutex)的多實例限制不因本塊擴大(keep-alive 與 lazy refresh 相撞的殘餘風險歸屬原語 #1,見 §6)。
- 錯過的 tick(server 重啟/停機):啟動即補跑一次 tick;停機期間到點者由 grace 窗吸收,超窗標 `missed`(寧可不執行也不在脫離語境數小時後亂寫庫存——`missed` 是明確可見的終態,使用者可重建)。
- 已知限制(沿用既有行為):執行中 crash 會停在 `executing`,不自動復原(SET 雖冪等,core 不對 module 冪等性做假設);啟動時對 stranded `executing` 記 audit 警示。

## 8. 取消

- **確認頁**:`status='scheduled'` 的 change-set 頁面顯示排程資訊(`schedule_wall + tz` + 倒數)與「取消排程」按鈕 → `POST /confirm/:id/cancel`,沿用 session cookie + `sameUser` 把關;`casStatus(scheduled → cancelled)` + audit。
- **面板**:`app_confirm_changeset` 的 `decision` 加 `'cancel'`(僅對 `scheduled` 合法);`app_get_changeset_view` 對 `scheduled` 也發 nonce(現只對 pending_approval),取消同樣走 nonce 單次消耗——維持「批准/取消憑證 agent 結構上拿不到」不變式。
- 取消是唯一允許的人工轉移;`cancelled` 為終態。

## 9. Wizard / 呈現接線(UX 層,最薄)

- 批准步驟(`src/ui/batch-wizard.ts` inventory 分頁):「立即執行 ⇄ 排程到點執行」切換 + `datetime-local` 輸入(標示 `BE2_TZ`);建 change-set 時帶 `schedule.wall`,批准時帶 `expected_execute_at_utc` 回聲。
- 結果/ledger:`scheduled` 狀態藥丸(顯示到點時間)+ 取消按鈕;`cancelled/missed` 藥丸。
- 確認頁 renderer(core 層,非 module):有 schedule 時頂部顯著顯示「將於 {wall} ({tz}) 執行;現況為批准當下快照,執行時庫存可能已因銷售變動,將以 SET 目標值覆寫」(A3 語意透明化)。
- `be2_get_changeset_status` 回傳加 schedule 欄位(model 可答「排程什麼時候跑」)。

## 10. 安全不變式(全數保留 + 新增)

1. agent 拿不到批准/取消憑證(nonce app-only 發放、確認頁靠 SSO session)——不變。
2. 排程不繞過任何既有 gate:businessList fail-fast、scope 讀取閘門、rate budget、live-diff stale 檢查全在批准前照跑。
3. 時間被批准綁定(`expected_execute_at_utc` 回聲)——人看到的時間=執行的時間。
4. 延遲執行 fail-closed:到點 refresh 過 auth-service(user_status);撤權即擋。
5. keep-alive 僅服務已批准排程件、全程 audit。

## 11. 測試策略

- 全走既有慣例:注入 `now: () => number` 手動時鐘(repo 無 fake timer 先例),scheduler 測試直接呼叫 `tick()` 推進 `t`。
- 必測:時區換算(§4.4 邊界)、TOCTOU 回聲不符 409、批准已過期排程 → 409 `SCHEDULE_IN_PAST`、CAS 認領競態(兩個 tick 併發同件只執行一次)、keep-alive DB claim(兩個併發 keepAlive 只 refresh 一次)、grace 超窗 → missed、terminal refresh 失敗 → failed(AUTH_EXPIRED)+ audit 歸屬批准者 sessionId、**transient refresh 失敗 → 放回 scheduled 且下 tick 重試成功**、**stranded approved(claim 後 crash 模擬)超過 staleClaimMs 被回收放回**、**executor CAS 起點:兩個併發 executeChangeSet 只有一個執行**、取消後 tick 不執行、非 schedulable module 帶 schedule 拒建、conformance harness(`tests/core/moduleConformance.test.ts`)擴 `schedulable` 欄位不破既有 module、eval 案例(agent 建排程草稿但無法自批/自取消)。
- 手動驗收(live):SIT 建 5 分鐘後排程 → 確認頁看到時間 → 到點自動執行 → ledger 讀回。**寫入仍卡 AU9403/stage grant,live 驗收延後不阻擋開發**(同塊 A)。

## 12. 文件回改

- `deploy-architecture.md` §1.5:「訊息佇列/worker ❌(排程發送是 client-side)」→ 改為「server 內建 scheduler(in-process poller,無外部 queue);多實例認領靠 DB CAS,不新增 Redis 依賴」;cron 一節註明 oauth-purge 需排除 scheduled 引用的 identity。
- `docs/superpowers/specs/CHANGELOG.md` 記一筆。
- module-onboarding.md:補 `schedulable` opt-in 欄位說明。

<!-- agy-peer-reviewed: 2026-08-20T12:53:05Z rounds=4 verdict=approved -->
