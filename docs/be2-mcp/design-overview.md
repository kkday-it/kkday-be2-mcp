# be2 MCP — 全面設計解析 (Design Overview)

這是一篇給架構師、開發者與管理層看的「一篇看懂」設計全貌文件。
它涵蓋了系統分層、決策演進以及目前的已知限制。對齊了 Phase 5 模組化的最新設計。

## 1. 分層架構解析

be2 MCP 系統由四個明確解耦的層級組成：

### 1.1 OAuth 外殼 (借鏡 dev-tools)
直接採用了 `kkday-development-tools` 已受 claude.ai 驗證的 OAuth 2.1 實作。負責處理 Discovery (`.well-known`)、DCR 動態註冊、PKCE 以及 `redirect_uri` 的防禦。這層只做協議對接，不知曉任何 be2 業務。

### 1.2 認證內核 (auth-service 與 Token 治理)
捨棄自建 RBAC，採用 `kkday-auth-service` 作為真理來源。
- **憑證不離境**：真實 be2 JWT (`access`/`refresh`) 只存在於 server store 內（SQLite）。發給 Claude 的是一組不透明的隨機參考字串。
- **兩層 refresh**：Claude 自己維護 OAuth 參考字串的續期；server 端則根據真實 JWT 過期時間（access ~50min），在 tool call 進來時 lazy 觸發 `PATCH /api/v1/refresh-token` 換取 12 小時長效 `refresh` 與最新的 `businessList`。

### 1.3 Core 治理層 (Change-set 機制)
- **Change-set 狀態機**：所有寫入都被攔截為草稿 (`pending_approval`)。
- **CAS (Compare-And-Swap)**：防重複執行，同一草稿只有第一筆批准生效。
- **Scope-binding**：agent 建立變更的商品 OID，必須在同一個 session 中被「唯讀工具 (L0)」讀取過，阻絕幻覺注入。
- **Append-only Audit**：每一步 tool call、批准與執行皆詳細紀錄至 `audit_log`，且保證不存明文 token。

### 1.4 Domain Modules 業務層
在 Phase 5，所有具體業務邏輯被抽離至 `src/modules/product/<action>`。透過統一的 `ActionModule` 介面，註冊了 5 個 action_type（`shelf_toggle_product`, `shelf_toggle_plan`, `inventory_setting`, `inventory_platform`, `shelf_schedule`）。
**為何模組化？**
- **消滅 5 大熱點**：過去新增 domain 需改動 `diffVersionHash`、`itemKeysOf`、`executeChangeSet` 等 5 處 core 邏輯。現在核心不依賴 duck-typing，完全委派至 module 方法（`module.computeDiff`, `module.execute` 等）。

### 1.5 體驗層 (批次精靈與確認頁)
提供兩種安全批准通道：
- **MCP Apps 面板 (批次精靈)**：跑在 Claude Desktop，透過 nonce 機制提供安全的視覺化 `inventory_platform` / `shelf_schedule` 批次勾選與核准。
- **確認頁 SSO**：跑在獨立瀏覽器，透過 be2-auth 登入取得 `be2mcp_sid` 進行批准。
- **文字降級**：對於 Claude Code 這類純文字終端，工具拒絕渲染面板，強制降級回確認頁。

## 2. 關鍵設計決策

| 決策 | 選項 | 理由 | 出處文件 |
|---|---|---|---|
| **Token 儲存機制** | **Option 1: Server Store (中選)**<br>Option 2: 加密封裝隨 token 交給 client（曾評估） | 讓真實憑證絕不離開 KKday 邊界，也免除加密解密與金鑰管理的複雜度。 | `be2-mcp-rd-design.md` §1.2 |
| **登入腿 (Login Leg)** | **POPUP (中選)**<br>REDIRECT | REDIRECT 的跨網域 allowlist 在 SIT 尚有不確定性；POPUP 已經實測跑通，作為初期落地首選。 | `oauth-runbook.md` |
| **批准落點分級** | 面板 nonce 通道 + SSO 確認頁 | agent 無法自行產生 nonce 也拿不到 SSO cookie。透過雙通道既保證 UX (面板)，也確保終端退路 (SSO)，並確保 agent 結構上無法自我批准。 | `mcp-apps-runbook.md`, `security-model-explainer.md` |
| **模組化邊界** | **每個 action_type 一包模組 (中選)**<br>巨大萬用 ChangeItem | 萬用的形狀無法適應後續不同 domain (如訂單/庫存) 完全相異的合約與防呆邏輯。獨立模組讓核心完全解耦。 | `2026-08-16-be2-mcp-modularization-design.md` |

## 3. 加一個新 domain 要做什麼？

現在的核心規則是：**嚴禁修改 core**。
只需依據 `module-onboarding.md`：
1. 確保拿到測試環境的寫入權限與 contract probe。
2. 在 `src/modules/<domain>/<action>/` 內實作 `validate`, `computeDiff`, `executor`, `renderer` 等。
3. 把新 module `registerModule` 進系統，並加入對應的 UI chunk。
4. 通過既有的 Module Conformance 自動測試。

## 4. 已知限制與未竟之處

1. **單機並發模型**：目前的 CAS、single-flight refresh、rate budget 與 inventory per-key mutex 皆是 **in-process (單機)** 實作。擴展到多實例 production 部署前，必須先轉換為 Redis / 分散式鎖。
2. **庫存逐日數量讀寫 PENDING**：`inventory_setting` 帶 `supplier_oid` 的逐日數量端點在 SIT 對測試帳號回 403（帳號未對映任何 supplier，屬 per-supplier 授權範圍、非架構問題），讀寫契約靠容錯解析頂著；詳見 `sit-write-contracts.md` §inventory。
3. **Production 部署與 Service Key**：目前的 service key 為 SIT 限定。上 Prod 前需正式申請並處理 be2-mcp 的 `login.be2.domain` allowlist。
