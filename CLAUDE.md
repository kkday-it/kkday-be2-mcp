# mcp_poc — be2 MCP 開發

本專案要做 **be2 MCP**：讓員工透過 agent（claude.ai / Desktop / Claude Code）以自然語言完成 be2 product 批次任務，全程符合企業標準（身份貫穿、draft-only 寫入、全鏈路稽核）。認證**必須經 kkday-auth-service**。

## 開發時必讀的參考文件（以下自動帶入 context）

@docs/be2-mcp/reference-dev-tools-architecture.md
@docs/be2-mcp/be2-mcp-auth-design.md
@docs/be2-mcp/phase0-inventory.md

- **主設計 spec**（canonical，較長、未 @import，需要時開來讀）：`docs/superpowers/specs/2026-08-07-be2-mcp-design.md`（已過 agy-peer-review）。

## 開發環境錨定：SIT `be2-220`

實作與測試一律先打 **SIT be2-220** 環境（已 live 實測過的那組）：
- be2-web：`https://be2-220.sit.kkday.com`
- auth-service：`auth-220.sit.kkday.com`（登入 `/auth/be2/login`、換碼 `/api/v1/login-authorization-code/{code}`、驗證 `/api/v1/verify`、refresh `/api/v1/refresh-token`）
- be2 gateway：`api-gateway-220.sit.kkday.com`（be2 商品 API 前綴 `/be2/api/v1`、下游 product-service `/product/api/v1`）

## 憑證：一律從 `.env` 讀，**永不 commit、永不印出**

`.env`（專案根、已 gitignore）現有：
- `SIT_AUTHSVC_SERVICE_KEY` — **B1 的 SIT service key（已取得）**，be2-mcp 打 auth-service S2S 用。
- `AUTH_email` / `AUTH_pwd` — SIT 測試帳號（跑登入 flow 用）。
- `GATEWAY_URL` / `AUTHSVC_URL` / `BE2_ENV`、及 `STAGE_*` 對應 stage 環境。

規範：程式從 `.env` 載入；任何輸出、log、文件、commit 都不得出現 key/password 明文。

## 兩份參考文件在講什麼

- `reference-dev-tools-architecture.md` — 逆向 `kkday-development-tools`（唯一已上線、已對 claude.ai 驗證的自訂 MCP）。**OAuth 2.1 外殼直接借鏡它**；但它沒串 auth-service，認證內核要換。
- `be2-mcp-auth-design.md` — 借鏡清單 + 把認證內核換成 auth-service 的設計 + 已確認的 auth-service 事實 + Phase 0 卡關項。

## 鐵則（開發任何 auth 相關程式前先確認）

1. 外殼照抄 dev-tools 的 OAuth 2.1（discovery + DCR + PKCE + redirect_uri allowlist），內核走 auth-service 帳密+2FA login。
2. 身分一律由 token 推導，input 永不接收使用者身分 / 越權 scope。
3. be2 授權以 auth-service 的 `businessList` + `/verify` 為準，**不自建 RBAC**。
4. change-set draft-only：agent 不直接送出寫入，一律人工在確認頁批准。

## 開發指令（Phase 1a，`npm run <script>`）

- `dev` — 啟動 MCP server（Streamable HTTP，`/mcp` + `/healthz`），監聽 `127.0.0.1:$BE2_MCP_PORT`（預設 8787）。
- `test` — 跑 vitest 單元/整合測試。
- `ci` — `typecheck` + `test`，本地重現 CI gate。
- `eval` — 跑 agent-eval 案例（需 `ANTHROPIC_API_KEY`；沒設會 SKIP，不算失敗）。
- `bootstrap-user` — pilot 使用者登入 auth-service 換 be2 token，存進 server 端 SQLite store，印出一次性的 static bearer 供 `claude mcp add` 用（見 `docs/be2-mcp/phase1a-runbook.md`）。
- `probe-sit` — 手動打 SIT `be2-220` 抓真實 endpoint 回應形狀，寫成 sanitized fixtures（絕不寫入 token）。
