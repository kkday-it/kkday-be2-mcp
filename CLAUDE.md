# mcp_poc — be2 MCP 開發

本專案要做 **be2 MCP**：讓員工透過 agent（claude.ai / Desktop / Claude Code）以自然語言完成 be2 product 批次任務，全程符合企業標準（身份貫穿、draft-only 寫入、全鏈路稽核）。認證**必須經 kkday-auth-service**。

## 開發時必讀的參考文件（以下自動帶入 context）

@docs/be2-mcp/reference-dev-tools-architecture.md
@docs/be2-mcp/be2-mcp-auth-design.md
@docs/be2-mcp/phase0-inventory.md

- **主設計 spec**（canonical，較長、未 @import，需要時開來讀）：`docs/superpowers/specs/2026-08-07-be2-mcp-design.md`（已過 agy-peer-review）。
- **上雲硬約束**（未 @import、開發前必讀）：`docs/be2-mcp/vibe-cloud-ready-spec.md`（來源 kkday-vibe-framework）。本專案最終容器化部署於公司內部 **AWS EKS**——任何設計須符合其 12 條約束（禁 SQLite/檔案型 DB、DB=外部 PostgreSQL、完全無狀態可多副本、排程走 HTTP endpoint 非 in-process timer、runtime 不做 DDL、綁 0.0.0.0、log 只走 stdout、平台能力包 adapter）。現況差距與遷移方向見 `docs/be2-mcp/stage-eks-migration-devops.md` §8。

## 開發環境錨定：SIT `be2-220`

實作與測試一律先打 **SIT be2-220** 環境（已 live 實測過的那組）：
- be2-web：`https://be2-220.sit.kkday.com`
- auth-service：`auth-220.sit.kkday.com`（登入 `/auth/be2/login`、換碼 `/api/v1/login-authorization-code/{code}`、驗證 `/api/v1/verify`、refresh `/api/v1/refresh-token`）
- be2 gateway：`api-gateway-220.sit.kkday.com`（be2 商品 API 前綴 `/be2/api/v1`、下游 product-service `/product/api/v1`）

## 憑證：一律從 `.env` 讀，**永不 commit、永不印出**

`.env`（專案根、已 gitignore）現有：
- `API_AUTH_SERVICE_KEY` — **B1 的 SIT service key（已取得）**，be2-mcp 打 auth-service S2S 用。
- `AUTH_email` / `AUTH_pwd` — SIT 測試帳號（跑登入 flow 用）。
- `GATEWAY_URL` / `AUTHSVC_URL` / `APP_ENV`（一環境一份；打 stage 就把兩個 URL 改指 stage 並換該環境的 `API_AUTH_SERVICE_KEY`）。

規範：程式從 `.env` 載入；任何輸出、log、文件、commit 都不得出現 key/password 明文。

## 兩份參考文件在講什麼

- `reference-dev-tools-architecture.md` — 逆向 `kkday-development-tools`（唯一已上線、已對 claude.ai 驗證的自訂 MCP）。**OAuth 2.1 外殼直接借鏡它**；但它沒串 auth-service，認證內核要換。
- `be2-mcp-auth-design.md` — 借鏡清單 + 把認證內核換成 auth-service 的設計 + 已確認的 auth-service 事實 + Phase 0 卡關項。

## 鐵則（開發任何 auth 相關程式前先確認）

1. 外殼照抄 dev-tools 的 OAuth 2.1（discovery + DCR + PKCE + redirect_uri allowlist），內核走 auth-service 帳密+2FA login。
2. 身分一律由 token 推導，input 永不接收使用者身分 / 越權 scope。
3. be2 授權以 auth-service 的 `businessList` + `/verify` 為準，**不自建 RBAC**。
4. change-set draft-only：agent 不直接送出寫入，一律人工批准，經**面板 nonce 通道（Apps host）或 be2-auth SSO 確認頁（退路）**。不變式：agent 結構上拿不到批准所需憑證（nonce 或 `be2mcp_sid` cookie）——面板批准工具（`app_confirm_changeset`）是 app-only，model 的工具清單裡沒有它（spike T6 已證 host 會把它從 model 工具陣列濾除）；nonce 只在該工具的回傳裡發放，且只在 app-only 的 `app_get_changeset_view` 才附帶；確認頁則需先用 be2-auth SSO 登入（瀏覽器 POPUP → `be2mcp_sid` session cookie），Phase 2a 那種一次性 capability URL（`?token=`）已移除。細節見 `docs/be2-mcp/phase2b-runbook.md`（確認頁 SSO）與 `docs/be2-mcp/mcp-apps-runbook.md`（面板 nonce 通道）。

## 開發指令（Phase 1a，`npm run <script>`）

- `dev` — 啟動 MCP server（Streamable HTTP，`/mcp` + `/healthz`），監聽 `$APP_BIND_HOST:$APP_PORT`（本地預設 `127.0.0.1:8787`）。
- `test` — 跑 vitest 單元/整合測試。
- `ci` — `typecheck` + `test`，本地重現 CI gate。
- `eval` — 跑 agent-eval 案例（需 `ANTHROPIC_API_KEY`；沒設會 SKIP，不算失敗）。
- **OAuth 接入（首選）** — Claude Code / Desktop 直接 `claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp`（不帶 `--header`），瀏覽器跳轉 be2-auth POPUP 登入，免手貼 bearer。步驟、與 static bearer 的關係、SSO-seamless 確認頁行為，見 `docs/be2-mcp/oauth-runbook.md`。
- `bootstrap-user` — **headless/過渡 fallback**（無瀏覽器環境、CI、或 OAuth 外殼故障時的應急通道）：pilot 使用者登入 auth-service 換 be2 token，存進 server 端 SQLite store，印出一次性的 static bearer 供 `claude mcp add --header` 用（見 `docs/be2-mcp/phase1a-runbook.md`）。
- `oauth-purge` — 硬刪過期 `oauth_auth_codes`/`oauth_refresh` + 無 credential 引用的 ghost `be2_identities`（見 `docs/be2-mcp/oauth-runbook.md`「Token 生命週期治理」）。建議排程每日跑一次。
- `probe-sit` — 手動打 SIT `be2-220` 抓真實 endpoint 回應形狀，寫成 sanitized fixtures（絕不寫入 token）。
- `probe-sit-write` — 手動、可逆地打 SIT `be2-220` 的 write endpoint（`scripts/probe-sit-write.ts`），解 `modify_user` 來源、merge-vs-replace、必填欄位；結果見 `docs/be2-mcp/sit-write-contracts.md`。**永不進 CI**，且需可寫帳號才能跑到底（目前 `.env` 帳號在寫入端點回 403，見該文件 blocker）。
- `probe-sit-bm` — 手動打 blueMountain 工單讀取 API（經 gateway `/bluemountain`，`scripts/probe-sit-bluemountain.ts`），驗 endpoint 形狀／授權／PII；`discover` 模式可在該環境撈任一工單。搭配 `./scripts/env-for.sh <stage|prod> <cmd…>` 可切環境（憑證一律讀 `.env`、不印值）。結果見 `docs/be2-mcp/sit-bluemountain-contract.md`。**永不進 CI。**

## Module 結構與擴展指引

- **Core vs Modules 邊界**：治理層（Authn/Authz、ChangeSet 狀態機、分級批准、稽核）統一定義於 `src/core/`，且不依賴特定業務邏輯。業務邏輯（讀寫狀態、Diff、驗證）由 `src/modules/` 實作。
- **新增 Action Type**：若需接入新 domain 或 action，**嚴禁修改 core**。請參考 `docs/be2-mcp/module-onboarding.md`，實作一包新的 module 註冊即可。
