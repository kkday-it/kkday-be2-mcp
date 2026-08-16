# be2 MCP — OAuth 2.1 外殼 + 確認頁 SSO-seamless design spec

日期：2026-08-13　狀態：已過 agy-peer-review（rounds=2）、**待使用者審**
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

**關鍵洞察**：OAuth 外殼的協定層（discovery / DCR / authorize 編排 / token PKCE）是新寫；但認證內核（be2-auth 登入、be2 token refresh）全復用。

**⚠️ 但現行 `TokenStore` 的扁平模型撐不起「一次 be2 登入同時支撐 cookie 與 OAuth token」——必須先拆分 identity 與 credential（agy round-1，見 §4.0）。** 現行 `TokenStore` 以 `bearerHash` 為主鍵、be2 token 內嵌其上：一個 credential = 一次獨立 be2 登入。SSO-seamless 要「authorize 一次登入 → 同時發 OAuth token 給 agent + 設 be2mcp_sid cookie 給瀏覽器」，若沿用扁平模型會二選一皆錯：(A) 兩者共用同一筆記錄 → OAuth token 字串 == cookie 字串（同一 `bearerHash`）→ **agent 拿到 OAuth token 即等於拿到 cookie 值，可 `curl -H "Cookie: be2mcp_sid=<token>"` 自我批准**；(B) 兩筆記錄各存一份相同 be2 `refreshToken` → 其一 lazy refresh rotate 後，另一筆的 refresh 變 stale → 下次 refresh `REAUTH_REQUIRED`、隨機炸掉瀏覽器或 agent session。故本波**先做 identity/credential 拆分（§4.0）**，才動 OAuth 協定層。

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

### 4.0 資料模型：拆分 identity 與 credential（agy round-1，本波第一步）

把「be2 token 狀態」與「存取憑證」拆成兩層，一個 identity 可被多個 credential 引用；refresh 只在 identity 層做一次。

```
be2_identities                     一次 be2 登入 = 一筆
  identity_id (pk)                 隨機
  user_label                       JWT authKey（同 enroll 現行推導）
  be2_access_token, be2_refresh_token, business_list, access_expires_at, updated_at

credentials（access 憑證，多對一 → identity）
  cred_hash (pk)                   sha256(credential 明文)；明文永不落地
  identity_id (fk)
  kind                             'oauth_access' | 'static_bearer' | 'web_session'
  expires_at, updated_at

oauth_clients   : client_id, redirect_uris[], created_at
oauth_auth_codes: code_hash(pk), client_id, redirect_uri, code_challenge, identity_id, exp, consumed
oauth_refresh   : refresh_hash(pk), identity_id, client_id, exp
```

- **credential 值 ≠ identity；三種 credential（OAuth access token、static bearer、be2mcp_sid cookie）各自是獨立隨機字串、各一筆 `credentials`，都指向同一 identity**。→ agent 持有的 OAuth access token 與瀏覽器的 be2mcp_sid cookie **是不同字串**，agent 拿不到 cookie 值（解 Scenario A 自我批准）。
- **be2 refresh 只存在 identity 一處、rotate 只發生一次**（解 Scenario B clobber）。`TokenManager` 改為對 identity 操作：credential 查詢 → 取 identity → 近到期 lazy refresh identity 的 be2 token（single-flight 鎖沿用）→ 更新 identity 一筆，所有引用它的 credential 立即拿到新鮮 be2 token。
- **`/mcp` bearer gate**：`credentials.get(hashBearer(bearer))` → identity；OAuth access token 與 static bearer 都是 `credentials` 列，通吃、無混淆（解 static/OAuth 並存）。
- **確認頁 session gate**：`be2mcp_sid` cookie 值 → `credentials`（kind=web_session）→ identity。requireSession 邏輯等價，只是多一層 identity 解引用。
- **遷移**：現行 `TokenStore`（扁平 `user_tokens`）→ 拆成 `be2_identities` + `credentials`。`enrollUser`、`ssoRoutes /confirm/session`、`WebSessionStore`、`confirmRoutes requireSession`、`app.ts` bearer gate、`TokenManager` 都改走新模型。這是本波**最大的一塊改動**，OAuth 協定層蓋在其上。

### 4.1 新增 `src/oauth/`

| 檔案 | 端點 / 職責 |
|---|---|
| `discoveryRoutes.ts` | `GET /.well-known/oauth-protected-resource`（RFC 9728：宣告 resource + 指向本 AS）、`GET /.well-known/oauth-authorization-server`（RFC 8414：authorize/token/register endpoint、`code_challenge_methods_supported:['S256']`、`grant_types_supported:['authorization_code','refresh_token']`、`token_endpoint_auth_methods_supported:['none']`、scope）。純 JSON。 |
| `registerRoutes.ts` | `POST /oauth/register`（RFC 7591 DCR）：建 public client（無 secret）。`redirect_uri` **allowlist**：`https://claude.ai/api/mcp/auth_callback`（完全比對）+ RFC 8252 loopback（`http://localhost:<port>/callback`、`http://127.0.0.1:<port>/callback`，任意 port）。**回應刻意不含 `client_secret` key**（連 null 都不行，避開 Claude Code zod 型別衝突——dev-tools 已驗）。client 存 `oauthStore` clients 表。 |
| `authorizeRoutes.ts` | `GET /oauth/authorize`：驗 `client_id` 存在、`redirect_uri` 在該 client allowlist、`code_challenge`+`code_challenge_method=S256`、`response_type=code`、`state`。暫存 pending authz request（含 PKCE challenge）→ 驅動 be2-auth 瀏覽器登入（見 §4.2）。登入回來後：`exchangeCode` → 存 be2 token 記錄 + 設 `be2mcp_sid` cookie + 鑄一次性 authz code（綁 `client_id`/`redirect_uri`/`code_challenge`/token 記錄）→ `302` 回 `redirect_uri?code=&state=`。 |
| `tokenRoutes.ts` | `POST /oauth/token`（`grant_type=authorization_code`）：查 authz code（一次性、未過期、client/redirect 相符）→ **PKCE S256 驗**（`sha256(code_verifier)` base64url == 存的 `code_challenge`）→ 發不透明 access token（存 `credentials` kind=oauth_access → 指向 code 綁的 identity）+ 不透明 refresh token（`oauth_refresh` → identity）。`grant_type=refresh_token`：驗舊 refresh → rotate：**發新 access + 新 refresh、刪舊 refresh、且刪掉舊 access token 的 `credentials` 列**（rotation 即時撤銷舊 access，不留可用殘證、不漏 DB 列——agy round-1）。identity 的 be2 token 由 `TokenManager` L2 lazy refresh，與此 L1 rotation 獨立。 |
| `oauthStore.ts` | 管理 §4.0 的 `oauth_clients` / `oauth_auth_codes` / `oauth_refresh` 三表（`credentials` / `be2_identities` 由拆分後的 store 管）。**只存 hash**（code / refresh / access token 明文不落地）。 |

### 4.2 Authorize 的 be2-auth 登入腿（含風險備案）

**主路線（REDIRECT flow）**：`/oauth/authorize` 導向 `be2-auth /auth/be2/login?loginFlow=REDIRECT&redirectPath=<be2-mcp /oauth/authorize/callback>`；be2-auth 登入成功 POST token 回 callback；be2-mcp callback 完成 §4.1 authorize 收尾。
**風險**：be2-auth 的 REDIRECT flow 對「非 be2-web 的跨網域 `redirectPath`」allowlist 行為**未實證**（Phase 0 B2 殘留；A7 讀原始碼 `validateRedirectPath` 幾乎不設限，但未跑過）。
**備案（POPUP flow，已 SIT 實證 A8）**：`/oauth/authorize` 渲一個過場頁，沿用 `ssoRoutes.ts` 的 POPUP + postMessage（origin 驗證）取 be2 code，再 AJAX 打 be2-mcp 完成 authorize 收尾並回傳 `redirect_uri`。POPUP 模式 be2-web 自己就在用、已驗，**若 REDIRECT 談不成直接走這條**。

### 4.3 確認頁 SSO-seamless（本波對確認頁的唯一改動＝零改動 + 一個 cookie）

- **確認頁 `confirmRoutes.ts` 不改**。它的 `requireSession` 已經是「有 `be2mcp_sid` → 放行顯示確認按鈕；無 → `loginRedirect` 彈登入」。
- 本波唯一新增：**authorize 腿登入成功時,對同一 identity 額外發一個 web_session credential 並設為 `be2mcp_sid` cookie**（§4.0：cookie 值是獨立隨機字串、與 OAuth access token 不同、各一筆 credential 指向同 identity；與 `/confirm/session` 走同一 helper、同 hash 規則、同 store）。**cookie 值 ≠ OAuth token 值**是防自我批准的關鍵（§4.0 Scenario A）。
- 結果：使用者用「做 OAuth 登入的那個瀏覽器」開確認頁 → 已有 cookie → 直接確認，**無二次彈窗**（＝使用者要的「只需確認」）。用**別的**瀏覽器開 → 無 cookie → 退回彈 be2-auth 登入（**安全 fallback，不移除**）。
- **安全不變式維持**：批准仍 gated on `be2mcp_sid`（HttpOnly cookie）。agent 持有的是 OAuth access token（另一筆 credential、另一個字串，§4.0），**不等於也推不出 cookie 值**；Claude Code 上 agent 用 curl `POST /confirm/:id/approve` 無正確 be2mcp_sid → `requireSession` 回 undefined → redirect → 走不下去。即使 agent 拿自己的 OAuth token 當 `Cookie: be2mcp_sid=<oauth_token>` 送，該值 hash 出的 credential 是 kind=oauth_access、非 web_session，requireSession 應**同時檢查 kind==web_session**（否則 §4.0 Scenario A 從另一角度復活）→ 拒。**防自我批准（鐵則 #4）結構上不變**。（面板批准路徑〔Desktop、nonce〕本波不動。）

### 4.4 修改既有

| 檔案 | 修改 |
|---|---|
| `src/server/app.ts` | 掛 oauth router；`/mcp` 401 加 `WWW-Authenticate: Bearer resource_metadata="<discovery url>"`（RFC 9728）；bearer gate 改查 `credentials`（OAuth access token 與 static bearer 同為 credential 列，通吃）。**`sessionOwner` 改綁 `identity_id`（非 rotating 的 bearerHash）**：現行 `sessionOwner.set(mcpSessionId, hashBearer(bearer))` 在 OAuth token rotate 後會因新 bearerHash 觸發 `SESSION_OWNER_MISMATCH` 403、切斷 agent MCP session（agy round-1）。改綁 credential 解出的 `identity_id` → rotation 換 token 不換 identity，MCP session 存活。authorize 腿與 ssoRoutes 共用同一套 identity/credential store + `authServiceClient`。 |
| `src/server/ssoRoutes.ts` | 抽出「exchangeCode → 建/取 identity + 發一個 credential（web_session / oauth 各自呼叫）」為共用 helper（`/confirm/session` 與 oauth authorize 共用單一 identity 建立實作，避免漂移）。 |
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
| OAuth access token rotation | 新 access 的 credential 綁**同 identity** → `sessionOwner` 綁 identity 不變 → MCP session 存活；舊 access credential 列**即時刪除** → 立刻失效、不漏 DB 列（§4.1 token endpoint） |
| identity be2 token rotate（L2） | 只在 identity 一處 rotate → 所有引用它的 credential（OAuth token / cookie / static bearer）同步拿到新鮮 be2 token，**無 Scenario B clobber** |
| static bearer 與 OAuth token 並存 | 皆為 `credentials` 列指向各自 identity，bearer gate 通吃，無衝突 |
| agent 拿 OAuth token 當 cookie 送確認頁 | credential kind=oauth_access ≠ web_session → requireSession 拒（§4.3） |

## 7. 測試

- **單元/整合（vitest，進 CI）**：
  - discovery JSON 欄位正確（PKCE S256、auth methods none、endpoint URL）。
  - DCR：redirect_uri allowlist（claude.ai 完全比對 + loopback 任意 port 通過、非 allowlist 拒）、回應**不含 client_secret key**。
  - authorize：缺/錯 client_id、redirect_uri 不符、缺 PKCE challenge、缺 state → 各自拒；正常 → 導登入。
  - token：PKCE S256 正確/錯誤 verifier、code 一次性（第二次 invalid_grant）、code 過期、client/redirect 不符 → 拒；正常 → 發不透明 token 且該 token 能過 `/mcp` gate。
  - refresh rotate：舊 refresh 失效、新 access 可用。
  - **SSO-seamless**：authorize 登入後 be2mcp_sid 已設 → 確認頁 requireSession 放行（不 redirect）；**無 cookie → 仍 redirect 登入**（fallback 未被移除）。
  - **防自我批准回歸**：(a) 帶 OAuth token（非 cookie）打 `/confirm/:id/approve` → 無 be2mcp_sid → redirect，不執行；(b) 把自己的 OAuth token 塞進 `Cookie: be2mcp_sid=<token>` → credential kind≠web_session → requireSession 拒（鐵則 #4 不變）；Phase 2b 既有 confirm 測試全綠。
  - **identity/credential 拆分回歸**：(a) OAuth token rotate 後同一 mcp-session 續用不觸發 SESSION_OWNER_MISMATCH（綁 identity）；(b) rotate 後舊 access token 打 `/mcp` 立即失效（列已刪）；(c) 一個 identity 被 cookie + OAuth token 同時引用時，L2 refresh rotate 後兩者都拿到新鮮 be2 token、皆不 REAUTH_REQUIRED（無 Scenario B）；(d) cookie 值與 OAuth token 值為不同字串。
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
5. **cookie path/scope**：`be2mcp_sid` 現為 `path=/confirm`；authorize 腿設它時需確認 path/SameSite 與確認頁一致（同一 store、同一 hash 規則），避免兩套 session。
6. **redirect_uri 驗證嚴格解析**（agy round-1）：loopback allowlist 必須 `new URL(uri)` 解析後斷言 `hostname === 'localhost' || hostname === '127.0.0.1'`（+ path === '/callback'），**不可用字串前綴/naive regex**，否則 `http://localhost.evil.com/callback` 之類會繞過（open redirect）。claude.ai callback 走完全字串比對。
7. **identity/credential 拆分是 auth 核心重構**：影響 `enrollUser`/`TokenManager`/`ssoRoutes`/`confirmRoutes`/`app.ts`；實作應先做這層 + 跑既有全部 auth/confirm 測試綠（零回歸），再疊 OAuth 協定層。是本波風險與工作量最大的一塊。

<!-- agy-peer-reviewed: 2026-08-13T00:22:05Z rounds=2 verdict=approved -->
