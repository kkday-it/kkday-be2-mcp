# 稽核事件模型 + agent 可識別性（audit P0 + request-uuid 貫穿）design

> 狀態：待 agy-peer-review。
> 來源：對照 iThome〈AI 協作不是發帳號〉四條責任邊界後定出的缺口清單；使用者拍板「資料離境政策 skip、audit gap 與 agent 可識別性實作」（2026-09-03）。
> 前置盤點：`docs/be2-mcp/audit-logging-gap-analysis.md`（G1–G9 缺口與 Kibana 導出設計，本 spec 落地其中 P0 四項）。

## 1. 目標與範圍

**目標**：讓 be2-mcp 的稽核從「單機流水帳」升級為「可分類、可導出 SIEM、可與 be2 端紀錄互相關聯」的事件系統。

**本波範圍（P0 + #3）**：

| 項 | 缺口 | 一句話 |
|---|---|---|
| G6 | schema 無事件分類 | `audit_log` 加 `event_type` / `severity` 欄位 |
| G9 | 無導出管道 | stdout JSON lines 雙寫（ECS 對映），Filebeat 收進 Kibana |
| G2 | 撤銷事件無稽核 | `onReauthRequired` / revoke 路徑記 `security.*` 事件 |
| G3 | 401 嘗試無稽核 | `/mcp` bearer gate 拒絕記 `authn.unauthorized_attempt`（含防灌爆） |
| #3 | 下游分不出 agent | `GatewayClient` 帶 `request-uuid: <trace_id>`，be2 端 Kibana 可 join 回 MCP audit |

**明確不做（follow-up，非本波）**：
- G1（OAuth/SSO 生命週期事件）、G4（rate budget 獨立事件）、G5（authz.denial 統一分類）——P1；G7（L2 refresh 成功）、G8（oauth-purge 留痕）——P2。本波把 `event_type` 框架做好後，這五項只是往既有呼叫點補 `record()`，各自一個小 task 即可。
- G9 中程（OTel Logs / OTLP）：等 EKS collector 形態定案。
- 資料離境政策文件化：使用者已決定 skip。

## 2. 現況（錨點）

- `src/audit/auditLog.ts`：單一 `AuditLog` class，`record()` 直寫 PG `audit_log`（append-only trigger），欄位無分類；`params_json` 已做 JWT redact。
- `src/server/toolPipeline.ts:60`：`traceId = span.spanContext().traceId`——OTel 未啟用時為全零 traceId（非有效值），即 phase0 未竟項「trace_id 需 OTEL_MODE 才有值」。
- `src/server/app.ts:322` 附近：`/mcp` fast bearer gate（known-credential check），拒絕時回 401，目前不留痕。
- `src/auth/tokenManager.ts:113-117`：`onReauthRequired` callback + `REAUTH_REQUIRED` throw，目前不留痕。
- `src/gateway/client.ts:16`：`BE2_HEADERS` 常數（`accept` + `x-auth-id: be2`），get/put/post 三個方法共用——header 注入單點。
- `db/migrations/`：forward-only，下一號 `0003`。runtime 零 DDL（上雲硬約束 #6），schema 變更一律走 migration。
- **#3 可行性已實證**：`docs/be2-mcp/sit-write-contracts.md` ——gateway ACL header 白名單含 `request-uuid`；曾以自訂 `request-uuid` 重放 PUT，於 SIT Kibana `new-kklog-*` 撈到同一條 trace 完整鏈路（7 hits）。不需 be2-api 端任何改動。

## 3. 設計

### 3.1 事件模型（G6）

- Migration `0003_audit_event_type.sql`：`ALTER TABLE audit_log ADD COLUMN event_type TEXT, ADD COLUMN severity TEXT;`（nullable；不 backfill，舊列語義 = `tool_call` / `INFO`，由讀取端 fallback）。
- `AuditEntry` 加 optional 欄位：
  - `eventType?: string` —— 預設 `'tool_call'`。
  - `severity?: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'` —— 預設 `'INFO'`。
- 既有 6 個呼叫點（toolPipeline、appPipeline、confirmService approve、executor、confirmRoutes reject、app tools nonce 衛生）不改參數即維持預設——零行為變更。approve/reject 兩點順手標 `eventType: 'approval'` / `'rejection'`（一行 diff，屬分類補齊而非行為變更）。
- 事件名採 `audit-logging-gap-analysis.md` §2 的命名（`security.reauth_required`、`authn.unauthorized_attempt` 等），該表為唯一事件名來源，不另造清單。

### 3.2 stdout 雙寫（G9 近程）

- `AuditLog.record()` 末端：`APP_AUDIT_STDOUT=true` 時以 `console.log(JSON.stringify(...))` 輸出一行 JSON（stdout-only，符合上雲硬約束 #10「log 只走 stdout」）。
- 欄位對映（照 gap analysis §3.3 的 ECS 對齊表）：

| 內部 | JSON line 欄位 |
|---|---|
| `ts` | `@timestamp`（ISO8601） |
| `userLabel` | `user.name` |
| `eventType` | `event.type` |
| `severity` | `log.level` |
| `traceId` | `trace.id` |
| 固定 | `system.service_name: "be2-mcp"`、`env: $APP_ENV` |
| `sessionId` / `tool` / `clientInfo` / `status` / `errorMessage` / `durationMs` | `mcp.*` 命名空間 |
| `params_json` | `mcp.params`（沿用同一份 redact 後字串） |

- **順序與錯誤語義**：先 DB 寫入、後 stdout；stdout 例外吞掉（catch + 忽略），DB 例外照現行為往上拋。PG 仍是「本地真相」，stdout 是 best-effort 導出。
- 預設關（`APP_AUDIT_STDOUT` 未設 = off），部署層（EKS）預設開。

### 3.3 撤銷事件（G2）

- `tokenManager.ts` 的 `onReauthRequired` 觸發處記 `security.reauth_required`（severity `WARN`）；identity 憑證家族被撤（refresh-reuse family revoke、RFC 7009 revoke 既有路徑）記 `security.token_revoked`（severity `CRITICAL`）。
- 注入方式：`TokenManager` 建構參數已有 `onReauthRequired` callback——**不改 TokenManager**，在 `index.ts`/組裝層的 callback 實作內補 `audit.record()`；revoke 路徑在 `revokeRoutes.ts`（已注入 AuditLog）補記。
- 內容鐵則沿用 A2：不落 token 明文，只記 identityId 與 credential hash 前 8 碼。

### 3.4 401 嘗試（G3）

- `/mcp` fast bearer gate 拒絕（未知/無效 bearer）時記 `authn.unauthorized_attempt`（severity `WARN`）：來源 IP（`X-Forwarded-For` 首段，同 `/verify` 取法）、bearer hash 前 8 碼、`user_label = 'unknown'`。
- **防灌爆（本 spec 新增，gap analysis 未提）**：in-process per-IP throttle——同一 IP 60 秒窗內只落第一筆，窗內後續嘗試靜默丟棄（計數器累加）；該 IP 下一次落筆時，`errorMessage` 附上前一窗被抑制的次數（`suppressed=N`）。Map 上限 1024 IP，滿了整批清空（fail-open：寧可多記不可漏記首筆）。理由：`/mcp` 若暴露於掃描器，無 throttle 的 audit 寫入本身會成為 DoS 放大面。
- 位置：gate 回 401 的分支內，async fire-and-forget（audit 失敗不影響 401 回應）。

### 3.5 agent 可識別性（#3：request-uuid 貫穿）

兩步：

1. **trace_id 恆有值**：`toolPipeline.ts`（與 `appPipeline.ts` 同處理）取得 traceId 後，若為全零（OTel off 的 no-op span）→ 以 `crypto.randomUUID()`（去連字號、32 hex）替代。audit 與下游關聯不再依賴 `OTEL_MODE`——同時關閉 phase0 未竟項「trace_id 需 OTEL_MODE 才有值」。
2. **GatewayClient 注入**：get/put/post 簽章尾端加 optional `traceId?: string`，有值時 headers 帶 `request-uuid: <traceId>`。呼叫端（L0 tools、executor、live-diff）從 pipeline context 取 traceId 傳入。無值時不帶 header（向後相容，probe scripts 不用改）。

**關聯語義**：一次 tool call / change-set 執行內的多個 gateway 呼叫共用同一 `request-uuid`（= MCP audit 的 `trace_id`），Kibana join 為一對多——這是刻意的：查一筆 be2 端寫入即可回溯「同一動作」的完整 MCP 上下文。

**效果**：be2 端 Kibana（`new-kklog-*`）任一筆由 be2-mcp 發出的請求，都能以 `request-uuid` join 回 MCP audit 的完整脈絡（誰、哪個 session、哪個 tool、哪個 change-set）——回答「這筆寫入是 agent 代做的嗎？從哪個任務開始？」。`modify_user` 維持 = 使用者 platformId（be2 契約，不動）。

## 4. 錯誤處理總則

- audit 失敗（DB 或 stdout）一律不擋業務請求——現行為不變，G3 新增點亦同（fire-and-forget）。
- stdout 雙寫互不阻塞：stdout 失敗吞掉；DB 失敗照原路徑拋。
- throttle Map 滿 → 清空重來（fail-open：寧可多記不可漏記首筆）。

## 5. 測試

沿用 vitest + PGlite backend：

1. **G6**：migration 套用後舊列可讀（fallback `tool_call`/`INFO`）；新欄位寫入/讀回。
2. **G9**：`APP_AUDIT_STDOUT=true` 時攔 stdout 驗 JSON line 形狀（ECS 欄位齊、`@timestamp` ISO8601、params 無 token 明文）；stdout throw 不影響 DB 寫入；flag off 時零輸出。
3. **G2**：mock tokenManager 觸發 REAUTH → audit 有 `security.reauth_required`、無 token 明文。
4. **G3**：壞 bearer 打 `/mcp` → 401 且 audit 有 `authn.unauthorized_attempt`；同 IP 連打 N 次 60 秒內只一筆；audit 失敗仍回 401。
5. **#3**：pipeline 在 OTel off 下 traceId 非全零；GatewayClient 帶 traceId 時 header 有 `request-uuid` 且值相符、不帶時無此 header；executor 執行路徑 e2e（mock gateway）驗 header 貫穿。

驗收 gate：`npm run ci` 全綠；`npm run test:pg`（如環境有 `TEST_PG_URL`）migration 0003 套用成功。

## 6. 對既有文件的影響

- `docs/be2-mcp/audit-logging-gap-analysis.md`：P0 四項標記已落地（實作後）。
- `docs/be2-mcp/phase0-inventory.md`：「trace_id 需 OTEL_MODE 才有值」未竟項關閉（實作後）。
- 部署文件（`stage-eks-migration-devops.md`）：補 `APP_AUDIT_STDOUT` env 說明與 Filebeat/index 需求（`new-kklog-be2-mcp-*` 或依 Infra 常規）。
