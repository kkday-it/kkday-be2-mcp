# 企業級 MCP 稽核與 log 完整性盤點 + Kibana 導出設計

## 1. 現況盤點

目前 be2-mcp 的稽核日誌（`audit_log`）採用 SQLite 本地儲存，具備 append-only 保全機制（透過 DB trigger 拒絕 UPDATE/DELETE，見 `src/store/db.ts`）。每筆紀錄綁定 `trace_id`，且嚴格落實無明文 token 落地政策。

### 1.1 現有稽核呼叫點覆蓋面
經盤點，系統內目前恰有 6 處稽核呼叫點：
1. **L0/L2 Tool Pipeline** (`src/server/toolPipeline.ts`)：每次模型 tool call 皆會記錄使用者、session、tool 名稱、參數、狀態、時長及 trace_id。
2. **App Tool Pipeline** (`src/server/appPipeline.ts`)：每次面板 app tool call，結構與 L0/L2 pipeline 相同。
3. **Change-Set 核准決策** (`src/core/changeset/confirmService.ts`)：於 `approveAndExecute` 記錄批准決策事件，包含來源 IP、clientInfo 與操作 channel。
4. **Change-Set 執行** (`src/core/changeset/executor.ts`)：執行 change-set 時逐 item 紀錄結果，並於 `change_set_results` 留存 before/after 快照。
5. **Change-Set 拒絕決策** (`src/server/confirmRoutes.ts`)：於 POST `/confirm/:id/reject` 記錄使用者拒絕操作。
6. **面板 Nonce 通道相關**：App tools 執行涉及 nonce 的安全衛生處理時，過濾 nonce 欄位後記錄。

### 1.2 Schema 與欄位現況
- **Table Schema** (`src/store/db.ts`)：包含 `id`, `ts`, `user_label`, `session_id`, `client_info`, `tool`, `params_json`, `status`, `error_message`, `trace_id`, `duration_ms`。
- **OTel**：已接入 Trace (`OTEL_MODE=console|otlp`)，但 Logs 尚未接入。

---

## 2. 缺口分析 (Gap Analysis)

對照企業級資安與合規標準，識別出以下 9 項缺口（G1~G9）：

| 缺口 ID | 缺口描述 / 出處 | 為何企業標準需要 (風險) | 建議事件名 (Event Type) | 優先級 |
|---|---|---|---|---|
| **G1** | **authn 生命週期無稽核**<br>包含 DCR 註冊、`/oauth/authorize` complete (登入成功/失敗)、`/oauth/token` 換發與 L1 refresh (含 refresh-reuse family revoke)、`bootstrap-user` enroll、web session 登入/登出。 | 登入與憑證換發是存取的第一道門戶。漏記 L1 refresh-reuse 將無法於 SIEM 觸發 Token 遭竊的攻擊告警。 | `authn.login`<br>`authn.token_refresh`<br>`authn.revoke` | P1 |
| **G2** | **REAUTH_REQUIRED 與憑證家族撤銷無稽核**<br>於 `src/auth/tokenManager.ts` 的 `onReauthRequired` 發生時未留痕。 | 憑證遭撤銷、降權或到期被強制登出屬重大安全事件，SIEM 需依靠此事件追蹤帳號風險。 | `security.reauth_required`<br>`security.token_revoked` | P0 |
| **G3** | **`/mcp` 401 Gate 拒絕無稽核**<br>未知或無效的 bearer token 嘗試未被記錄。 | 無法偵測外部惡意掃描、暴力猜測 token 或已撤銷 token 的異常重試，為基礎的防護盲區。 | `authn.unauthorized_attempt` | P0 |
| **G4** | **Rate Budget 超額混在 error_message**<br>Pipeline (`src/server/appPipeline.ts`) 在 partial degrade 時 `status='ok'`，限流與錯誤僅記於 `error_message`。 | 狀態碼為 `ok` 但實質發生限流，導致 SIEM 無法依賴狀態碼寫告警規則，限流異常無法被有效監控。 | `tool.rate_limit_exceeded` | P1 |
| **G5** | **授權拒絕類無法統一篩選**<br>如 `SCOPE_NOT_READ`, `ACTION_NOT_ALLOWED`, `CONFIRMED_KEYS_MISMATCH`, `DIFF_STALE` 等，無統一 `event_type`。 | 資安分析需快速篩選出「越權嘗試」，若僅混雜於 `tool` error 中，分析成本極高。 | `authz.denial` | P1 |
| **G6** | **Schema 缺乏 `event_type` 與 `severity` 欄位**<br>現有稽核表缺乏事件分類，將各類事件硬塞入 `tool` 欄位。 | `event_type` 與 `severity` (INFO, WARN, ERROR, CRITICAL) 是 SIEM 分類與告警規則的地基。無此欄位無法做有效聚合分析。 | N/A (需 Schema 改動) | P0 |
| **G7** | **L2 refresh 輪替成功事件未留痕**<br>`src/auth/tokenManager.ts` 成功 refresh 未記錄。 | 無法追查內部憑證輪替軌跡，影響 authn 事件完整性。 | `authn.l2_refresh_success` | P2 |
| **G8** | **oauth-purge 執行結果未留痕**<br>清理過期憑證的治理作業未寫入 audit。 | 內部維運治理作業必須留存紀錄，以備查核資料庫清理合法性。 | `governance.oauth_purge` | P2 |
| **G9** | **導出能力不足**<br>日誌只存在本地 SQLite，無串接 SIEM 或送出管道；OTel Logs 亦未啟用。 | 單機 SQLite 損毀即遺失軌跡，無法納入公司級集中監控 (Kibana) 與即時告警體系。 | N/A (見第三章設計) | P0 |

---

## 3. Kibana 導出設計

針對 G9，為符合 KKday 現行 Kibana 集中日誌平台（慣例 index `new-kklog-*`，依 `system.service_name` 定位，見 `CLAUDE.md`）規範，設計雙階段導出方案。

### 3.1 兩階段導出取捨表
| 階段 | 方案 | 優勢 (維運 vs 語意) | 劣勢 |
|---|---|---|---|
| **近程 (POC)** | **Stdout 結構化 JSON Lines**<br>Audit sink 雙寫 (SQLite + Stdout)，藉由 Filebeat/Fluent-bit 採集。 | **維運簡單**：符合現有容器標準 output，部署層無縫接入公司 ES。核心層僅需擴充 `AuditSink`，不動業務碼。 | 依賴外部 agent 解析，Trace-log correlation 需在 ES index 階段對齊。 |
| **中程** | **OTel Logs (OTLP)**<br>透過現有 `OTEL_MODE=otlp` 管道與 Collector 傳送。 | **語意豐富**：原生支援 trace-log correlation (共用 `trace_id`)，結構化強。 | 需維護 OTLP 傳輸設定與 Collector 規則，若 Collector 不穩定可能掉 Log。 |

### 3.2 近程架構設計 (Stdout Sink 雙寫)
- **擴展抽象層**：目前核心層已有 audit 抽象，設計 `AuditSink` 的第二實作 `StdoutAuditSink`，保留現有 SQLite 作為「本地真相」與 append-only 保全，並行寫入 stdout。
- **環境變數控管**：藉由 flag `BE2_MCP_AUDIT_STDOUT` 啟用（預設 Production 開啟）。
- **輸出格式**：一行一個 JSON event (JSON lines)，包含所有 Schema 欄位與新增的分類屬性，便於 Filebeat/Fluent-bit 無痛吞吐。

### 3.3 欄位對映與 ECS 對齊建議
| SQLite `audit_log` 欄位 | ES (Kibana) 欄位對映 | 說明與轉換邏輯 |
|---|---|---|
| `ts` | `@timestamp` | 毫秒時間戳轉為 ISO8601，符合 ES 時序要求。 |
| `user_label` | `user.name` | 對齊 ECS (Elastic Common Schema) 使用者標準。 |
| (新增) | `system.service_name` | 固定填寫為 `be2-mcp`。 |
| (新增) | `env` | 標記所屬環境 (e.g. `sit`, `prod`)。 |
| (新增) | `event.type` | 填入定義之事件分類 (如 `authz.denial`, `tool_call`)。 |
| (新增) | `log.level` (severity) | 根據事件性質判定 (INFO, WARN, ERROR, CRITICAL)。 |
| `trace_id` | `trace.id` | 對齊 OTel 標準，便於 Kibana APM / Logs 雙向跳轉。 |
| `session_id`, `tool` 等 | `mcp.session_id`, `mcp.tool` | 歸入 custom 命名空間 `mcp.*` 中。 |

- **建議 Index 名稱**：`new-kklog-be2-mcp-*`（或交由 Infra 依平台常規配置）。
- **Retention 建議**：稽核類日誌依公司政策建議保留 **≥ 1 年**。

### 3.4 Kibana KQL 查詢範例

1. **查詢某使用者所有的批准決策事件**：
   ```kql
   system.service_name: "be2-mcp" AND event.type: "approval" AND user.name: "target.user@kkday.com"
   ```

2. **查詢全部的授權拒絕 (越權嘗試) 事件**：
   ```kql
   system.service_name: "be2-mcp" AND event.type: "authz.denial"
   ```

3. **查詢 REAUTH 撤銷等重大安全事件**：
   ```kql
   system.service_name: "be2-mcp" AND event.type: "security.*" AND log.level: ("WARN" OR "ERROR" OR "CRITICAL")
   ```

---

## 4. 實施路線圖 (Roadmap)

基於風險評估，排定以下修補與實作順序（純疊加治理層記錄機制，不改變任何現有業務邏輯）：

- **P0 階段 (基礎防護與可視化)**
  - 修復 **G2**：在 `tokenManager.ts` (憑證撤銷) 觸發點補上記錄。
  - 修復 **G3**：在 MCP 路由進入點前攔截未知的 Bearer 嘗試並記錄。
  - 修復 **G6**：擴充 `AuditEntry` Schema，寫入 `event_type` (如 `security`, `approval`) 與 `severity`。
  - 實作 **G9 (近程)**：完成 Stdout JSON Lines 雙寫 Sink，配合 `BE2_MCP_AUDIT_STDOUT`，打通 Kibana 通道。

- **P1 階段 (維運管控與細粒度鑑別)**
  - 修復 **G1**：補齊 OAuth flows 與 SSO 的生命週期稽核。
  - 修復 **G4**：將 Rate budget 降級告警明確分離出獨立的事件類型。
  - 修復 **G5**：統一歸納 `SCOPE_NOT_READ` 等拒絕情況為 `authz.denial` 事件。

- **P2 階段 (完整度收斂)**
  - 修復 **G7**：補上 L2 refresh 成功紀錄。
  - 修復 **G8**：補上 oauth-purge 的治理作業紀錄。
  - 實作 **G9 (中程)**：啟用 OTel Logs Pipeline，達成高階語意關聯。
