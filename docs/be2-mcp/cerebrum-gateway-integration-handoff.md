# cerebrum-service 接入 be2-mcp（gateway 雛形）— handoff

> 2026-08-26 討論產出，供下一個 session 接手規劃/實作。本檔是決策彙整，非正式 spec——真要動工前仍要走 `superpowers:brainstorming` → spec → `agy-peer-review`。

---

## 給 RD 主管:討論議題與待拍板（2026-08-28 整理，供跨團隊會議）

**一句話**:cerebrum-service（AI 對帳小幫手，Python/LangGraph，已內嵌 be2-web 後台）自己長了一套跟 be2-mcp 幾乎重複的 MCP + OAuth 殼。提案讓 **be2-mcp 當 MCP gateway 聚合 cerebrum 的工具**，讓 Claude（Code/Desktop）從單一入口用到兩邊能力，省掉 N×M 重複串接。選 be2-mcp 當 gateway 是因為三套殼裡它 OAuth 2.1 最成熟（SIT live 驗過 POPUP / DCR / redirect allowlist）。

### A. 要主管 / 跨團隊拍板的（工程無法單方決定）

1. **Ownership / on-call（最大阻擋）**:gateway 是平台級元件。長期誰擁有、誰 on-call?**沒答案前，這只能是 be2-mcp 單隊 prototype、範疇必須收斂。這題不解，不建議正式化。**
2. **治理邊界（安全關鍵）**:be2-mcp 的核心價值 = **寫入必須人工批准**（面板 nonce / SSO 確認頁）+ **不自建 RBAC**（一律問 auth-service）。cerebrum 相反——service token + 自建 `AuthGuard` + `preview_token` 讓 **agent 自己 apply、無人工批准**。**若 gateway 代理 cerebrum 的「寫入 / apply」工具，等於 be2-mcp 背書了「繞過自己批准閘」的寫入**，稀釋整個安全與稽核敘事。→ **工程建議：v1 只代理「讀取 / preview」，不碰寫入**；cerebrum 寫入的治理歸屬另議。要不要這樣收斂，請主管與 cerebrum team 對齊。
3. **cerebrum team 的外部依賴**:(a) 身份斷言驗證 key 的同步（誰先手）;(b) cerebrum 何時把 pricing 以外（訂單對帳 / 商品建立 / coupon）包成「單一入口工具」——這些活在它的 LangGraph 內，be2-mcp 推不動、只能等。

### B. 工程可自決 / 自驗的（不佔會議時間，讓主管知道即可）

- 身份斷言用 **RS256**（be2-mcp 持私鑰、cerebrum 設 public key，免對稱 secret 同步）;工具**動態聚合** + `cerebrum_` prefix（不為個別工具寫死）;代理呼叫**算進 rate budget**（獨立計數）;多輪追問（elicitation）先做**技術 spike** 驗 Claude Code/Desktop 支援度。
- **鐵則:絕不轉發原始 refreshToken**——auth-service refresh 會 rotate，be2-mcp 與 cerebrum 各自拿同顆去 refresh 會互相打壞對方 store;改簽**短命身份斷言**。
- gateway 屬治理/傳輸層，放 `src/core/gateway/`，不混進 `src/modules/`。

### C. 建議的推進 gate（三者到位再動工）

1. **Ownership 有答案**（A1，主管/組織層）
2. **v1 範疇收斂在唯讀 / preview**（A2，與 cerebrum team 對齊）
3. **elicitation 支援度 spike 通過**（B，工程可立刻先做，解掉最大技術未知）

→ 三者到位後才走主管線:`grill-me` → `brainstorming`（產 design doc）→ `agy-peer-review` → `writing-plans` → 實作。

> 下方 §背景以後為 2026-08-26 的技術決策彙整原文（工程細節），供實作階段參考。

## 背景

- **kkday-ai-cerebrum-service**（`kkday-it/kkday-ai-cerebrum-service`，`develop` branch）：Python/FastAPI + LangGraph 的 AI agent 服務，品牌名「AI 對帳小幫手 / AI Cerebrum」，已內嵌在 be2-web 後台側邊選單（對話式 UI，右側有步驟精靈 Progress 面板）。涵蓋訂單對帳、商品建立、定價調整、折扣券/兌換券。
- 它**已經自己長了一套跟 be2-mcp 幾乎重複的殼**：自己 mount `/mcp`（streamable-http）+ 自己的 `/oauth/*`（discovery/DCR/authorize/token），也串 kkday-auth-service（refresh-token 解身份）。
- **但寫入安全模型跟 be2-mcp 不同**：cerebrum 對下游 BE2 API 用 service token 認證，per-user 權限走自建的 `AuthGuard.check_entry_permission(...)`，不是 be2-mcp 的「一律問 auth-service businessList/verify、不自建 RBAC」。寫入靠 `preview_token`（TTL 5 分鐘）由 agent 自己呼叫 apply，**沒有 be2-mcp 那種人工批准通道**（nonce 面板/SSO 確認頁）。
- **這個治理落差是 cerebrum team 自己的責任範圍，be2-mcp 不介入、不代管。**

## 決策：不重寫語言，不另開 stream API，改蓋 mcp-gateway

- 語言不動：MCP 是協定不是語言依賴，TS/Python 都能被 gateway 聚合，重寫換不到對應效益
- 不用額外開 streaming REST API：cerebrum 現有 `/mcp` 已走 Streamable HTTP（協定本身相容 SSE），preview/apply 這類流程直接以 MCP tool 呈現即可
- **be2-mcp 先當 gateway 雛形**（理由：三套殼裡它的 OAuth 2.1 實作最成熟，SIT live 驗證過 POPUP flow、redirect allowlist、DCR 不回 client_secret）
- Gateway 定位：**PEP（policy enforcement point）不是 PDP**。集中呼叫 auth-service 驗身份沒問題，但不能自己存一套權限規則——那是 be2-mcp 一開始就刻意避開的自建 RBAC

## 對話式 agent 怎麼接：LangGraph 的判斷邏輯不用搬進 Claude

- **已包成宣告式單次呼叫的工具**（如 cerebrum 的 pricing preview/apply）：接進 gateway 後，「該不該用、怎麼串」的判斷者是 **Claude 自己**（MCP host 端 LLM），跟 LangGraph 的 `agent_node` 在 cerebrum 對話框裡做的事是同一份工作，只是換了 orchestrator
- **還沒拆成宣告式工具、活在 LangGraph 對話式 sub-agent 裡的功能**（訂單對帳、商品建立、coupon 等）：**不要拆碎成細顆粒 MCP 工具**（Claude 沒有 cerebrum 內部業務規則的判斷力）。改用「整個 agent 包成一個工具」——例如 `cerebrum_run_reconciliation(instruction: string)`，呼叫進去後 cerebrum 自己的 `agent_node` 照舊做全部細顆粒判斷/串工具，Claude 只做粗判斷（這任務該不該委派給 cerebrum）
- 多輪追問（缺欄位）：優先用 MCP **elicitation**（`elicitation/create`，在同一次 `tools/call` 執行途中跟使用者要資訊，client 支援才能用），沒支援時退回「工具回傳 `needs_info` 結構化結果 → Claude 問使用者 → 帶著補充資訊重新呼叫」

## be2-mcp 具體要改動的地方

### 新增：內部 MCP client（建議放 `src/core/gateway/`）
- 用 `@modelcontextprotocol/sdk` client 模式連 cerebrum 的 `/mcp`（Streamable HTTP）
- 連線設定走 env var（cerebrum MCP URL），沿用「憑證只從 `.env` 讀、不印出」鐵則

### 新增：身份斷言簽發（`src/core/gateway/identityAssertion.ts`）
- 從 be2-mcp 既有 server-side token store 撈已解析身份（`platformOid`/`authKey`）
- 簽一張短命 JWT（先 HS256 shared secret，之後可換 RS256）帶給 cerebrum 驗
- **不要轉發原始 refreshToken**——auth-service 的 refresh 會 rotate，be2-mcp 和 cerebrum 若各自拿同一顆 refreshToken 去 refresh 會互相打壞對方的 store
- 對應 cerebrum 要設定 `MCP_JWT_PUBLIC_KEY`（cerebrum 既有的 JWT-direct 驗證路徑，免改他們的 code，只需設定）——**這是對方要做的事，但簽章 key 要跟他們同步**

### 改動：`tools/list` handler
- 除本地 module registry 工具外，額外打一次 cerebrum 的 `tools/list`
- 結果用 `cerebrum_` prefix 併入回傳清單（避免撞 be2-mcp 自己的 `be2_*`）
- 動態發現、通用轉發——**不要為 cerebrum 個別工具寫死 client 邏輯**，否則對方每加一個新工具 be2-mcp 就要跟著改 code
- 需要 cache/refresh 策略

### 改動：`tools/call` handler
- 辨識 `cerebrum_` prefix → 剝除 → 轉發到 cerebrum 的 `tools/call`，帶上剛簽的 JWT
- 回傳原樣中繼回 Claude

### 新增：Elicitation 雙向 relay（風險較高、較新的一塊）
- be2-mcp 同時是「對 Claude 的 MCP server」+「對 cerebrum 的 MCP client」
- cerebrum 執行代理呼叫途中送 `elicitation/create` → be2-mcp 原樣轉給 Claude → 拿到答案再轉回 cerebrum
- be2-mcp 自己的 MCP server 也要宣告支援 elicitation capability
- **待驗證**：Claude Code/Desktop 對 elicitation 的實際支援狀態

### 沿用既有機制（小改，非新建）
- **稽核**：代理呼叫比照本地工具寫進既有 `audit_log`，加「proxied to cerebrum」標記
- **Rate/budget**：代理呼叫要不要算進現有 per-user daily budget（待決策）

### 邊界提醒
以上全部屬於「治理/傳輸層」，照 CLAUDE.md 的 core vs modules 邊界，應放 `src/core/`，**不要**混進 `src/modules/`（那是 domain action_type 的地盤）。

## 待決策清單（帶進下一個 session）

1. HS256 secret 怎麼生成、怎麼跟 cerebrum 同步（誰先手）
2. `cerebrum_` prefix 命名規則要不要更細（例：`cerebrum_pricing_*` 分 domain）
3. 代理呼叫算不算進現有 rate budget
4. Elicitation relay 實作細節 + 先驗證 Claude Code/Desktop 支援度
5. cerebrum 何時會把 pricing 以外功能包成「單一入口工具」——外部依賴，非 be2-mcp 能單方推進
6. Gateway 蓋下去牽涉平台級 ownership 問題（誰長期 on-call），還沒有答案前，這仍是 be2-mcp 單隊在做的 prototype，範疇要收斂
