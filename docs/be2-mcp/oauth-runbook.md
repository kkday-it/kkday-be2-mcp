# be2 MCP — OAuth 接入 Runbook

> 對象：用 Claude Code / Claude Desktop 接 be2 MCP 的 pilot 使用者。承接 `docs/be2-mcp/phase1a-runbook.md`（static bearer，Phase 1a）與 `docs/be2-mcp/phase2b-runbook.md`（確認頁 SSO）——本文件只講 **OAuth 2.1 外殼**：Claude 直接走瀏覽器登入 be2-auth，**不再需要手貼 bearer**。環境錨定 SIT `be2-220`。

## 這份文件在講什麼

Phase 1a 的接入方式是 `npm run bootstrap-user` 印出一次性 static bearer，手動貼進 `claude mcp add --header "Authorization: Bearer ..."`。這條路**仍然可用**，但現在是**過渡 fallback**（見下方「與 static bearer 的關係」），首選路徑是本文件講的 **OAuth 2.1**：Claude Code / Desktop 依 MCP 規範自動發現 `/oauth/authorize`、`/oauth/token`，跳出瀏覽器讓你用 be2 帳密+2FA 登入，全程不需要複製貼上任何 token。

外殼（discovery + DCR + PKCE + redirect_uri allowlist）照抄 kkday-development-tools 的既有做法（見 `reference-dev-tools-architecture.md`）；認證內核換成 auth-service 帳密+2FA login（見 `be2-mcp-auth-design.md`）。實作細節見 `src/oauth/`（`discoveryRoutes.ts` / `registerRoutes.ts` / `authorizeRoutes.ts` / `tokenRoutes.ts`）。

## 前置需求

- 公司網路或 VPN（能連 be2-auth `auth-220.sit.kkday.com` 開登入彈窗、能連 be2-mcp 本機 `127.0.0.1:$BE2_MCP_PORT`）。
- `npm run dev` 已啟動 be2-mcp server（`/mcp` + OAuth 端點 `/.well-known/*`、`/oauth/*` + 確認頁 `/confirm/*`，同一個 process）。
- 瀏覽器允許彈出視窗（登入走 **POPUP**，見下）。

## Claude Code 接入步驟

```bash
claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp
```

**不帶 `--header`**——這是與 Phase 1a 最大的差異。步驟：

1. Claude Code 打 `http://127.0.0.1:8787/mcp` 收到 `401` + `WWW-Authenticate`，依內容打 `/.well-known/oauth-protected-resource` 與 `/.well-known/oauth-authorization-server` 做 discovery，找到 `authorization_endpoint`/`token_endpoint`。
2. 依 RFC 7591 打 `POST /oauth/register` 動態註冊一個 public client（PKCE、無 `client_secret`）。
3. 開瀏覽器導向 `/oauth/authorize?...`（Claude Code 用 loopback redirect_uri，如 `http://127.0.0.1:<port>/callback`，已在 `redirectUri.ts` allowlist 內）。
4. be2-mcp 渲染一個過場頁，按「登入 be2」在**使用者手勢內**開 POPUP，導向 be2-auth 的 `auth/be2/login?loginFlow=POPUP` 登入頁——帳密 + 2FA（若瀏覽器已有 be2-auth SSO cookie 則靜默完成，見下方「SSO-seamless」）。
5. 登入成功，be2-auth 用 `postMessage` 把 authorizationCode 傳回過場頁（驗證訊息來源 origin）；過場頁 POST 到 be2-mcp 的 `/oauth/authorize/complete`，由 server 端帶 service key 換 `{accessToken, refreshToken, businessList}`，建立 identity + 鑄一次性 OAuth authz code，導回 Claude Code 的 loopback redirect_uri。
6. Claude Code 用 PKCE code_verifier 打 `/oauth/token` 換 `{access_token, refresh_token}`——此後每次 tool call 帶這組 Bearer，Claude Code 到期自動用 refresh_token 續期，全程免手動介入。

**Claude Desktop**（2026-08-14 實測落地路徑）：Settings → Developer → Local MCP servers → Edit Config（`claude_desktop_config.json`）加 `mcp-remote` stdio 代理，由它處理 OAuth（DCR、開瀏覽器、token 快取在 `~/.mcp-auth/`）：

```json
{
  "mcpServers": {
    "be2-mcp": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:8787/mcp", "--transport", "http-only"] }
  }
}
```

已知行為兩則：(1) `mcp-remote` 用**隨機 loopback port + `/oauth/callback`** 當 redirect_uri——`redirectUri.ts` 的 loopback 規則已放寬為任意 path（RFC 8252，commit `ef79956`），舊版鎖死 `/callback` 會讓 DCR 直接被拒。(2) 不帶 `--transport http-only` 時，授權可能**同時跳出兩個瀏覽器分頁**（預設 `http-first` 對 Streamable HTTP 與 SSE fallback 各發起一次 auth；be2-mcp 只有 Streamable HTTP，SSE 那次是浪費）——上面 config 已帶此參數鎖單一 transport，只會有一個分頁；若沿用舊 config 看到兩個，完成其中一個、關掉另一個即可，無害。（Settings → Connectors 的「Add custom connector」掛在 claude.ai 帳號層，亦可用，但同一顆 connector 在 claude.ai 網頁版連不到 `127.0.0.1`，屬預期。）

**登入腿為何是 POPUP、不是 REDIRECT**：見 `docs/be2-mcp/spike-oauth-login-leg.md`——POPUP 已在 SIT be2-220 實測跑通（`phase0-inventory.md` A8），REDIRECT flow 的跨網域 `redirectPath` allowlist 行為未實證，為求穩定先落地 POPUP，REDIRECT 留作未來優化（非阻擋項）。

## 與 static bearer（`bootstrap-user`）的關係

`npm run bootstrap-user` 印出的一次性 static bearer **改列為 headless/過渡 fallback**，用在：

- 本機沒有瀏覽器可跳轉的環境（純 CLI、CI、無頭腳本）。
- OAuth 外殼本身故障時的應急通道（排除 be2-mcp bug 之用）。
- 想在不驅動 Claude Code UI 的情況下，用 `curl`/腳本直接打 `/mcp` 驗證 server 行為。

兩條路徑**底層共用同一套 identity/credential store**（`be2_identities` + `credentials`，`kind = 'static_bearer'` vs `'oauth_access'`），差別只在「怎麼拿到這組 Bearer」；授權判斷（businessList、scope-gate）與稽核一視同仁，不因走哪條路而放寬。新 pilot 使用者建議直接用 OAuth（本文件），除非遇到上述無瀏覽器情境才退回 `bootstrap-user`（見 `phase1a-runbook.md`）。

## 確認頁的 SSO-seamless 行為（同瀏覽器免二次登入）

`/oauth/authorize/complete` 在換到 be2 identity 之後，會順手建立一個 **web_session**（`be2mcp_sid` HttpOnly cookie，`Path=/confirm`）——與確認頁（`docs/be2-mcp/phase2b-runbook.md`）用的是**同一套 web session 機制**。實務含意：

- 若你用同一顆瀏覽器完成 OAuth 授權（跑完上面步驟 1-6），之後開 `http://127.0.0.1:8787/confirm/<changeset_id>` 批准 change-set 時，**不會再被要求登入**——`be2mcp_sid` cookie 已經在，確認頁直接顯示 diff。
- 反之，若確認頁的 session 先過期（idle TTL，預設 8 小時），或你在另一顆瀏覽器/無痕視窗開確認頁，仍會被導去 `/confirm/login` 走一次 POPUP 登入——這與 OAuth 授權流程各自獨立、互不依賴，只是**同瀏覽器同 session 時共用同一顆 cookie**，體驗上感覺不到兩套系統。
- 兩者身分驗證的授權判斷**都委派 auth-service**（`businessList` + 換碼/refresh），be2-mcp 不本地驗簽、不自建 RBAC（見 `be2-mcp-auth-design.md`）。

## Token 生命週期治理：`oauth-purge`

OAuth 外殼會持續在 SQLite 累積三類「用過即該丟」的資料：

1. **過期 authorization code**（`oauth_auth_codes`，`exp < now`）——60 秒 TTL、一次性換碼，過期後毫無用途。
2. **過期 refresh token**（`oauth_refresh`，`exp < now`）——rotation 時舊 refresh 標 `consumed` 但**保留**（reuse-detection 需要），只有真正過期才刪除。
3. **無 credential 引用的 ghost `be2_identities`**——`be2_identities` 存的是**真實 be2 access/refresh token**，一旦沒有任何 `credentials` 列（`oauth_access`/`static_bearer`/`web_session`）指向它，就是一筆持續在 SQLite 裡洩漏真實憑證風險的孤兒列。典型成因：refresh-reuse 偵測到重放攻擊時觸發 family revoke（`tokenRoutes.ts` 的 `deleteByIdentityAndKind(identityId, 'oauth_access')`），砍光某 identity 的 credential 卻沒清 identity 本身。

```bash
npm run oauth-purge
```

薄殼腳本，實際邏輯是可測試的 `runOAuthPurge(db, now)`（`scripts/oauth-purge.ts`，見 `tests/oauthPurge.test.ts`）：純 SQL `DELETE ... WHERE exp < now`（過期兩表）+ `DELETE FROM be2_identities WHERE identity_id NOT IN (SELECT DISTINCT identity_id FROM credentials)`（ghost identity）。冪等——連續執行不會有第二次可刪的東西。

**建議排程**：仿 dev-tools 的 `oauth:purge` CronJob（`reference-dev-tools-architecture.md`），每日跑一次（例如 K8s CronJob 或本機 `cron`/`launchd`，Phase 1a 的 SIT 部署階段可先手動定期執行）。目前**不做** ghost `oauth_clients`（DCR 註冊但從未使用的孤兒 client）自動清理——需要一個寬限期判斷（避免砍掉剛註冊、還沒換過 token 的 client），複雜度較高、風險相對低，留待未來若有需要再補（見 `scripts/oauth-purge.ts` 檔頭註解）。

## 疑難排解

| 症狀 | 原因 | 處理 |
|---|---|---|
| Claude Code 顯示「connect」後跳出瀏覽器但沒反應 | 彈窗被瀏覽器擋（未在使用者手勢內開啟，或已封鎖彈出視窗） | 直接點頁面上的「登入 be2」按鈕本身，並允許該網站彈出視窗 |
| OAuth 授權完成、但確認頁仍要求登入 | 兩者用了不同瀏覽器/無痕視窗，`be2mcp_sid` cookie 沒有跨過去 | 用同一顆瀏覽器開確認頁；或直接在確認頁走一次獨立登入（見 `phase2b-runbook.md`） |
| 想確認 access token 到期後有沒有自動續期 | Claude Code 對 OAuth token 的 refresh 是 client 端自動行為，be2-mcp 只被動回應 `/oauth/token` 的 `refresh_token` grant | 觀察 audit log 是否持續有新的 tool call 成功，或查 `oauth_refresh` 表的 `consumed`/`exp` |
| 想切換回 static bearer | 沒有瀏覽器可用的環境，或要應急排除 OAuth 外殼問題 | 走 `phase1a-runbook.md` 的 `bootstrap-user` 流程 |

## Live 驗收

Live 驗收（真實 Claude Code + Desktop 各跑一次 OAuth 接入、確認同瀏覽器免二次登入、批准一個 draft change-set）由人工執行，結果記錄於本節：

> **狀態：Claude Code ✅ + Claude Desktop ✅ 皆已通（2026-08-14，SIT be2-220）**；「同瀏覽器開確認頁免二次登入」與「批准一個 draft change-set」待一併驗。

- **真人 Claude Desktop 接入 ✅**：走 `mcp-remote` stdio 代理（config 見「接入」節），OAuth 過場頁登入後，對話內 `be2_find_products` 查真商品成功（34133，PUBLISHED/上架中）。過程揪出並修掉 loopback redirect_uri path 鎖死問題（commit `ef79956`）。

2026-08-14 驗收記錄：
- **自動化 e2e（playwright，`FULL_E2E_OK`）**：DCR → `/oauth/authorize` 過場頁 → be2-auth POPUP 真帳密登入 → `CONFIRM_LOGIN_DOMAIN` 握手 → `UPDATE_AUTH_TOKEN` 收 code → server 端換碼建 identity → PKCE token exchange → 以 OAuth Bearer 打 `/mcp` `tools/list`（5 工具全列）。
- **真人 Claude Code 接入 ✅**：`claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp`（不帶 `--header`）→ `/mcp` Authenticate → 瀏覽器過場頁點「登入 be2」→ be2-auth 彈窗登入 → 自動導回、connected，tool call 正常。
- 過程修掉兩個 live 揪出的缺陷：(1) 過場頁未回 be2-auth 的 `CONFIRM_LOGIN_DOMAIN` 握手 → popup 一律 /404（commit `850ab96`）；(2) Phase 2b 前的舊 on-disk db `web_sessions` 缺 `identity_id` → complete 500，`openDb` 加舊 schema 重建 migration（commit `7fcdd85`）。
- **SIT 零外部依賴**：auth-220 開著 `ALLOW_LOCAL_LOGIN=true`（SIT/local 環境跳過 origin 白名單）。**prod 上線前**仍需請 auth-service 把 be2-mcp 部署 origin 納入 `login.be2.domain`（env `BE2_DOMAIN`，`includes()` 精確比對；prod `isDevEnv` 硬編 false）。詳見 `mcp-oauth-upstream-idp-pattern.md`。
