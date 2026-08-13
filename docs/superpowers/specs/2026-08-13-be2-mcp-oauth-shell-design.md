# be2 MCP — OAuth 2.1 外殼 + 確認頁 SSO-seamless design spec

日期：2026-08-13　狀態：draft（待使用者審 + agy-peer-review）
> 前置文件：`docs/be2-mcp/reference-dev-tools-architecture.md`（dev-tools OAuth 外殼逆向，直接借鏡）、`docs/be2-mcp/be2-mcp-auth-design.md`（認證內核換 auth-service、Part 3 SSO-seamless 構想）、`docs/be2-mcp/next-iteration-eval.md` §2（本設計的來源）、`docs/be2-mcp/phase0-inventory.md`（A7/A8 be2-auth 登入實證、B1/B2/B3 外部依賴）。
> **使用者離線期間以建議選項定案的假設（審查時可推翻）**：(1) 確認頁「只需確認」= **SSO-seamless（OAuth 登入建立的 be2-auth 瀏覽器 session 被確認頁靜默復用，仍 cookie-gated）**，非「無憑證純按鈕」；(2) OAuth client 只做 Claude Code + Desktop（本機 loopback，不碰 claude.ai 公網 ingress）；(3) token 存放沿用 Option 1（server 端 store）；(4) static bearer（bootstrap-user）保留為過渡/headless fallback。

## 1. 目標與非目標

**目標**：
1. Claude client（Code / Desktop）連 be2-mcp 時，透過 OAuth 2.1 走**瀏覽器 be2-auth 登入**換 token，取代現行「手動跑 `bootstrap-user`、手貼 static bearer」。帳密只打在 be2-auth 官方登入頁，不經 agent、不落地 `.env`。
2. **確認頁退路免二次登入**：OAuth 登入已在使用者瀏覽器建立 be2-auth session；使用者在同一瀏覽器開確認頁時直接顯示「確認執行」，不再彈第二次 be2-auth 登入。

**非目標**（明確不做）：
- ❌ claude.ai 網頁 host（需公網 HTTPS ingress + 資安核可，Phase 0 B3；本波只做本機 loopback client）。
- ❌ 移除確認頁的 be2-auth 登入**能力**——它保留為「沒有現成 session 的瀏覽器」的安全 fallback（見 §4.3）。
- ❌ 改動 token 存放模型（Option 1 已定案）、change-set/executor/面板批准（上一波 MCP Apps 已完成，本波不動）。
- ❌ 自建 RBAC / 自建 JWT 驗簽（授權仍以 businessList + auth-service `/verify` 為準）。

## 2. 現況與可復用素材（實查 2026-08-13）

| 積木 | 位置 | 復用方式 |
|---|---|---|
| be2-auth 換碼 → be2 token | `AuthServiceClient.exchangeCode(code)` → `{accessToken, refreshToken, businessList}` | OAuth authorize 的登入腿直接呼叫 |
| be2-auth 兩步登入 | `AuthServiceClient.login(account,pwd,{otp})` → `{authorizationCode}` | REST fallback（headless）用 |
| token 記錄建立 | `enrollUser(deps, {code}\|{account,password})` → 建 `TokenRecord`（`bearerHash` 存 sha256、userLabel 取 JWT `authKey`、`accessExpiresAt`）+ 回 bearer | OAuth token endpoint 的核心（把「回傳 bearer」改成「發 OAuth token」） |
| token 儲存 / 查詢 | `TokenStore.upsert/getByBearer/getByBearerHash`、`hashBearer` | OAuth access token 就是存這裡的不透明 bearer |
| be2 token lazy refresh | `TokenManager.getFreshAccessToken(bearer)` / `getFreshByHash(hash)` → 近到期自動 refresh + rotate | L2 refresh 不動，直接沿用 |
| be2-auth 瀏覽器登入頁 | `ssoRoutes.ts`：`/confirm/login`（POPUP launcher，postMessage 驗 origin）、`/confirm/session`（`exchangeCode` → 設 `be2mcp_sid` cookie）、`/confirm/logout` | authorize 腿的瀏覽器登入 + cookie 設定復用同一套 |
| 確認頁 session gate | `confirmRoutes.ts::requireSession`（讀 `be2mcp_sid` → `getFreshByHash`）；無 session → `loginRedirect` | **不改**；OAuth 登入設好 cookie 後它自動放行 |
| `/mcp` bearer gate | `app.ts`：`store.getByBearer(bearer)`；未知 → 401 | 加 `WWW-Authenticate` 指向 discovery；OAuth token 與 static bearer 同走此 gate |

**關鍵洞察**：OAuth 外殼 90% 是「把已存在的 `enrollUser` + `ssoRoutes` 登入 + `TokenStore`，包進 OAuth 2.1 協定端點」。真正新寫的只有協定層（discovery / DCR / authorize 編排 / token PKCE 驗證）與其狀態表。

## 3. 架構總覽

```
Claude (Code/Desktop)                     be2-mcp                          be2-auth
  │  1. 連 /mcp → 401 + WWW-Authenticate ───►│
  │  2. GET /.well-known/* (discovery) ─────►│
  │  3. POST /oauth/register (DCR) ─────────►│ 建 public client（PKCE、redirect allowlist）
  │  4. 開瀏覽器 → GET /oauth/authorize ────►│ 驗 client/redirect/PKCE challenge/state
  │                                          │  ──導向 be2-auth 登入（復用 ssoRoutes）──►│ 帳密+2FA
  │                                          │◄─ be2 authorizationCode ─────────────────┤
  │                                          │  exchangeCode → be2 {access,refresh,businessList}
  │                                          │  ① 存 TokenStore（不透明 OAuth token 的後端記錄）
  │                                          │  ② 設 be2mcp_sid cookie（給確認頁 SSO-seamless）
  │  ◄─ 5. 302 redirect_uri?code=&state= ────┤  鑄一次性 authz code（綁 client/redirect/PKCE）
  │  6. POST /oauth/token (code+verifier) ──►│ PKCE S256 驗 → 發不透明 access+refresh
  │  ◄─ {access_token, refresh_token} ───────┤
  │  7. 之後 /mcp 帶 Bearer <opaque> ───────►│ store.getByBearer → TokenManager 取 fresh be2 token
```

確認頁（同一瀏覽器）：使用者開 `/confirm/:id` → `requireSession` 讀到 step ② 設的 `be2mcp_sid` → 直接顯示「確認執行」（**無第二次登入**）。

## 4. 元件設計

### 4.1 新增 `src/oauth/`

| 檔案 | 端點 / 職責 |
|---|---|
| `discoveryRoutes.ts` | `GET /.well-known/oauth-protected-resource`（RFC 9728：宣告 resource + 指向本 AS）、`GET /.well-known/oauth-authorization-server`（RFC 8414：authorize/token/register endpoint、`code_challenge_methods_supported:['S256']`、`grant_types_supported:['authorization_code','refresh_token']`、`token_endpoint_auth_methods_supported:['none']`、scope）。純 JSON。 |
| `registerRoutes.ts` | `POST /oauth/register`（RFC 7591 DCR）：建 public client（無 secret）。`redirect_uri` **allowlist**：`https://claude.ai/api/mcp/auth_callback`（完全比對）+ RFC 8252 loopback（`http://localhost:<port>/callback`、`http://127.0.0.1:<port>/callback`，任意 port）。**回應刻意不含 `client_secret` key**（連 null 都不行，避開 Claude Code zod 型別衝突——dev-tools 已驗）。client 存 `oauthStore` clients 表。 |
| `authorizeRoutes.ts` | `GET /oauth/authorize`：驗 `client_id` 存在、`redirect_uri` 在該 client allowlist、`code_challenge`+`code_challenge_method=S256`、`response_type=code`、`state`。暫存 pending authz request（含 PKCE challenge）→ 驅動 be2-auth 瀏覽器登入（見 §4.2）。登入回來後：`exchangeCode` → 存 be2 token 記錄 + 設 `be2mcp_sid` cookie + 鑄一次性 authz code（綁 `client_id`/`redirect_uri`/`code_challenge`/token 記錄）→ `302` 回 `redirect_uri?code=&state=`。 |
| `tokenRoutes.ts` | `POST /oauth/token`（`grant_type=authorization_code`）：查 authz code（一次性、未過期、client/redirect 相符）→ **PKCE S256 驗**（`sha256(code_verifier)` base64url == 存的 `code_challenge`）→ 發不透明 access token（存 TokenStore，作為 `/mcp` bearer）+ 不透明 refresh token（存 oauthStore）。`grant_type=refresh_token`：驗+rotate（發新 access+refresh、刪舊 refresh、可回新鮮 businessList，L2 已處理）。 |
| `oauthStore.ts` | SQLite 三張表：`oauth_clients`（client_id、redirect_uris、created_at）、`oauth_auth_codes`（code hash、client_id、redirect_uri、code_challenge、bearerHash 指向 TokenStore 記錄、exp、一次性 consumed 標記）、`oauth_refresh`（refresh hash → bearerHash、exp）。**只存 hash**（code / refresh token 明文不落地）。 |

### 4.2 Authorize 的 be2-auth 登入腿（含風險備案）

**主路線（REDIRECT flow）**：`/oauth/authorize` 導向 `be2-auth /auth/be2/login?loginFlow=REDIRECT&redirectPath=<be2-mcp /oauth/authorize/callback>`；be2-auth 登入成功 POST token 回 callback；be2-mcp callback 完成 §4.1 authorize 收尾。
**風險**：be2-auth 的 REDIRECT flow 對「非 be2-web 的跨網域 `redirectPath`」allowlist 行為**未實證**（Phase 0 B2 殘留；A7 讀原始碼 `validateRedirectPath` 幾乎不設限，但未跑過）。
**備案（POPUP flow，已 SIT 實證 A8）**：`/oauth/authorize` 渲一個過場頁，沿用 `ssoRoutes.ts` 的 POPUP + postMessage（origin 驗證）取 be2 code，再 AJAX 打 be2-mcp 完成 authorize 收尾並回傳 `redirect_uri`。POPUP 模式 be2-web 自己就在用、已驗，**若 REDIRECT 談不成直接走這條**。

### 4.3 確認頁 SSO-seamless（本波對確認頁的唯一改動＝零改動 + 一個 cookie）

- **確認頁 `confirmRoutes.ts` 不改**。它的 `requireSession` 已經是「有 `be2mcp_sid` → 放行顯示確認按鈕；無 → `loginRedirect` 彈登入」。
- 本波唯一新增：**authorize 腿登入成功時設 `be2mcp_sid` cookie**（§4.1 step ②，與 `/confirm/session` 設 cookie 完全相同的做法、同一個 `WebSessionStore`）。
- 結果：使用者用「做 OAuth 登入的那個瀏覽器」開確認頁 → 已有 cookie → 直接確認，**無二次彈窗**（＝使用者要的「只需確認」）。用**別的**瀏覽器開 → 無 cookie → 退回彈 be2-auth 登入（**安全 fallback，不移除**）。
- **安全不變式維持**：批准仍 gated on `be2mcp_sid`（HttpOnly cookie）。Claude Code 上 agent 有 curl 但**拿不到使用者瀏覽器的 cookie**，`POST /confirm/:id/approve` 無 cookie → `requireSession` 回 undefined → redirect 登入 → agent 走不下去。**防自我批准（鐵則 #4）結構上不變**。（面板批准路徑〔Desktop、nonce〕本波不動，仍照 MCP Apps spec。）

### 4.4 修改既有

| 檔案 | 修改 |
|---|---|
| `src/server/app.ts` | 掛 oauth router（discovery/register/authorize/token）；`/mcp` 的 401 回應加 `WWW-Authenticate: Bearer resource_metadata="<discovery url>"`（RFC 9728，讓 Claude 自動發起 OAuth）；bearer gate 不變（OAuth token 與 static bearer 同為 TokenStore 記錄，`getByBearer` 通吃）。authorize 腿與 ssoRoutes 共用 `authServiceClient`/`tokenStore`/`webSessions` 實例。 |
| `src/server/ssoRoutes.ts` | 抽出「exchangeCode → 建 be2 token 記錄 + 設 be2mcp_sid」為共用 helper（`/confirm/session` 與 oauth authorize 共用單一實作，避免兩套 session 建立邏輯漂移）。 |
| `bootstrap-user` / `enroll.ts` | **保留**（headless / 過渡 fallback）。`enrollUser` 的 token 記錄建立邏輯抽共用給 oauth token endpoint（單一實作）。 |
| token 生命週期治理 | 新增 purge：過期 authz code / oauth refresh / ghost client 定期硬刪（仿 dev-tools `oauth:purge`）。本波先做一個可手動跑的 script，cron 化後續。 |

## 5. 資料流（三條）

**A. 首次接入（OAuth）**：Claude 連 `/mcp` → 401+WWW-Authenticate → discovery → DCR → 開瀏覽器 authorize → be2-auth 登入（帳密+2FA）→ exchangeCode 存 be2 token + 設 be2mcp_sid → 授權碼 → token endpoint PKCE 換不透明 token → Claude 存 token → 後續 `/mcp` 帶它。
**B. 批准（同瀏覽器）**：使用者開確認頁 → be2mcp_sid 已在 → 直接「確認執行」→ 既有 approve 流（liveDiff/CAS/execute，不改）。
**C. Refresh**：L1 Claude 用 OAuth refresh token 換新不透明 access（rotate）；L2 be2-mcp store 內 be2 token 近到期時 `TokenManager` lazy refresh（既有）。兩層獨立。

## 6. 錯誤處理

| 情境 | 行為 |
|---|---|
| redirect_uri 不在 allowlist | authorize 回 400，**不 redirect**（防 open redirector） |
| PKCE verifier 不符 / code 已用 / code 過期 | token endpoint 回 `invalid_grant`，不發 token |
| be2-auth 登入失敗 / 2FA 錯 | authorize 腿顯示錯誤，不鑄 code |
| REDIRECT flow redirectPath 被 be2-auth 擋 | 退 POPUP 備案（§4.2） |
| 確認頁不同瀏覽器（無 cookie） | 退回彈 be2-auth 登入（安全 fallback，非錯誤） |
| OAuth token 撤銷 / be2 refresh 失效 | `/mcp` 401 + WWW-Authenticate → Claude 重走 OAuth；確認頁 dead session → 刪 + redirect（既有 Phase 2b 行為） |
| static bearer 與 OAuth token 並存 | 皆為 TokenStore 記錄，getByBearer 通吃，無衝突 |

## 7. 測試

- **單元/整合（vitest，進 CI）**：
  - discovery JSON 欄位正確（PKCE S256、auth methods none、endpoint URL）。
  - DCR：redirect_uri allowlist（claude.ai 完全比對 + loopback 任意 port 通過、非 allowlist 拒）、回應**不含 client_secret key**。
  - authorize：缺/錯 client_id、redirect_uri 不符、缺 PKCE challenge、缺 state → 各自拒；正常 → 導登入。
  - token：PKCE S256 正確/錯誤 verifier、code 一次性（第二次 invalid_grant）、code 過期、client/redirect 不符 → 拒；正常 → 發不透明 token 且該 token 能過 `/mcp` gate。
  - refresh rotate：舊 refresh 失效、新 access 可用。
  - **SSO-seamless**：authorize 登入後 be2mcp_sid 已設 → 確認頁 requireSession 放行（不 redirect）；**無 cookie → 仍 redirect 登入**（fallback 未被移除）。
  - **防自我批准回歸**：帶 OAuth token（非 cookie）打 `/confirm/:id/approve` → 無 be2mcp_sid → redirect，不執行（鐵則 #4 不變）；Phase 2b 既有 confirm 測試全綠。
  - static bearer 與 OAuth token 並存互不干擾。
- **Live 驗收（人工）**：Claude Code + Desktop 各跑一次真實 OAuth 接入（含 loopback callback）→ 免手貼 bearer 連上 → 同瀏覽器開確認頁免二次登入 → 批准一個 draft change-set（寫入 403 為已知，不阻擋 OAuth/SSO 驗收）。
- **威脅測試**：open-redirect（惡意 redirect_uri）、code replay、PKCE downgrade、跨 client code 竊用 → 全拒。

## 8. 對既有文件的連動修正（實作時一併）

- `CLAUDE.md`「開發指令」：`bootstrap-user` 標為「headless/過渡 fallback」；新增 OAuth 接入說明（或指向新 runbook）。
- `phase0-inventory.md` B2：REDIRECT flow 實證結果回填；B1 prod service key 上線前申請提醒。
- 新增 `docs/be2-mcp/oauth-runbook.md`：Code/Desktop 的 OAuth 接入步驟、與 static bearer 的關係、SSO-seamless 確認頁行為說明。

## 9. 風險與開放問題

1. **be2-auth REDIRECT flow 跨網域 redirectPath**（Phase 0 B2 殘留）：未實證；主路線用它、備案 POPUP（已證）。實作第一步應先 spike 這條，談不成即切 POPUP。
2. **Claude Code / Desktop 對 loopback callback 的 OAuth 行為差異**：dev-tools 已對 claude.ai 驗過，但 Code/Desktop（本波主力 client）需各實測一次（callback 是 loopback 還是 claude.ai）。
3. **SSO-seamless 的瀏覽器同一性假設**：「只需確認」的無彈窗體驗依賴「使用者用做 OAuth 的同一瀏覽器開確認頁」。不同瀏覽器 → 有彈窗（安全，但非無縫）。可接受。
4. **prod service key / 公網 ingress**：本波 SIT + 本機 loopback；prod 上線另需 B1 prod key、若要 claude.ai 網頁另需 B3 公網 + 資安。
5. **cookie path/scope**：`be2mcp_sid` 現為 `path=/confirm`；authorize 腿設它時需確認 path/SameSite 與確認頁一致（同一 `WebSessionStore`、同一 hash 規則），避免兩套 session。
