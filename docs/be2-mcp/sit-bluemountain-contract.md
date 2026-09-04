# 契約 — blueMountain 工單讀取 API（經 api-gateway）

> Live probe 於 2026-09-04 跑通：**SIT `be2-220` / stage / production 三環境**，四支端點全部 200。
> 檔名沿用 repo 的 `sit-*-contract.md` 慣例；內容涵蓋三環境的差異（見 §5.5）。
> 重跑：`npm run probe-sit-bm -- <orderMid|discover> [BCS|CRM|AM]`（`scripts/probe-sit-bluemountain.ts`）。
> 用途：把 Slack `@operation-bot` 的「訂單工單摘要」搬進 be2-mcp 成為一支 L0 read tool。

> ⚠️ **本 repo 為 public。** 本文件裡的訂單編號一律只留末四碼、人員一律以角色代號表示
> （`<CS-A>` / `<OP-B>` …），工單 oid 保留（無存取權時不具識別性）。新增內容請沿用此規則。

---

## 1. 結論：走 API，不打 DB

blueMountain（CS/OP 工單系統）有完整的唯讀 HTTP API，**已被 api-gateway 以 `/bluemountain` 前綴代理，認證就是 be2-mcp 手上已持有的 be2 access token**（`Authorization: Bearer`，**不帶 service key**）。

參考實作 `smart-slack-ai` 是直連 PG `postgresql-smalldb.kkday.com` / `kkdb_bluemountain`。**be2-mcp 不沿用這條路**——走 API 讓授權留在 gateway（不自建 RBAC，符合 CLAUDE.md 鐵則 #3），且天然做到 PII 最小化（見 §5）。

| | 直連 PG | 走 gateway API（採用） |
|---|---|---|
| 授權 | 無，要自建 | gateway → auth-service `/verify` |
| PII | 整包 `extra_info`（含護照號、身分證號、過敏資料） | DTO 白名單，實測無外洩 |
| 新增 egress | `postgresql-smalldb`（新） | 無，沿用 `GATEWAY_URL` |
| 新增憑證 | DB 帳密（新） | 無 |
| 代碼翻譯 | 自己反推（無 lookup table） | `dictionary-code/list` 部分提供 |

---

## 2. 端點與 envelope

Base：`{GATEWAY_URL}/bluemountain`（gateway 剝掉前綴後打到 BM 的 `/api/v1/...`）。**全部是 POST，連讀取也是。**

Request body（`RestApiReq<T>`，`controller/data/base/RestApiReq.java`）：

```json
{ "authKey": "BCS", "serviceName": "BCS", "data": { ... } }
```

Headers：`authorization: Bearer <be2 access token>`、`content-type: application/json`、`request-uuid: <uuid>`。

### `serviceName` 必須是 `BCS` — 已實證

| 值 | 結果 |
|---|---|
| **`BCS`** | ✅ 200，正常分頁回應 |
| `CRM` | ❌ `{"status":"NU03","desc":"查詢 Slack Id 失敗: CRM"}` |

原因在 `filter/UserFilter.java:106-137, 205-216`：只有 `authKey === serviceName === "BCS"`（或 `"AM"`）會走 **gateway-JWT 分支**，從 Bearer token 解出真實 authKey。其他值走 direct-call 分支，把字面值當 authKey 去查使用者而失敗。

### 四支端點

| 端點 | data 參數 | 回傳 |
|---|---|---|
| `POST /api/v1/ticket-event/list` | `{orderMid, taskStatus?, memberUuid?, page}` | `TicketTaskInfoResp[]`（**主力**，欄位最全，有 `parentTaskOid`） |
| `POST /api/v1/ticket-event/search` | `{orderMid?, taskOid?, supplierOid?, productOid?, taskStatus[]?, taskTypeOid?, taskKind?, currentUuid?, currentGroupOid?, …, page}` | `SearchTicketTaskResp[]`（欄位較窄，**無 `parentTaskOid`**） |
| `POST /api/v1/ticket-event/one` | `{taskOid}` | 單張完整詳情（含 `mainOriginalMessage`/`childOriginalMessage`/`taskExtraInfo`） |
| `POST /api/v1/ticket-event/logs` | `{taskOid, filter?, page}` | `TaskLogResp[]`（時間軸主素材；`filter=1` 只看後拋類） |
| `POST /api/v1/ticket-common/dictionary-code/list` | `{types[], userType}` | 代碼→中文名對照樹 |

**分頁**（`PageReq`）：`{currentPage: ≥1, pageSize: ≥1, sortProperty?, sortDirection?}`
- ticket 類 `pageSize` 上限 **100**（`BaseTicketTaskPageReq:getMaxPageSize`），預設排序 `lastProcessTime`
- log 類上限 **50**（`CommonConstant.MAX_PAGE_SIZE`），預設排序 `modifyDate`

**Response envelope**：`{metadata: {status, desc}, data: <T | T[]>, page?: {totalPages, pageSize, currentPage, size, total}}`
`metadata.status === "0000"` 為成功。**分頁回應的 `data` 直接是陣列，不是 `data.content`。**

---

## 3. 實測回傳形狀（2026-09-04, SIT be2-220）

### `ticket-event/list` / `one` — `TicketTaskInfoResp`

`one` 的完整欄位：
```
createUser, createDate, modifyUser, modifyDate, taskOid, parentTaskOid,
taskTypeOid, taskTypeCode, taskKindCode, taskStatus, taskStatusCode,
orderMid, productCategory, prodOid, memberUuid, createFrom, relationType,
relationCode, createFromCustom, requesterType, resolveSummary, createTime,
createUuid, currentUuid, lastProcessTime, finishTime, taskLabels, taskFlags,
overdueChoiceCode, overdueRemark, overdueAutoProcessed, overdueProcessTime,
assistMemos, mainOriginalMessage, childOriginalMessage, assistRejectMessageCode,
assistRejectMessage, reserveReasonCode, reserveMemo, transferFromUuid,
transferReasonCode, assistType, assistRelationCode, attachmentFiles,
replyAttachmentFiles, outBoundSendBatchOid, outBoundSourceTaskOid, needOutBound,
needOutBoundReply, outBoundSender, outBoundChannel, outBoundMessage,
isCurrentUserTask, taskExtraInfo, supplierOid
```

主單 / 後拋子單都在同一份回傳裡，靠 `parentTaskOid` 區分（null = 主單）。

### `ticket-event/search` — `SearchTicketTaskResp`（較窄）
```
taskOid, supplierOid, orderMid, productOid, goDate, currentUuid,
currentGroupOid, currentGroupCode, createUuid, createGroupOid, createGroupCode,
createTime, taskStatus, taskStatusCode, taskTypeOid, taskTypeCode,
taskKindCode, lastProcessTime, finishTime, canTransfer
```

### `ticket-event/logs` — `TaskLogResp`
```json
{
  "createUser": "<email>", "currentUuid": "<email>",
  "createTime": "2026/05/25 07:56:46.013",
  "taskLogOid": 2747, "taskOid": 5,
  "taskLogTypeCode": "task_log_type_code_4",
  "remarkContentStyle": 2,
  "remarkContent": [
    { "remarkTitle": "task_log_item_code_14", "remarkValue": 481,
      "remarkType": "text", "remarkI18nKeyPrefix": null },
    { "remarkTitle": "task_log_item_code_15", "remarkValue": "task_log_item_code_17",
      "remarkType": "i18nKey", "remarkI18nKeyPrefix": null }
  ]
}
```

比直連 PG 好處理：`remark` 已被 parse 成物件陣列，不用處理「BQ 回字串 / PG 回物件」兩種形狀。

### 敘事素材覆蓋率 — 實測 `26KK…0835`（SIT，18 張工單）

驗證問題：**走 API 拿不拿得到 smart-slack-ai 靠直連 PG 拿到的敘事素材？答案是拿得到。**

| 指標 | 實測 |
|---|---|
| `list` 一次回傳的工單 | 18 張（`page.total=18`），主單 + 後拋子單全在同一份 |
| 父子鏈 | 完整（`#174 → #175 → #304`、`#1267 → #1710`…），靠 `parentTaskOid` / `taskKindCode` |
| `task_log` 總數 | 138 條 |
| 有可抽取文字的 log | **69 條（50%）** |
| `mainOriginalMessage` 有值 | 1 張 |
| `childOriginalMessage` 有值 | 3 張 |
| PII 掃描 | **clean** |

log 抽出來的形狀就是 smart-slack-ai 組 `[時間] 人 [動作] — 內文` 需要的全部：
```
log #174 2026/03/17 09:43:59.205 <user-C> task_log_type_code_4  -> <user-C> | dawn test assist
log #304 2026/04/02 02:35:28.957 <user-D>  task_log_type_code_13 -> <user-E>
```
（SIT 是測試資料，內文為 `sssss1111` / `dawn test assist` 這類；欄位管道已驗通，內容品質要看 production。）

**兩個實測發現的整形陷阱**：
1. **`remarkValue` 不保證是字串。** log type 19（修改工單）的 `remarkValue` 是物件，直接 `String()` 會得到 `[object Object]`。smart-slack-ai 只濾 `remarkType==='text'` 擋不住這個，要另外判型別。
2. **`remarkValue` 夾雜非敘事噪音**：member UUID（`318dbf3e-3e85-...`）、`order_mid`、email。沿用 smart-slack-ai 的規則（長度 ≥10 或含 `@`）仍會放行 UUID，需再加一條 UUID/order_mid 過濾。

**排序不要靠預設**：`ListTaskLogReq` 繼承 `BlueMountainPageReq`，宣告預設 `sortProperty=modifyDate` / `ASC`，但實測回傳為降冪。一律顯式帶 `{sortProperty:'createTime', sortDirection:'ASC'}`。

### `dictionary-code/list`

`data` 為 `{types: [{type, codes: [{id, code, name, path, userTypes, needInput, children}]}]}`，`codes` 是**樹狀**（task-type 最深三層）。

`types` 合法值（來源 `src/main/resources/dictionary-code.json`）：
`task-type` / `reserve` / `transfer` / `assist-reject` / `reject` / `finish`

`userType` 是 **int**（`TaskUserType` 的 `@JsonValue` 標在 Integer 上）：`1=CS, 2=OP, 3=BD, 4=AM`。**必填**，漏了回 `{"status":"0013","desc":"data.userType"}`。回傳依 userType 過濾，所以要涵蓋 CS+OP 的 task-type 需**呼叫兩次再合併**（`userType:2` 實測只回 7 個頂層節點）。

---

## 4. 代碼翻譯的缺口（tool 要自己補的部分）

API 回的是 code 字串（`task_type_code_102`、`task_status_code_7`、`task_log_type_code_4`），不是中文。dictionary 只涵蓋一部分：

| 代碼 | dictionary 有嗎 | 對策 |
|---|---|---|
| `taskTypeCode` | ✅ `task-type` | 呼叫 dictionary（CS+OP 各一次），可 cache |
| `reserveReasonCode` / `transferReasonCode` / `assistRejectMessageCode` / finish reason | ✅ `reserve`/`transfer`/`assist-reject`/`reject`/`finish` | 同上 |
| **`taskStatusCode`** | ❌ **沒有** | tool 自帶對照表 |
| **`taskLogTypeCode`** | ❌ **沒有** | tool 自帶對照表 |
| `remarkContent[].remarkTitle` / `remarkType==='i18nKey'` 的 `remarkValue`（`task_log_item_code_*`） | ❌ 不在 dictionary | ✅ **已解**：權威定義在 `common/constant/TaskLogRemarkTemplate.java`（105 entry / 54 個 code，每個都帶中文註解）。見 §4.1 |

`task_log_type` 的**權威對照在 `kkday-blueMountain` 的 `TaskLogType.java`（0–33 完整）**，比 smart-slack-ai 從流量反推的部分版更全；`task_status` 對照見 `~/Documents/kkday-wiki/wiki/databases/kkdb-bluemountain.md`。搬過去時直接用權威版。

---

## 4.1 `remarkContent` 的正確解法 — 靠型別，不要靠長度猜

這是**走 API 相對 smart-slack-ai 直連 PG 的最大品質提升**。

### `remarkType` 完整 enum（`common/constant/TaskLogRemarkType.java`）

| 值 | 意義 | 對摘要 |
|---|---|---|
| `text` | 純文本 | 可能是敘事，**也可能是 oid/UUID/order_mid**，要靠 `remarkTitle` 分辨 |
| `title` | 純文本 title | 標題 |
| `i18nKey` | i18n key，前端轉 | 動作語意（用 §4.1 對照表解） |
| `utcDateTime` | UTC 時間，要轉本地時區 | SLA / 預約時點 |
| `attachment` | 附件實體 | 摘要通常不用 |
| `productCategory` | 業務類型，打 ProductApi 換文字 | 分類 |
| `action` | 超連結/操作按鈕（enum 名 `LINK`） | 摘要不用 |
| `jsonArray` | JSON 陣列字串 | 需二次 parse |

> ⚠️ `remarkValue` **不保證是字串**（`action` 型是物件，`jsonArray` 型是字串化陣列）。直接 `String()` 會得到 `[object Object]`。

### `remarkTitle`（`task_log_item_code_*`）語意對照

權威來源：`common/constant/TaskLogRemarkTemplate.java`，105 個 entry / 54 個唯一 code，每個都帶中文註解。摘錄：

| code | 意義 | code | 意義 | code | 意義 |
|---|---|---|---|---|---|
| 1 | 查看對話內容 | 19 | 附件 | 37 | OutBound 內容 |
| 2 | 工單OID | 20 | 退回原因 | 38 | 誰來發送 |
| 3 | 是否有訂單 | 21 | 處理結果 | 39 | 後拋處理人 |
| 4/5 | 是／否 | 22 | 補充信息 | 41 | 發送管道 |
| 6 | 訂單MID | 23 | 採納結果 | 42 | IM |
| 7 | 工單分類 | 24 | 處理結果被退回 | 43 | 需要回覆 |
| 8 | 業務類型 | 25 | 轉移給 | 44 | 語系 |
| 9 | 最晚處理時間 | 26 | 轉移原因 | 45 | 發起來源 |
| 10 | MemberUUID | 27 | 預約回跳時間 | 47 | 按鍵 |
| 11 | ProdOID | 28 | 預約原因 | 48 | 轉移方式 |
| 12 | **備註** | 29 | 預約備註 | 50 | SupplierOID |
| 13 | 處理人 | 30 | 修改信息 | 51 | 工單類型 |
| 14 | 後拋工單OID | 31 | 處理結果被採納 | 52 | 工單子類型 |
| 15 | 後拋處理人選擇 | 32 | 後拋最晚處理時間 | 53 | 緊急程度 |
| 16 | 自動分配 | 33 | 轉移組別 | 54 | 指定處理人組 |
| 17 | 指定處理人 | 34 | 需要OutBound | | |
| 18 | **後拋內容** | 35/36 | 是／否 | | |

**敘事欄位 = `12 備註` / `18 後拋內容` / `21 處理結果` / `22 補充信息` / `20 退回原因` / `26 轉移原因` / `29 預約備註`**；其餘是識別碼與流程 metadata。

### 為什麼這比現行 bot 好 — 實測一條 log 的解碼

stage `#373875` 的 `task_log_type_code_1`（新建工單）帶 12 個 remark 項目：

```
工單OID=373875          是否有訂單=是        訂單MID=26KK…0033
工單分類=task_type_137   業務類型=CATEGORY_007 最晚處理時間=2026/09/10
MemberUUID=51192b1e-…   ProdOID=151083       SupplierOID=23115
備註="測試需要回收"  ← 唯一的敘事
語系=ja                 發起來源=SYSTEM
```

smart-slack-ai 的規則是「留 `remarkType==='text'` 且長度 ≥10 或含 `@`」——order_mid（13 字）和 MemberUUID（36 字）都會被放行當成敘事餵給 LLM。**改成按 `remarkTitle` 白名單挑欄位，噪音歸零。**

---

## 5. PII：走 API 天然最小化 — 已實測

`ticket_task.extra_info` (jsonb) 在 DB 裡含高風險個資（`TicketEventFacade.java:129-186` 的 `ORDER_EXTRA_INFO_KEYS`）：`contactEmail`、`contactTel`、`memberPhone`、`memberFirstname`，以及 **`custDataList`** 底下的**護照號、台灣身分證號 / 回鄉證 / 台胞證號、生日、身高體重、食物過敏（健康資料）**。

**API 回傳實測掃描結果：全部沒有出口。**

掃描已內建在 probe 裡（`reportPii()`，對 `list` / `logs` / `one` 三份回傳各掃一次），所以照 §頂端「重跑」指令跑就會重現這個結論。比對的 key 清單見 `scripts/probe-sit-bluemountain.ts` 的 `PII_KEYS`：`contactEmail`/`contactTel`/`contactFirstName`/`contactLastName`/`memberEmail`/`memberPhone`/`memberFirstname`/`memberLastname`/`custDataList`/`passport`/`twIdentityNumber`/`hkmoIdentityNumber`/`birthday`/`foodAllergy`/`extraInfo`。

三環境（SIT / stage / production）實跑皆 **零命中**。

> 掃描比對的是**物件 key**而非序列化字串——用 substring 會把良性的 `taskExtraInfo` 誤判成 `extraInfo`。

⚠️ 注意 `taskExtraInfo` **不是** DB `extra_info` 的 dump，實測內容為：
```json
{"contentGuide":"...", "childTaskInfo":{...}, "contentActionCodes":[], "operationActionCodes":[...]}
```
是 UI 用的後拋子單摘要 + 可用操作碼。

**殘留 PII 出口**（無法從結構上砍掉，因為它是敘事本體）：
- `mainOriginalMessage` / `childOriginalMessage` — CS/OP 提出的原始需求文字
- `resolveSummary` / `reserveMemo` / `assistRejectMessage`
- `TaskLogResp.remarkContent[].remarkValue`（`remarkType==='text'`）— 客服自由打字，實務上會夾電話/email

---

## 5.5 環境選擇：驗敘事只能打 production

跑法：`./scripts/env-for.sh stage npm run probe-sit-bm -- <orderMid> BCS`（憑證讀 `.env` 的 `STAGE_*`）。

| 環境 | `ticket_task` | `task_log` | 能驗什麼 |
|---|---|---|---|
| SIT be2-220 | 少量開發資料 | ✅ 有（開發者自己操作產生） | 契約形狀、整形邏輯（內容是 `dawn test assist` 這類測試字串） |
| **Stage** | ✅ **全量同步**（370,228 張） | ❌ **未同步** | 工單樹、主子單關係、狀態、處理人 |
| **Production** | ✅ | ✅ | ✅ **已實跑**（`./scripts/env-for.sh prod`），敘事完整，見 §5.6 |

> `./scripts/env-for.sh prod …` 讀 `.env` 的 `PROD_email` / `PROD_pwd` / `PRODUCTION_AUTHSVC_SERVICE_KEY`，
> host 為 `auth.kkday.com` / `api-gateway.kkday.com`。**唯讀，但仍有 §6 的 `task_user` auto-create 副作用。**

**Stage 的 `task_log` 只有 stage 自己產生的列。** 實測抽樣 25 張真工單：8 月從 production 同步進來的**全部 `logs=0`**，只有 2026/09/03 在 stage 現場建立的（`#373860`/`#373871`~`#373875`）有 log。這不是同步延遲——8/10 的舊單一樣是 0。

### ✅ 工單樹層已對 Slack bot 比對成功

用 Slack `#order-ticket-qa` 2026-09-03 那筆 `26KK…0778` 對 stage 實跑，**與 bot 摘要完全吻合**：

| bot 摘要說的 | API 回傳 |
|---|---|
| 主單 #361701，<CS-A> | `#361701` `parentTaskOid=null` `currentUuid=<CS-A>` ✅ |
| 後拋子單 #361714 給 <OP-B> | `#361714` `parentTaskOid=361701` `createUuid=<CS-A>` `currentUuid=<OP-B>` ✅ |
| 8/25 開始處理 | `createTime=2026/08/25 06:04 UTC` = 14:04 UTC+8 ✅ |
| 子單留下「工單重啟」紀錄 | `taskStatusCode=task_status_code_11`（處理中·重啟）✅ |
| 退款問題 | `task_type_code_103` = 退款問題 ✅ |

> 該訂單 `list` 回 8 張，其中 **6 張是 `task_type_code_0` + `createUser=SYSTEM` 的 IM 對話殼**——bot 正確地沒把它們當工單。**走 API 一樣要濾掉 `taskTypeCode === 'task_type_code_0'`**（wiki `kkdb-bluemountain.md` 記載：這批在 production 比真工單還多）。

---

## 5.6 Production 實跑：與 Slack bot 摘要逐項比對（`26KK…0778`）

`list` 回 9 筆 → 濾掉 6 筆 IM 殼 → 真工單 3 筆（主單 `#361701` + 子單 `#361714`、`#384754`），35 條 log。

| bot 摘要說的 | API 實際資料 | 判定 |
|---|---|---|
| 供應商已於 2026-07-08 19:05 主動取消，但未成立退款單，旅客詢問退款進度 | `#361701` 發起後拋 log 的 `後拋內容` **一字不差** | ✅ |
| <CS-A> 建主單 #361701，8/25 開始處理 | `08/25 06:06:45 [開始處理] <CS-A>` | ✅ |
| 發後拋 #361714 給 <OP-B> | `08/25 06:08:25 [發起後拋] 指定處理人=<OP-B>` | ✅ |
| 約 **10 分鐘**內自行回收 | 發起 `06:08:25` → 取消 `06:19:08` = **10 分 43 秒** | ✅ |
| 主單持續掛預約到 9/3 | 8 組 `預約(掛起)` / `預約回跳` 交替至 `09/03` | ✅ |
| 仍在追退款、無結案紀錄 | 主單 `狀態=協助中`、`finishTime=null` | ✅ |
| 子單 #361714 留下「**工單重啟**」紀錄 | 實際是 `[工單被取消(子單側)]`（log type 26）、`taskStatus=11 = 取消` | ❌ **bot 講反了** |

### 🔴 現行 bot 的 `task_status` 對照表是錯的

smart-slack-ai 的對照是從 production 流量反推的，與權威 `common/constant/TaskStatus.java` 有實質衝突：

| 值 | 權威（`TaskStatus.java`） | smart-slack-ai 反推 | |
|---|---|---|---|
| 6 | 已完成 | （無） | ⚠️ 缺 |
| 8 | 已銷毀（作廢） | 已取消 | ❌ |
| 9 | 退回 | （無） | ⚠️ 缺 |
| 10 | 採納 | 已回覆 | ❌ |
| **11** | **取消** | **處理中（重啟）** | 🔴 **語意相反** |

`1 創建 / 2 待處理 / 3 處理中 / 4 預約中 / 5 協助中 / 6 已完成 / 7 已關閉 / 8 已銷毀 / 9 退回 / 10 採納 / 11 取消`

→ 這是搬到 MCP 後**立刻可得的正確性修正**，不是重構。

> bot 漏掉 `#384754`（9/3 05:03 <CS-A> 又發新後拋給 <OP-B>）不是缺陷——它在 9/3 02:29 UTC 被詢問，該子單 13:03 CST 才建立。

### ⚠️ 走 API 的一個劣勢：task type 名稱是英文 i18n key

`dictionary-code/list` 回的 `name` 有 **107/212（50%）沒有中文**，是 snake_case i18n key：
`task_type_code_103 = refund_issue`、`102 = order_cancellation_processing`。
中文名（`退款問題`、`訂單取消處理`）在 **DB `task_type.task_type_name`，API 不暴露**。repo 的靜態 `dictionary-code.json` 也是英文 key，所以不是環境問題。

對摘要品質**無影響**（LLM 完全讀得懂 `refund_issue`，做英文摘要反而更順）；只有「要給人看中文分類名」時才需要另外補一份靜態對照。

> 附帶收穫：`dictionary-code.json` 每個 task-type 帶 `slaTimeRules`（依 `productCategory` × `MAIN/CHILD` 的 SLA 分鐘數），可用來算逾期，smart-slack-ai 沒用到。

---

## 6. ⚠️ 唯讀 tool 會產生寫入副作用

`UserFilter` 兩條路徑都會在使用者不存在時 auto-create：
- gateway-JWT / BCS 分支：`validateBcsUser()`（`UserFilter.java:177-194`）→ `taskUserFacade.newTaskUser(...)`
- direct-call 分支：`validateUser()`（`:162-175`）→ `userFacade.newUser(authKey)`

→ 第一次呼叫會在 BM 的 `task_user` 建一筆該員工的列。不是 bug，但 **spec 必須明記「這支宣稱唯讀的 tool 在 BM 留下寫入痕跡」**，否則 review 時會被抓。

---

## 7. 授權：BM 端零讀取授權，唯一 gate 在 gateway

BM 自己**完全沒有 row-level 讀取授權**（`facade/TicketEventFacade.java`）：
- `getTicketTaskPage()` `:257-262` — 帶 `orderMid` 時無任何 user/group/部門過濾
- `searchTicketTask()` `:308-397` — 無隱含 caller 範圍，唯一硬條件是 `eventOid IS NULL`（排除 workflow event）
- `getTaskLogPage()` `:415-440` — 只 by `taskOid`，零檢查

整個 repo grep `/verify` / `businessList` / `serviceAuth` → **0 命中**。BM 不查 businessList。

auth-service 側 target 已註冊（`EnumTarget.php:108` `BLUE_MOUNTAIN = 'bluemountain'`），判定邏輯在 `Pipelines/v2/CheckTargetRuleCache.php:55-116`：uri 沒註冊→fail-closed；註冊但 `business_keys` 空→任何登入者可過；有 `business_keys`→需交集。

**實測**：probe 帳號（businessList 691 筆）打四支端點全部 200，沒有 `ENTRY_*` 錯誤 → 至少不是 fail-closed。

### ✅ 已定案（2026-09-04，使用者確認）：**有設 `business_keys`**

`bluemountain` target 的 ticket-event uri **有設 `business_keys`**，落在 `CheckTargetRuleCache.php` 的第三種情況——需與使用者 businessList 交集。**在 be2 後台看不到工單的人，打這幾支 API 一樣沒權限。**

對 be2-mcp 的意義：
- 授權完整落在 gateway → auth-service `/verify`，**不需要在 MCP 層自建任何規則**，符合鐵則 #3。
- 不存在「全公司可讀客訴原文」的曝險，spec 不必為此加註記。
- 與現有 module 慣例一致：可在 tool 層照抄那組 action code 做 businessList fail-fast（早擋、錯誤訊息更好），但**那是體驗優化不是安全邊界**——真正的 gate 在 gateway。

> probe 帳號 businessList 裡的 77 個 `crm.ticket-column.*` / `crm.ticket-template.*` / `crm.ticket-info.query` 是**另一套 template ticket 子系統**（`ticket` / `ticket_log` 表）的碼，不是 `ticket_task` 的。實作時別誤用，正確的 action code 要另外抓（見 §8）。

---

## 8. 未竟項

| # | 項目 | 阻擋? |
|---|---|---|
| 1 | ~~判定 `business_keys` 有無~~ → 抓出 ticket-event uri 實際綁的 action code（供 tool 層 fail-fast 用） | ⬜ 不擋，gateway 已是真正的 gate |
| 2 | ~~`task_log_item_code_*` 的 i18n bundle 位置~~ | ✅ 已解，`TaskLogRemarkTemplate.java`（§4.1） |
| 6 | ~~對 production 跑一次敘事比對~~ | ✅ 已解，見 §5.6（`26KK…0778`，逐項比對通過，並抓出 bot 的 status 對照錯誤） |
| 3 | ~~對「有真實工單的訂單」跑一次 list~~ | ✅ 已解，`26KK…0835`／18 張工單／138 條 log 全鏈路驗過 |
| 5 | ~~production 的敘事內容品質~~ | ✅ 已解，§5.6 |
| 7 | **`PROJECT.yaml` 治理宣告待更新** — 見 §9 | 🟡 tool 實作 PR 必須一起改 |
| 4 | `kkday-blueMountain` 本機 HEAD 為 `12e8ace8`（2026-07-21），probe 前建議 `git pull` | ⬜ |


---

## 9. 治理宣告（`PROJECT.yaml`）待辦

**本 PR 沒有動 `PROJECT.yaml`**，因為它是**服務**的治理宣告，而這批變更只有手動 probe 腳本，`src/` 沒有任何執行期程式碼呼叫 blueMountain。

**但實作 tool 的那個 PR 必須一起改**，否則宣告會與現實脫節：

| 欄位 | 現況 | 應改為 | 理由 |
|---|---|---|---|
| `touches.internal_apis` | `kkday-auth-service`, `be2-product-service` | 加 **`kkday-blueMountain`**（經 api-gateway `/bluemountain`） | 新的下游內部服務 |
| `pii` | `false` | **`true`** | 工單的 `mainOriginalMessage` / `childOriginalMessage` / `remarkContent` 是客服自由文字，實務上會夾電話/email（§5「殘留 PII 出口」） |
| `risk_tier` | `red` | 不變 | 已是最高級 |
| `databases` | — | 不變 | **走 API，不新增 DB 連線**（這正是 §1 選這條路的理由之一） |

> `egress` 也不需要新增：blueMountain 走既有的 `GATEWAY_URL`，不是新 host。
