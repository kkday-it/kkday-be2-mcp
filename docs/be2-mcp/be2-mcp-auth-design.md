# be2 MCP 認證設計：借鏡 dev-tools + 內核換成 auth-service

> 搭配讀 `reference-dev-tools-architecture.md`（外殼怎麼做）與主 spec `../superpowers/specs/2026-08-07-be2-mcp-design.md`。
> 核心命題：**外殼照抄 dev-tools 的 OAuth 2.1 那層；認證內核從「Google SSO + 自建 RBAC」換成「kkday-auth-service login + businessList」。**

## 已確認事實：kkday-auth-service 是什麼（逆向自 repo，2026-08-08）

它是 be2（+17 平台）的**中央認證授權服務**，Laravel 9。**不是 OAuth 2.1 AS**，而是「帳密+2FA 發 JWT 的 IdP」。

be2 登入 = **帳密 + 2FA（OTP / Google2FA），前面沒有企業 SSO**。而且**它本身就是 authorization-code flow（兩步）**——這是對 OAuth 外殼最大的利多：

1. `POST /api/v1/auth/{userType}/login`（`web` middleware + `convertUserTypeToPlatform`）→ `UserLoginConcrete::authenticate()`。**只回一個 `authorizationCode`（UUID）**；真正的 accessToken/refreshToken 存進 Redis（`LoginAuthorizationCodeCacheKey`，短命）。2FA 帶 `device`+`otp` 在這步驗（`is_enable_two_fa` 才驗）。
2. `GET /api/v1/login-authorization-code/{authorizationCode}`（`authenticateCorsWithCookie:read` + `serviceAuth:read`，可帶 `device`/`otp`）→ 換出 **`{accessToken, refreshToken, businessList}`**。

- 2FA 相關：`auth/{userType}/two-fa/status`、`auth/{userType}/two-fa/otp`；錯誤 `AU9011 User two fa error`。
- **JWT（access ~50min，refresh 另一顆，TTL 見 `config/jwt.php`）**。access token payload claims：`authOid`、`authKey`、`subAuthOid`、`platformOid`、`deputyOid`、`platformDeputyOid`、`userType`、`optional`（locale）、`groupOids`（hex 編碼的群組）、`platformId`。**JWT 內沒有 businessList** — `businessList`（授權 action 清單）是換碼 response 的欄位，由 groupOids→actions 推導。簽章走 `Lcobucci\JWT`（HMAC / HS256）。

給 be2 MCP 串接的機制：

| 機制 | 是什麼 | be2 MCP 用途 |
|---|---|---|
| `auth/{userType}/login` + `two-fa/*` | 帳密+2FA 換 JWT | authorize 步驟換取 be2 使用者身分 |
| `login-authorization-code/{code}` | cookie+servicekey 換碼取 JWT | 若重用 be2-auth 前端登入頁走這條 |
| `verifyUserToken:{read\|write}`（`VerifyWithUserToken` middleware） | 驗 be2 使用者 JWT | 每次 tool call 驗身分 |
| `serviceAuth:{scope}`（`ServiceAuth` middleware） | service key，服務對服務 | be2 MCP ↔ auth-service/gateway |
| `POST /api/v1/verify`（`serviceAuth:gateway`, `EntryController`） | gateway per-URL authz 判斷點 | 每筆 be2 呼叫的授權 |

service key scope 對應（auth-service `config/serviceKey.php` + `getServiceKeySet()`）：`WRITE_SERVICE_KEY`=read+write、`SCM_WEB_SERVICE_KEY`=read+scmweb、`GATEWAY_SERVICE_KEY`=gateway、`BE2CI_SERVICE_KEY`=be2ci。**申請時確認放寬哪一邊，別把 read 塞進不該有的 key。**

## Part 1 — 從 dev-tools 直接借鏡（與後端無關，照抄結構）

按價值排序：

1. **OAuth 2.1 外殼三件套（最大借鏡）**：`MetadataController`（`.well-known` discovery）+ `RegisterController`（DCR：redirect_uri allowlist + public/PKCE + **不回 client_secret** 避開 Claude zod）+ authorize 未登入 redirect 登入。**已對 claude.ai 實戰驗證，直接搬。** `redirect_uri` allowlist（`https://claude.ai/api/mcp/auth_callback` + loopback）原封不動抄。
2. **input 永不接身分，一律由 token 推導**：操作者/scope 從 token 取，input 不收。直接實現主 spec §6 的 server-side scope-binding 防注入。
3. **手刻 JSON-RPC 2.0（4 method）**：證明不用重框架（主 spec 選 TS `@modelcontextprotocol/sdk` 亦可）。
4. **每次 tool call audit log（actor + tool）+ stateless fail-closed gate**：inactive 一律 deny → 對應主 spec §7 稽核與離職 revoke。
5. **token 生命週期治理 cron**：仿 `oauth:purge` 硬刪過期 token + ghost DCR client。

## Part 2 — 必須換掉的那一格

```
dev-tools:  authorize ─redirect─> Google Socialite ─> 自建 PlatformUser（自建 RBAC）
be2 MCP:    authorize ─redirect─> auth-service 帳密+2FA ─> be2 user（subAuthOid + businessList）
```

外殼一樣，內核換成 auth-service login + businessList。

## Part 3 — auth-service 驅動的認證流（定案版，對齊主 spec §2/§3）

**登入 = redirect-based 到 be2-auth v3 web 登入（不是 SPA 直呼 REST）。** 這樣才由瀏覽器驅動、能設/讀 be2-auth cookie，一顆 cookie 同時治理 be2-web / Claude OAuth / 確認頁三處（SSO-like，已登入 be2-web 者接 Claude、開確認頁皆靜默）。登入內部仍走 auth-service 原生兩步 code flow（`login`→`authorizationCode`→`login-authorization-code` 換 `{accessToken, refreshToken, businessList}`）。REST 自架登入（`POST auth/be2/login`）只作為「be2-auth redirect 契約談不成」的 fallback，會失去 SSO 無縫。

**token 存放 = Option 1：server 端 store——已定案（2026-08-09）：**
- be2 token（access + refresh + businessList）存 **be2-mcp 內網共用 store**（Redis/DB，key=OAuth subject）；發給 Claude 的 OAuth token 只是**不透明參考**。**be2 憑證不離境**（免加密封裝、免 B4 核可）。
- tool call：Claude 帶參考 token → be2-mcp 從 store 撈 be2 access → 呼叫。
- 兩層 refresh：L1（Claude↔be2-mcp）Claude 自動續 OAuth 參考 token；L2（be2-mcp↔auth-service）store 內 be2 access 近到期時 lazy 打 `PATCH /refresh-token` 換新（回 fresh businessList）寫回 store。rotate 天然正確（token 在 server 端）。
- **並發防護**：L2 refresh 需 per-user single-flight / 分散式鎖（Redis），避免並發 refresh 撞 rotation。
- 對齊 be2-web（server session）與 dev-tools（Passport token store）。（曾評估 Option 2 encapsulation，因需離境核可+加密工程、且 store 反正要有而不採。）

**token 驗證：一律委派 auth-service `/verify`、不本地驗簽。** `VerifyWithUserToken` middleware 就是把 Bearer 當 `authKey` + `{target, ip, method, uri}` 丟 `EntryService::verifyRequest()`，一次做完驗簽 + 過期 + user_status + per-uri authz。走 gateway 的 read tool 由 gateway 代打；be2-mcp 本地服務的 L2 change-set tool 須自己帶 service key 打 `/verify`。

**確認頁**：獨立瀏覽器 web app、be2-mcp server-managed web session（redirect 登入、be2 token 存**同一套 server store**、be2-mcp 自管續期；授權委派 `/verify`；不解析 Laravel cookie）。與 tool-call 面模型一致。

## Part 4 — 設計後果（對齊主 spec）

1. **`businessList` 是 auth-service 送的紅利**：MCP 層先過濾「這 user 能不能用這 tool / 建這種 change-set」，fail-fast，**不用自建 RBAC**。且 refresh 會回**新鮮** businessList（見 Part 6 findings），故權限變更在下次 refresh（~50min）反映，不必等重登。
2. **token 存 server 端、不離境（Option 1）**：be2 token 存 be2-mcp 內網共用 store；給 Claude 的只是不透明參考。tool-call 面與確認頁 web 面共用同一套 store、模型一致。be2 憑證不離開 KKday 邊界。
3. **2FA 只在首次 authorize 做一次**，TTL 內靠 L1/L2 refresh 續；離職/降權 → auth-service `user_status` 改動 → 下次 `/verify` 或 refresh 即 fail-closed（refresh 也檢查 user_status，見 findings）。
4. **be2 的 IdP 具體就是 auth-service（無企業 SSO）**，故必須自架 OAuth 外殼（Phase 1b 不可省）。

## Part 5 — Phase 0 卡關項（狀態）

| 項目 | 狀態 | 備註 |
|---|---|---|
| service key 申請 + scope | ⬜ 需人 | 跟 auth-service team 要，照 scope 對應表 |
| be2-auth v3 redirect/callback 契約 | ⬜ 需人（載重） | 主要登入路徑；談不成退回 REST fallback |
| refresh 端點 rotation/TTL 政策 | ✅ 已查證 | rotate、~50min、回 fresh businessList（Part 6） |
| cookie 耦合（login-authz-code / refresh） | ✅ 已查證 | **cookie 非必需**，headless S2S 帶 service key 即可（Part 6） |
| `/verify` input/output 契約 | ✅ 已查證 | `{target, ip, method, uri, authKey}` → void/throw（Part 6） |
| userType=be2 → platform 對應 | 🟡 幾乎確認 | `EnumPlatform` 有 be2↔userType 雙向 map，確認確切字串 |
| be2 product 目標 endpoint + API-UI 權限等價性盤點 | ⬜ 需做 | kk-graph-v2 + 低權帳號實測（KBACKEND Confluence 2220097560） |

## 附錄 — 已讀原始碼確認（auth-service, 2026-08-08）

- **`UserLoginConcrete::authenticate($request)`**（`app/Concretes/UserLoginConcrete.php`）：input `{account, password, platform, userType, device?, optional?}`。內部 `loginGetUserWithSub` 驗帳密 → `is_enable_two_fa` 且有 device 時 `validate2fa` → `generateLoginTokens`。**回傳只有 `authorizationCode`**（`LoginResource` 也只吐這個 key）。access/refresh token 用 `Jwt::creator()->createTokenByMinute(ttl, payload)` 產生後存 Redis（`LoginAuthorizationCodeCacheKey`），等換碼取出。
- **`VerifyWithUserToken` middleware**（`serviceType` 參數 = read/write）：取 `bearerToken()` 當 `authKey`，組 `{target:'auth', ip:[X-Forwarded-For], method, uri, authKey}` → 呼叫 `EntryService::verifyRequest()`。**不在本地驗簽**。若同時有 cookie + token 合法，會把 service key 塞進 `authorization` header（cookie 瀏覽器流用）。
- **`EntryService::verifyRequest($request)`**（`app/Services/v2/EntryService.php`，回 void、throw 例外）：`Jwt::parser($authKey)` → `verifyToken()`（簽章，失敗 `ENTRY_TOKEN_IS_INVALID`）→ `isTokenExpired()`（`ENTRY_TOKEN_IS_EXPIRED`）→ 取 claims `subAuthOid`/`platformOid`/`deputyOid`/`authKey`；`subAuthOid` 為 null 或 `platformOid==TOKEN` 視為非法 → `subAuthUserRepo->findByOidWithCache`（`USER_NOT_FOUND`）→ 檢查 `user_status`（停用等擋掉）→ 續做 per-uri 授權。
- **`verifyRequestByTarget`** 有 **BE2 專屬分支**：`EnumPlatform::BE2()` 用 `userUuid` 找 subAuthUser（其他平台用 authKey）。be2 MCP 若要直接呼叫 verify，注意 be2 是以 `userUuid` 定位使用者。

## Part 6 — Phase 0 追加原始碼查證（auth-service, 2026-08-08）

- **cookie 耦合其實不成立（好消息）** — `AuthenticateCorsWithCookie::handle` 只在「origin 在 `cors.allowed_origins` 且帶 `allowCors` cookie」時**自動塞 service key 進 authorization header**，否則直接 `next()`、**不擋**。真正的 gate 是同 route 的 `serviceAuth`。→ **be2-mcp headless S2S 自己帶 service key 就能打 `login-authorization-code` 與 `refresh-token`，cookie 非必需。** 主 spec §12(c) 往好方向解掉。
- **refresh 端點 = rotate + 回 fresh businessList（`TokenService::updateRefreshToken`）**：驗舊 refresh 在 Redis → 檢查 `user_status`（LOCKED/非 ENABLED 擋）→ **重新查 groups + businessList** → 產新 access + 新 refresh → 新舊 refresh key 不同時 `del` 舊的（**rotation 確認**）。**回傳 `{accessToken, refreshToken, businessList}`**。
  - 影響一：refresh **會回新鮮 businessList** → be2-mcp L2 refresh 後直接拿新 businessList 重封裝，**不需**把 businessList 也塞進 OAuth refresh token（主 spec §3 round-3 那條可簡化）。
  - 影響二：權限變更（含**加權**）在下次 refresh（~50min）就反映 → 主 spec §3/§12「加權需重登」**過度悲觀、需修正**。
  - 影響三：refresh 自身檢查 user_status → 撤銷/鎖定在 refresh 這關也 fail-closed（不只 `/verify`）。
- **userType↔platform 雙向 map**：`EnumPlatform::getKeyByUserType()` / `EnumPlatform::toUserType(EnumPlatform::byValue(platformOid))`（`UserTypeValidation` rule 用前者驗）。be2 為 `EnumPlatform::BE2`；登入 path `auth/{userType}/login` 的 userType 字串待從 `EnumPlatform` 定義確認。

### 對 be2 MCP 的直接結論
1. OAuth 外殼的「換 token」步驟直接對映 auth-service 原生兩步 flow，不用發明新協定。
2. token 驗證統一走 verify（gateway 幫你做，或你帶 service key 自己打）——**不要在 MCP 端自己驗 JWT 簽章**，簽章 key 在 auth-service 手上。
3. 授權資料兩個來源：換碼 response 的 `businessList`（MCP 層 fail-fast 過濾用）、JWT claims 的 `groupOids`（群組）。兩者都不是你產生的，照用。
