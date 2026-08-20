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

**時區規則(一級需求)**:
1. 輸入 = 牆鐘字串 + server 端 `BE2_TZ`;server 用 `Intl.DateTimeFormat` 換算成 UTC epoch **一次**,之後所有比較只用 `execute_at_utc`。
2. 呈現(確認頁/wizard/稽核)一律回放 `schedule_wall + schedule_tz` 原文,**不從 epoch 反推**(避免 DST/邊界二次換算誤差;`Asia/Taipei` 無 DST,但規則要 DST-safe)。
3. 驗證:換算後必須 `now + MIN_LEAD(預設 5min) ≤ execute_at_utc ≤ now + HORIZON(預設 30d)`;無效牆鐘(不存在的時刻)拒絕。
4. 測試必含:跨日邊界(23:59/00:00)、月末、假想 DST 時區(如 `America/New_York` 春季跳時)確認換算函式泛用。

## 5. 排程的建立與批准綁定(防 TOCTOU)

- `createChangesetCore` input(`src/core/changeset/tools.ts:26`)加選填 `schedule: {wall: string}`;`getModule(action_type).schedulable !== true` 時帶 schedule 一律拒建(`SCHEDULE_NOT_SUPPORTED`)。model-visible `be2_create_changeset` 與 app-only `app_create_changeset` 同享(北極星:能力在底層,agent 可從自然語言「明天 09:00 把庫存改 50」直接建排程草稿)。
- **schedule 是 change-set 的不可變部分**(建立後不可改;要改=取消重建)。
- 批准綁定:`app_confirm_changeset` / `POST /confirm/:id/approve` 的 approve 參數新增 `expected_execute_at_utc` 回聲;server 比對不符 → 409(同 `confirmed_keys` 綁 items、`diff_version` 綁內容的既有模式,時間也要被人看到什麼就批什麼)。無 schedule 的 change-set 不得帶此參數,反之必帶。
- 批准流程(`confirmService.ts:52 approveAndExecute`)分岔:前段完全相同(confirmed_keys 校驗 → live-diff 重算 + stale 409 → 解析 modifyUser)→ 有 schedule 時 `casStatus(pending_approval → scheduled)`、持久化 `executor_identity_id/label/modify_user`、audit `changeset.approve`(帶 `scheduled_for`)、**不呼叫 executeChangeSet**、nonce 照常單次消耗。

## 6. 延遲執行身分(靠 Option 1 token store)

- 批准當下把批准者(面板=MCP bearer credential 對應 identity;確認頁=web session 對應 identity)解析成 **identityId** 存欄。到點 `TokenManager.freshFromIdentity(identityId)`(`tokenManager.ts:48`,per-identity single-flight 已內建)取新鮮 access token 組 `ExecutorIdentity` 執行。
- **fail-closed 鏈完整保留**:到點 refresh 走 auth-service(檢查 user_status、回 fresh businessList);`REAUTH_REQUIRED`(4xx)→ change-set 標 `failed`(error_code `AUTH_EXPIRED`),不執行。離職/停權在 T 前生效即自動擋下。
- **keep-alive(讓 horizon 成立的必要機制)**:be2 refresh token 有 TTL,批准與 T 之間若無人活動,identity 可能過期。scheduler 每 tick 對「被 `scheduled` change-set 引用、access 將於 2×tick 內到期」的 identity 做一次 `freshFromIdentity` 保鮮(refresh rotate 順帶延長 refresh)。安全論證:僅為「已獲人工批准、待執行」的變更續命;每次 refresh 都過 auth-service user_status 檢查(撤權即斷)、都寫 audit(`schedule.keepalive`);不為任何未批准之物續 token。
- **purge 保護**:`oauth-purge` 的 ghost identity 清理需排除「被非終態 `scheduled` change-set 引用」的 identity。
- web session 在 T 前登出/過期**不影響**排程執行(綁 identity 非 session)——寫進確認頁文案。

## 7. Scheduler 元件(`src/core/schedule/scheduler.ts`,新檔)

- `startScheduler(deps, {intervalMs=30_000, graceMs=1_800_000, now})` → 回 `stop()`;`buildApp` 組裝、`src/index.ts` 啟動(測試不啟動,直接呼叫 `tick()`)。
- 每 tick:
  1. 撈 `status='scheduled' AND execute_at_utc <= now()` 的 id 清單。
  2. 逐件:`now - execute_at_utc > graceMs` → `casStatus(scheduled → missed)` + audit(`schedule.missed`);否則 `casStatus(scheduled → approved)` 認領,贏者 `freshFromIdentity` 組身分 → `executeChangeSet`(executor 自己會 `setStatus('executing')` → 終態,`executor.ts:37/68`,零改動);refresh 失敗 → `setStatus('failed')` + error audit。
  3. keep-alive 掃描(§6)。
- **多實例論證(回應 handoff「需 leader election」——不需要)**:認領是單 statement 條件式 UPDATE(`WHERE id=? AND status='scheduled'`),與既有防重複執行 CAS 同一原語,`deploy-architecture.md` §1.5 已認定跨實例安全。每實例都跑 poller,同一件只有一個實例 CAS 成功 → at-most-once 認領,**不新增 Redis/leader 依賴**。既有 3 個記憶體原語(inflight/nonce/mutex)的多實例限制不因本塊擴大。
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
- 必測:時區換算(§4.4 邊界)、TOCTOU 回聲不符 409、CAS 認領競態(兩個 tick 併發同件只執行一次)、grace 超窗 → missed、refresh 失敗 → failed(AUTH_EXPIRED)、取消後 tick 不執行、非 schedulable module 帶 schedule 拒建、conformance harness(`tests/core/moduleConformance.test.ts`)擴 `schedulable` 欄位不破既有 module、eval 案例(agent 建排程草稿但無法自批/自取消)。
- 手動驗收(live):SIT 建 5 分鐘後排程 → 確認頁看到時間 → 到點自動執行 → ledger 讀回。**寫入仍卡 AU9403/stage grant,live 驗收延後不阻擋開發**(同塊 A)。

## 12. 文件回改

- `deploy-architecture.md` §1.5:「訊息佇列/worker ❌(排程發送是 client-side)」→ 改為「server 內建 scheduler(in-process poller,無外部 queue);多實例認領靠 DB CAS,不新增 Redis 依賴」;cron 一節註明 oauth-purge 需排除 scheduled 引用的 identity。
- `docs/superpowers/specs/CHANGELOG.md` 記一筆。
- module-onboarding.md:補 `schedulable` opt-in 欄位說明。
