# be2 MCP — 給 RD 主管的架構與設計（SA / SD）

日期：2026-08-10　狀態：草稿
> 讀者：RD 主管 / 資深工程師。聚焦系統架構（SA）、關鍵設計決策（SD）、權限控管、效能控制，以及「擴展到全 be2 平台」的額外設計考量。搭配讀主 spec `docs/superpowers/specs/2026-08-07-be2-mcp-design.md` 與各 Phase spec。

---

## 0. 一頁概觀

be2 MCP 是一個 Model Context Protocol server（TypeScript，Streamable HTTP），夾在 Claude agent 與 be2 商品後台之間，扮演**治理層**：

- **對 Claude**：講標準 MCP + OAuth 2.1（外殼借鏡 KKday 唯一已上線且對 claude.ai 驗證過的 `kkday-development-tools`）。
- **對 be2**：認證/授權內核換成 **kkday-auth-service**（帳密+2FA 發 JWT、`businessList` 授權清單、`/verify` 統一驗證），**不自建 RBAC、不本地驗 JWT 簽章**。
- **寫入模型**：agent 只能建 change-set 草稿，人工在獨立確認頁（be2-auth SSO 登入）核准後才由 server 執行寫入；全鏈路 append-only 稽核 + OTel。

現況：Phase 0/1a/2a/2b + **Phase 3a（庫存）已實作**，`npm run ci` = **195 passed / 0 skipped**、`tsc` clean。

---

## 1. SA — 系統架構

### 1.1 元件與資料流

```
員工（Claude Code / Desktop）
  │  MCP over Streamable HTTP（帶 OAuth 不透明參考 token）
  ▼
┌─────────────────────────── be2-mcp server（TS, 127.0.0.1:8787） ───────────────────────────┐
│  OAuth 2.1 外殼：discovery / DCR / PKCE / redirect_uri allowlist（借鏡 dev-tools）            │
│  認證內核：auth-service 兩步 code flow（login → authorizationCode → 換 access/refresh/businessList）│
│                                                                                             │
│  ┌ L0 read tools ─────────┐   ┌ L2 change-set tools ────┐   ┌ 確認頁 web app（非 MCP tool） ┐ │
│  │ find_products          │   │ create_changeset        │   │ GET/POST /confirm/:id          │ │
│  │ get_product_plans      │   │  （建草稿, 算 diff,      │   │  /approve /reject              │ │
│  │ get_inventory_settings │   │    不寫入）             │   │  be2-auth SSO 登入（POPUP）     │ │
│  └───────────┬────────────┘   │ get_changeset_status    │   └───────────────┬───────────────┘ │
│              │                 └────────────┬────────────┘                   │ 人工核准         │
│              │ 帶員工 be2 JWT               │ 只碰本地 store                │                 │
│              ▼                              ▼                               ▼                 │
│      be2 gateway /product/api/v1     change-set / token / audit store    executor（read-merge  │
│      （gateway 代打 /verify）         （SQLite: 目前 PoC）                 -write, PUT 經 gateway）│
│                                                                                             │
│  橫切：OTel tracing + append-only audit_log（每次 tool call / 每次核准執行；trace_id 串接）     │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 token 存放（Option 1：server 端 store，已定案）
be2 的 access/refresh token 與 `businessList` 存 **be2-mcp 內網 server store**（目前 SQLite，key = OAuth subject）；發給 Claude 的 OAuth token 只是**不透明參考**。→ **be2 憑證全程不離開 KKday 邊界**，免加密封裝、免「憑證離境」資安核可。tool-call 面與確認頁 web 面共用同一套 store，模型一致（與 be2-web 自身的 server session 模型、dev-tools 的 Passport token store 都一致）。

### 1.3 部署形態（現況）
loopback 單機（`127.0.0.1`），內網即可——Claude Code/Desktop 皆本機 client，**不需公網**（只有 claude.ai 網頁才需要，不在首波範圍）。多實例/公網化的設計考量見 §5。

### 1.4 外部依賴
- **auth-service**：login / login-authorization-code / refresh-token / verify；需 service key（SIT 版已取得，prod 待申請）。
- **be2 gateway**：`/product/api/v1` 下游 product-service；read/write 皆經它，它代打 `/verify`。
- **be2-auth 前端**：確認頁 SSO 登入（POPUP + postMessage）。

---

## 2. SD — 關鍵設計決策

### 2.1 OAuth 外殼照抄、認證內核換掉
外殼（discovery `.well-known/*`、DCR 動態註冊、PKCE S256、`redirect_uri` allowlist、DCR response 刻意不回 `client_secret` 避開 Claude 的 zod schema 衝突）直接沿用 dev-tools 已驗證的結構。內核從「Google SSO + 自建 RBAC」換成「auth-service 帳密+2FA + businessList」。**外殼與內核解耦，是後續擴平台的關鍵**（見 §5）。

### 2.2 兩層 refresh + single-flight
- **L1（Claude ↔ be2-mcp）**：Claude 依 MCP OAuth spec 自動續不透明參考 token。
- **L2（be2-mcp ↔ auth-service）**：tool call 時偵測 store 內 be2 access 近到期，lazy 打 refresh（rotate 舊 refresh + 回**新鮮 businessList**），寫回 store。
- **single-flight**：refresh 端點 rotate，用過即失效；同一 user 多個並發 call 需 per-user 鎖確保只有一個真打出去、其餘讀新值。**目前是 in-process `Map`（`TokenManager`）——單實例正確，多實例需換共用鎖（見 §5）。**

### 2.3 change-set 狀態機 + 執行恰好一次
- `create_changeset` 只建 `pending_approval` 草稿 + 算 diff，**回傳刻意不含確認頁連結**（連結印在 server 終端機，不進 agent context——防 agent 用自身 Bash/curl 能力自我核准）。
- **stale-diff 重驗**：確認頁載入與按核准時都重抓 be2 live state 重算 diff；核准請求須帶回使用者所見的 `diff_version`，對不上就拒絕、標 `stale`、回新 diff。
- **CAS 執行恰好一次**：同一 change-set 第二次核准/拒絕得 `409`，防併發/重複點擊重複執行。
- **read-merge-write**：寫入前先讀完整現況 → 只改目標欄位 → PUT 回整包合併物件，避免抹掉未提及欄位（後端 merge/replace 語義不確定時的保守正解）。
- **no-op 略過**：已在目標狀態的 item 以**執行當下** live state 判定並跳過，非用建立當下快照。

### 2.4 確認頁 = 獨立 web session（Phase 2b 關閉 self-approval）
Phase 2a 用一次性 capability URL（`?token=`）當唯一憑證——任何知道 URL 者（含能存取 loopback 的 agent）都能核准，已知風險。Phase 2b 換成 **be2-auth SSO 登入的 web session cookie**（`be2mcp_sid`, HttpOnly），核准判斷改看「登入者 == change-set 建立者」。**agent 只有 MCP bearer、拿不到這個 session cookie——兩套完全獨立的憑證域，結構上 agent 無法核准自己建立的 change-set**（`tests/phase2bSecurity.test.ts` 有回歸測試；IDOR 由 creator-only 把關，他人一律 404 不洩漏存在性）。

### 2.5 稽核
append-only（SQLite `audit_log` 有 DB trigger 拒 UPDATE/DELETE）；寫入類另存 before/after 快照（`change_set_results`）；每列帶 trace_id 串接 agent session → tool call → gateway call；**任何時候不出現明文 token**（只存雜湊或不存，Phase 1a live 驗收實測 `eyJ`/`be2mcp_` 在稽核表 0 命中）；歸屬記「核准當下的 web session + 登入者」而非原始建立者 agent。

---

## 3. 權限控管

| 層 | 機制 | 說明 |
|---|---|---|
| **身份來源** | input 永不接收身份 | 使用者是誰、能做什麼一律由 token 推導；工具參數不收 email/userId（抄 dev-tools 慣例）。 |
| **驗證** | 一律委派 auth-service `/verify` | 驗簽 + 過期 + user_status + per-uri 授權一次做完；**be2-mcp 不本地驗 JWT 簽章**（key 在 auth-service 手上）。走 gateway 者 gateway 代打；本地 change-set service 自帶 service key 打。 |
| **action 級 fail-fast** | `businessList` | MCP 層先過濾「這 user 能不能用這 tool / 建這種 change-set」，fail 得早。**businessList 是 action 級、不含 per-oid 擁有權。** |
| **物件級授權** | 完全委派 gateway `/verify` fail-closed | per-object（這個商品是不是你的）**MCP 層不判斷**，交 be2 後端在執行當下回原生 403。低權帳號打高權端點得 fail-closed 403，Phase 1a/2a 已真實驗證。 |
| **防注入 scope-binding** | §6.2 read-oid gate | `create_changeset` 每個 oid 必須是**本 MCP session 內已被 L0 read 過**的 oid，否則整批拒（`SCOPE_NOT_READ`）——即使被注入誘導「把 oid 999 也下架」，agent 也無法對沒查過的商品建草稿。 |
| **核准關卡** | draft-only + SSO 確認頁 | 見 §2.3/§2.4，agent 結構上無法自我核准。 |
| **可撤銷** | 短 access（~50min）+ /verify/refresh 皆檢查 user_status | 離職/降權在下次驗證或 refresh 即 fail-closed，不必等重登。 |

**設計哲學：MCP 層只做「便宜、能提前擋」的 action 級過濾；一切真正的授權權威留在 auth-service/gateway，不自建平行 RBAC。**

---

## 4. 效能控制

- **rate budget**：per-session / per-user-day 呼叫預算（例：100 reads/session、10 change-set/日），超額回 actionable error，防 rate amplification。**目前 in-process，多實例需共用（見 §5）。**
- **批次上限 ≤ 20 items**：單一 change-set 硬上限，超過由 agent 自行拆多個；執行端**逐 prod_oid 序列化**呼叫，不對後端 burst。
- **庫存的保守批次**：跨月讀-改-寫分組、保守上限（62 天/20 items）、busy-guard 無條件輪詢（5×2s）——因庫存後端契約多項 OPEN，走容錯路徑。
- **refresh single-flight**：避免並發 refresh 撞 rotation（§2.2）。
- **read-merge-write 的讀放大**：每次寫入前多一次 read，是為正確性付的成本；批次時以「同 item×supplier 分組」攤銷。

---

## 5. 擴展到全 be2 平台的額外設計考量

> 這節是重點：目前是單機 PoC，往「全平台 + 規模化」走，有幾個**必須先解**的設計問題。

### 5.1 逐領域切片是可複製骨架，但每片有固定成本
擴展單位 = 一個 `action_type` 切片，固定四步（Phase 3a 已跑過一輪）：
1. **live 寫入契約 probe**（endpoint、必填欄位、merge-vs-replace、`modify_user`=JWT `platformId`、可逆性）。
2. **現況讀取**（擴充/新增 L0 read，讓 agent 算 diff / 做相對編輯，spec §4 硬性：嚴禁盲寫）。
3. **change-set action_type**（`ACTION_CODES` + item schema + diff 邏輯 + executor 分支；businessList 動作碼查真實清單）。
4. **eval + 安全測試**（draft-only、scope-gate、注入、該域 diff 正確性）。

治理層（OAuth 外殼、身份貫穿、核准、稽核）**不動**——這是複利。新模塊（訂單/庫存/折扣券/兌換券）主要成本落在步驟 1 與 4。

### 5.2 【最關鍵】並發正確性目前僅單機成立
目前所有正確性保證都建立在「單一 process」上，**多實例部署會直接打破**：

| 保證 | 現況實作 | 多實例的問題 | 需改為 |
|---|---|---|---|
| 執行恰好一次（CAS） | SQLite 單寫者 | 兩實例可同時通過 CAS | DB 樂觀鎖 / 分散式鎖 |
| L2 refresh single-flight | in-process `Map` | 並發 refresh 撞 rotation | Redis 分散式鎖 |
| 庫存 per-key mutex（跨 change-set 防 lost-update） | in-process mutex | 跨實例同 item×supplier lost-update | 分散式鎖 |
| rate budget | in-process | 每實例各算一份預算 | 共用計數（Redis） |
| web session / read-oid store | SQLite / in-process | 黏 session 或不共享 | 共用 store（Redis/Postgres） |

→ **「production 化」不是把 SQLite 換 Postgres 就好；上面這些鎖與計數要搬到共用基礎（Redis/DB）才敢多實例。** 這是規模化的核心工程，須計入時程與資安評估。

### 5.3 高風險域的治理需分級
庫存/價格寫入**立即影響前台可售並清 cache**，屬高風險。確認頁已對庫存加高風險紅字 banner；平台級擴展時建議：高風險 action 加**第二人複核**、更嚴格的批次上限、可能的排程視窗控制。

### 5.4 多平台的認證泛化
auth-service 是 be2 + 17 平台的中央認證，`userType↔platform` 有雙向 map。外殼/內核解耦（§2.1）意味著擴到其他平台時，主要是換 userType/platform 與 service key scope，OAuth 外殼可重用。但**每個平台的 `/verify` per-uri 授權與 businessList 動作碼要各自盤**。

### 5.5 契約不確定性是主要外部風險
庫存域 Q1–Q6（GET 形狀、merge-vs-replace、批次、quantity 欄位名、sync/async、SKU 維度）目前**全 OPEN**，靠容錯解析頂著。每個新模塊都可能有同類黑箱——**probe 一個有寫入權限的帳號/環境是每片的前置卡點**（與 Phase 2a/2b/3a 相同的 403 卡點）。

### 5.6 排程與主動能力（設計原則）
把「排程」切在**安全半段**：

| 排程放哪 | 誰做 | 安全性 |
|---|---|---|
| 定期讀現況、抓異常 | agent 自動 | ✅ 純讀 |
| 備好 draft change-set（如批次排程上架） | agent 自動 | ✅ draft-only，未寫入 |
| 通知使用者「待批 N 筆」 | 系統 | ✅ |
| 核准 → 寫入 | **人一次** | ✅ gate 不變 |

- **寫入的「生效時間」兩條路**：(a) 交 be2 原生排程（如 package-configs `reserve-active`：be2 顧計時器，MCP 於核准當下批次寫入排程記錄即可）；(b) MCP 端延後執行（MCP 自己顧計時器、時間到才 fire PUT）——**未來項**，需在 fire 當下重驗 live diff + 重新換 token + 定義執行身份 + 稽核。**優先走 (a)**。
- **核准本身不可排程**：核准必須是活人在 agent 不可達的憑證域產生（§2.4）；任何「自動/無人值守核准」都拆掉 draft-only。
- **批次排程上架**：change-set 帶 N 個 item + 各自排程時間 → 人核准一次 → executor fan-out 寫 N 筆 reserve（同上下架 executor pattern：≤20、序列、稽核）→ be2 顧時間。前置：probe `reserve-active` 契約（能否帶未來時間戳、欄位、merge/replace）。

### 5.7 核准介面可換殼，不變量不變
核准的「殼」可依摩擦需求選，但都須守「**人在 agent 不可達 + 帶 be2 身份**」：
- **常駐待批清單頁**（現有確認頁 standing 版 + 靜默 SSO）：最低新增成本。
- **手機 push 核准**（Duo/銀行 App 式，綁 be2/SSO 身份）：最低摩擦，需建 push 整合。
- **桌面 App 內嵌確認視窗**：需 native App。
- ❌ **在 agent 對話內打「批准」/ 任何 agent 可產生的訊號**：不成立（agent 的頻道、prompt injection 可偽造，MCP 無法驗出「人 vs agent」）。

### 5.8 風險分級：gate 用在刀口
不是每個寫入都進確認頁——**低風險 config**（排定期回報、加提醒）可放行；**高風險生產寫入**（上下架/庫存/價格，立即影響前台）才走人工核准。gate 氾濫反而讓人想繞過，分級才可持續。

### 5.9 MCP Apps（mcp-ui）友善介面 + 分級批准
標準＝**MCP Apps**（`modelcontextprotocol/ext-apps`），`mcp-ui` 是實作它的 SDK；Claude 已為支援 host。server 提供 `ui://` HTML resource（`_meta.ui.resourceUri`），host 在沙箱 iframe 渲染，UI 按鈕以 `postMessage` 回 host。用途：把**安全半段**（商品挑選器、視覺化 diff）做成互動面板，改善非工程師體驗；核准則**依風險分級決定落在哪條憑證域**。

| 等級 | 例 | 批准落在哪 | 補強 |
|---|---|---|---|
| **L1 低**（可逆） | 單品上/下架 | mcp-ui 面板「確認」→ 觸發寫入 tool（同域） | intent echo（回傳實際選取項）+ stale check + 稽核 |
| **L2 中**（批次可逆） | 批次下架 | mcp-ui 面板批准 + 補強 | 逐筆意圖驗證（非籠統 approve=true）+ per-render nonce* + stale check |
| **L3 高**（不可逆） | 價格、大批量 | **不走 tool**；面板視覺化 diff + `link` → be2-auth 確認頁 | 獨立憑證域簽核、留獨立證據 |

落地要點：**① tier 判定必須 server 端權威**（agent 不能自稱 L1）；**② L1 也帶 intent echo**（可逆≠期間傷害可逆）；**③** L2 的 intent echo 擋得住籠統注入、擋不了「知道自己 change-set 的 agent 自我批准」——真正能咬的是 *per-render nonce（須對 model context 隱藏）；**④** L3 唯一不行的是把最終簽核塞進 mcp-ui tool action（會與 agent 共用憑證域）；**⑤** stale check 三級通用。

**降級**：host 渲染不出（如 Claude Code 終端）→ 走文字，但 **tier 規則不跟著掉**（mcp-ui 是體驗層、非安全層）。**首要未知**：host 會不會把面板 HTML 餵進 model context（決定 nonce 可行性）——優先走 MCP Apps 模式（比 legacy 嵌入式更可能不進 context）。完整探索與 spike 見 `mcp-ui-exploration.md`、`mcp-ui-spike-checklist.md`。

---

## 6. 現況與未竟（誠實揭露）

| 項目 | 狀態 | 說明 |
|---|---|---|
| `npm run ci` | ✅ **195 passed / 0 skipped** | typecheck + test；`npm run eval` 因無 `ANTHROPIC_API_KEY` 為文件化 SKIP |
| L0 唯讀 live e2e | ✅ 已驗收 | SIT be2-220 真實 bearer 跑通、稽核無明文 token |
| 上下架寫入契約 | 🟡 已雙證、差最後一哩 | be2-web/Playwright 攔真實請求 + stage 同帳號同商品得 200；差「我方程式跑真 200」（卡 403 授權） |
| **庫存寫入契約** | ⚠️ **尚未雙證** | 比上下架更早卡：**連 GET 都尚未對真環境成功過一次**，讀寫契約仍是容錯猜測，勿套用上下架的「已驗證」語氣 |
| 並發正確性 | ⚠️ 僅單機 | §5.2；多實例前必須先解 |
| production 化 | ⬜ 未做 | SQLite → Postgres/Redis、正式部署、告警 |
| prod service key | ⬜ 待申請 | SIT 版已有 |
| be2-auth POPUP 訊息契約 | 🟡 待對真環境確認 | 目前 mock 測過骨架，POPUP 主路徑 Phase 0 已 SIT 實證 |

---

## 7. 名詞小抄

| 名詞 | 一句話 |
|---|---|
| MCP | Model Context Protocol，讓 LLM agent 用標準協定呼叫外部工具 |
| change-set | 待核准的變更草稿，記錄目標變更但尚未寫入 be2 |
| draft-only | 鐵則：agent 不能直接送出/核准寫入，一律先建 change-set 再人工核准 |
| businessList | auth-service 換碼/refresh 回的 action 級授權清單，MCP 做 fail-fast（不含 per-oid 擁有權） |
| `/verify` | auth-service 統一驗證端點：驗簽 + 過期 + user_status + per-uri 授權，MCP 不本地驗 JWT |
| gateway | be2 API gateway，read/write 皆經；代打 `/verify`，是真正授權判斷點 |
| read-merge-write | 寫前先讀完整現況、只改目標欄位、再 PUT 回合併物件，避免覆蓋未提及欄位 |
| CAS | Compare-And-Swap，確保同一 change-set 只成功執行一次 |
| scope-binding | change-set 的 oid 必須是本 session 內 L0 read 過的，防注入憑空建變更 |
| single-flight | 同一 user 並發 refresh 只實際打一次，其餘讀新值，避免撞 rotation |
