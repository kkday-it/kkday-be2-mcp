# be2 MCP 設計 — 讓員工透過 agent 完成 be2 product 批次任務

日期：2026-08-07
狀態：草稿（待使用者審閱）
拆分策略：方案 A「縱切逐步升權」（每階段交付可用功能，風險層級 L0→L3 逐步開放）

參考來源：
- 《企業級內部MCP實作設計要點》（~/Downloads/企業級內部MCP實作設計要點.md）— 五大支柱：身份貫穿、風險分級、邊界防護、全鏈路稽核、集中治理
- CIO 文章（cio.com.tw/106747）— L1 讀取型 → L2 建議型 → L3 執行型逐級放權、負面表列、不可篡改稽核
- trellis-poc memory（be2 資料模型、MCP remote auth 研究、Batch Wizard 模式）
- Confluence KBACKEND 2220097560（API 資訊，需要時查閱）

## 1. 目標與範圍

**目標**：員工不再逐筆點 be2 product 頁面，改為對 agent（claude.ai / Claude Desktop）下自然語言指令完成批次任務，且全程符合企業標準（身份貫穿、draft-only 寫入、全鏈路稽核）。

**首發痛點**：批次編輯/更新，欄位範圍（皆為高風險寫入）：
1. 上下架/狀態切換（Phase 2 首發，endpoints 已驗證、語義最單純）
2. 日期/場次/可售設定（Phase 3）
3. 價格/庫存/方案設定（Phase 3，金流相關，最後開）

**非目標（負面表列）**：
- agent 不可直接送出任何寫入 — 一律 change-set + 人工批准
- 不開放刪除、退款、對外通知等不可逆操作
- 不給 agent 任何管理員權限
- 商品文案/翻譯編輯不在本專案範圍（另案）

## 2. 架構總覽

```
員工 ──SSO 登入──> Claude (claude.ai / Desktop / Claude Code)
                        │  MCP (Streamable HTTP + OAuth 2.1)
                        v
              be2-mcp server（OAuth resource server）
                  │  ├── L0 read tools ──────> be2 gateway /product/api/v1（user-scoped token）
                  │  ├── L2 changeset tools ─> change-set service（同 process，SQLite→Postgres）
                  │  └── OTel tracing + audit log（每個 tool call）
                  v
              確認頁（輕量 web UI）：員工審 diff → 批准 → server 執行 batch → before/after 稽核
```

- **MCP server**：TypeScript `@modelcontextprotocol/sdk`，Streamable HTTP transport。依 2026-07-28 spec 作為 OAuth resource server（`/.well-known/oauth-protected-resource`、401 `WWW-Authenticate`、RFC 8707 audience validation）；Authorization Server 外包給公司 IdP。
- **驗證路徑分兩步**：Phase 1 先用 Claude Code static per-user bearer（~0.5 天）驗證工具設計；同 Phase 內補 full OAuth + 公網 HTTPS 上 claude.ai/Desktop（~1.5–3 天）。
- **change-set service**：be2 後端無 draft 機制，自建一層。POC 用 SQLite，production 化換 Postgres。
- **確認頁**：獨立輕量 web 頁（列 diff、備註、批准鈕）。批准動作發生在 MCP 邊界之外，符合 draft-only pattern。沿用 trellis-poc 已驗證的 Batch Wizard Step2–4 設計（diff、動態計數、prod 字串解鎖、結果儀表板）。

## 3. 身份與授權

- **Identity continuity**：員工在 Claude client 完成 OAuth（公司 IdP）→ MCP server 拿 user-scoped token → 對 be2 gateway 用該使用者身份呼叫（token exchange / on-behalf-of，Phase 0 與 gateway team 確認機制；寫入帶 `modify_user`）。全程不得退化成 service account。
- **API-UI 權限等價性**：Phase 0 盤點目標 endpoints 的 API 層授權是否完整（用 kk-graph-v2 查影響面 + 實測低權限帳號打 API 應得 403）。不足處列入 gateway/後端補齊清單，未補齊的 endpoint 不上 MCP。
- **權限變更同步**：token TTL 短（≤1h）+ 每次 tool call 即時驗 token；離職/降權由 IdP revoke 生效。

## 4. 風險分級與工具清單

工具少而精、task-oriented（非 CRUD 鏡像）。description 寫明適用情境、參數語義、副作用；回傳做欄位裁剪與分頁（token budget）；錯誤訊息 actionable。

| 層級 | 工具 | 說明 | Phase |
|------|------|------|-------|
| L0 | `be2_find_products` | 依 oid 清單/關鍵字查商品名稱、狀態、上下架 | 1 |
| L0 | `be2_get_product_plans` | 商品方案清單 + 各方案上下架狀態（packages + package-configs 合併） | 1 |
| L0 | `be2_get_inventory_settings` | 庫存/場次設定查詢 | 1 |
| L2 | `be2_create_changeset` | `{layer, action_type, items, note}` → changeset_id + diff 預覽（rich context：名稱+現況+目標） | 2 |
| L2 | `be2_get_changeset_status` | 查 change-set 審批/執行結果（batch_id、before/after） | 2 |
| L3 | （不存在）送出/執行 | 只在確認頁，人批准後由 server 執行 | — |

Phase 3 不加新工具，擴充 `action_type`：`shelf_toggle` → `inventory_setting`、`schedule_setting`、`price_setting`（每個 action_type 各自過 spec review + eval 才開）。

## 5. Change-set 機制

- 資料模型：`change_sets(id, user, layer, action_type, items_json, note, status, created_at)` + `change_set_results(batch_id, before/after snapshots, per-item status, trace_id)`。
- 狀態機：`draft → pending_approval → approved → executing → done/partial/failed`（+ `rejected`、`expired`，24h 未批准自動過期）。
- 執行採 trellis-poc Batch Wizard 標準 contract：`Promise.allSettled` 隔離失敗、已在目標狀態自動略過、per-item 錯誤 + trace id、結果可下載。
- 批准人 = change-set 建立者本人（POC）；production 化可加第二人複核選項。

## 6. 邊界防護

- **Rate amplification**：MCP server middleware 做 per-user + per-session 呼叫預算（如每 session 100 次 read、10 個 change-set/日），超額回 actionable error。
- **Confused deputy**：MCP server 自身無高權 be2 帳號，一切用使用者 token — 低權使用者打高權 endpoint 得到 be2 原生 403。
- **Prompt injection**：工具回傳的商品名稱/描述標示為 untrusted data（回傳 envelope 註明 `data_origin: be2_content`）；change-set 建立參數必須來自使用者訊息語境，工具回傳內容不得直接觸發寫入工具（eval 涵蓋此情境）。

## 7. 可觀測性與稽核

- OTel distributed tracing：`mcp.session_id`、`mcp.tool`、`user_id` 作 correlation attributes，串 agent session → tool call → gateway call。
- 稽核日誌（append-only）：誰、哪個 client、哪個 session、呼叫什麼工具、參數、結果、trace_id。寫入類另存 before/after snapshot。
- 告警：短時間大量 change-set、連續 403（權限探測）、單 session 超預算。

## 8. 治理與生命週期

- 公司若已有 MCP registry/gateway 則註冊；若無，本專案的 spec review 流程（見 §10）+ 文件即為第一版治理雛形，並主動向平台/資安團隊報備，避免成為 shadow tool 先例。
- 工具 schema 版本化（tool description + schema 變更走 PR + eval 回歸）。
- 本 spec 分兩層維護：平台通用規範（§3、§6、§7）與 be2 product 實作規範（§4、§5），供後續其他系統接入複用。

## 9. 測試與評估

- 單元/整合測試：vitest，TDD（superpowers:test-driven-development）。
- **Agent-level eval 進 CI**：一組自然語言任務（含正例、需澄清例、應拒絕例），驗證 agent 選對工具、組對參數、正確處理錯誤。工具 description 任何變更都跑。
- 安全測試：injection 情境（工具回傳資料埋指令）、權限繞過情境（低權帳號嘗試高權 action）。
- 上線前用 `verify` skill 走真實 end-to-end（SIT）。

## 10. 開發工作流與使用的 skills

採用「雙 agent 交叉 review」工作流（aiposthub 文章模式），對應到現有 skills：

| 階段 | Skill | 用途 |
|------|-------|------|
| 設計 | `superpowers:brainstorming`（本文件）→ `agy-peer-review` | spec 由 Gemini (agy) 對抗式審到 APPROVED |
| 盤點 | `kk-graph-v2` | endpoint 影響面、API-UI 權限等價性盤點 |
| 盤點 | `qa-sniff-api-with-playwright` | swagger 與 UI 實際流量不符時攔真實 API |
| 規劃 | `superpowers:writing-plans` → `agy-peer-review` | 實作計畫，同樣交叉審 |
| 實作 | `superpowers:subagent-driven-development` + `superpowers:test-driven-development` | 依計畫分派 subagent、測試先行 |
| 驗證 | `verify`、`superpowers:verification-before-completion` | 真實流程 end-to-end |
| Review | `code-review`（Standards + Spec 雙軸）+ `agy-peer-review` | Claude 先審、Gemini 獨立上下文再審 |

## 11. 階段拆分

| Phase | 內容 | 交付物 | 估時 |
|-------|------|--------|------|
| **0 盤點** | endpoint/權限等價性盤點（kk-graph-v2 + 低權帳號實測）、與 gateway team 確認 token exchange、IdP OAuth app 申請、工具清單 spec review（agy 交叉審） | 盤點報告 + 定版工具清單 | 3–5 天 |
| **1 L0 唯讀** | MCP server + 3 個 read tools + OTel + 稽核 + rate budget；先 Claude Code bearer 驗證，再補 full OAuth 上 claude.ai/Desktop；agent eval 骨架進 CI | 員工可用 agent 查商品/方案/庫存狀態 | 1–2 週 |
| **2 L2 change-set（上下架）** | change-set service + 確認頁 + `be2_create_changeset`（僅 `shelf_toggle`）+ before/after 稽核 + injection eval | 員工可用 agent 批次上下架（人批准生效），SIT 驗證後上 prod | 2–3 週 |
| **3 L3 擴充+硬化** | `action_type` 擴充場次→庫存→價格（逐個過 review + eval）、告警、eval 全量進 CI、治理文件定版 | 三類批次任務全覆蓋 | 2–3 週 |

每個 Phase 結束條件：該階段 eval 全綠 + code-review/agy 交叉審通過 + SIT 實測（verify skill）通過。

## 12. 風險與待辦確認

1. **token exchange 機制**：gateway 是否支援 on-behalf-of / 可接受 IdP token 換 be2 JWT — Phase 0 最大不確定性，若不支援需 gateway team 排程支援，Phase 1 前必須解。
2. **API-UI 權限等價性**：若盤點發現 API 層授權缺口且後端短期無法補，該 endpoint 延後上 MCP（不以 MCP 層權限檢查代替）。
3. **claude.ai custom connector 公網需求**：MCP server 需公網 HTTPS，需資安核可的 ingress 方案（Phase 0 確認）。
4. **確認頁 vs be2 UI 深連結**：本設計採獨立確認頁；若 be2 team 願意原生支援 change-set 批准介面，Phase 3 後可遷移。
