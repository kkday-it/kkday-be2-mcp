# MCP 認證 = 委派上游 IdP 登入取 token — 模式與查資料關鍵字

日期：2026-08-14
> 給「想上網查這個模式的 prior art」用。be2-mcp 的 OAuth 外殼就是這個模式的實作；live 卡點見文末。

## 一句話描述（可直接摘要）

Claude（MCP client）對 MCP server 跑 **OAuth 2.1 Authorization Code + PKCE**；MCP server 的 authorize 端點**把使用者登入委派（delegate/federate）給上游身分提供者（be2-auth）**——開瀏覽器讓使用者在 be2 官方頁登入、透過 authorization code 換到上游 token，MCP server 再發**自己的不透明 token** 給 Claude。**帳密只進 be2 官方登入頁,不經 Claude、不經 be2-mcp 以外任何中介。**

正式版摘要（貼筆記用）：
> MCP server 作為 OAuth 2.1 Authorization Server,以 authorization-code + PKCE 對 client 認證,並將使用者登入 federate/delegate 給上游 IdP(be2-auth);透過 popup + postMessage 取得上游 authorization code、back-channel 換 token 後,發放自有不透明 token。

## 角色對照

| 口語 | 正式名稱 |
|---|---|
| Claude 連 MCP 要登入 | **MCP Authorization**（MCP 規範一節,底層是 OAuth 2.1） |
| 「開 be2 網頁 login」 | MCP server **委派上游登入**;be2-auth = **upstream Authorization Server / IdP** |
| 「從中取得 token」 | 上游回 **authorization code** → server 端 **exchange code for token**（back-channel）→ 對 client 發**自有** access/refresh token |
| be2-mcp 對 Claude 的角色 | 同時是 **Authorization Server**（發 token）+ **Resource Server**（`/mcp` 收 token） |

## 英文搜尋關鍵字

**MCP 認證本身**
- `MCP authorization specification` / `Model Context Protocol OAuth`
- `MCP server as OAuth authorization server`
- `MCP OAuth 2.1 PKCE dynamic client registration`
- `MCP protected resource metadata`（RFC 9728）、`OAuth authorization server metadata`（RFC 8414）、`Dynamic Client Registration`（RFC 7591）

**委派給上游登入 / 拿 token（重點）**
- `OAuth authorization server delegating to upstream identity provider`
- `OAuth broker` / `brokered authentication` / `identity federation`
- `OAuth token exchange`（RFC 8693）
- `federated login authorization code exchange`
- `upstream IdP login popup postMessage OAuth`

**開網頁登入彈窗取 code 的 UI 機制**
- `OAuth popup window postMessage flow`
- `login popup window.opener postMessage authorization code`

## 這次的 live 卡點對應的詞

be2-auth 登入頁（`loginFlow=POPUP`）只讓**白名單網站**開它的彈窗,不在名單的 opener 一律 client-route 到 `/404`。查資料時對應：
- `OAuth popup opener origin allowlist`
- `registered client origin` / `redirect_uri allowlist`
- 「上游 IdP 要求 opener/referrer 在允許清單」是常見設計。

**實測結論（2026-08-14,playwright 逐一驗證;2026-08-14 稍後讀 kkday-auth-service 原始碼後修正）**：be2-auth 的 guard 有**兩層**（`LoginPage.vue` `validatePopupPageSource` + `AuthController.php` + `config/login.php`）：
1. **握手（當時 404 的另一半根因,我方 bug）**：popup 發 `AUTH_LOGIN_READY` 後,opener 必須 **500ms 內回 `postMessage({event:'CONFIRM_LOGIN_DOMAIN'})`**,guard 驗的就是這則回覆的 `event.origin`。當時我方過場頁沒回 → 不論 origin 為何一律 404。**已修**（authorizeRoutes.ts / ssoRoutes.ts,測試 tests/launcherHarness.ts 實跑 inline script 驗行為）。
2. **domain 白名單**：`config('login.be2.domain')` = `[env('BE2_DOMAIN')]`（單值 env、`includes()` 精確比對,非 `.kkday.com` 後綴檢查）。REDIRECT flow 驗 `document.referrer` 同一份名單,無 referrer 也 404（直開 URL 已實測 404）。
**SIT 已通、零外部依賴（2026-08-14 live 驗收）**：`isDevEnv = APP_ENV in [local,sit] ? env('ALLOW_LOCAL_LOGIN', false) : false`，isDevEnv=true 時 origin 檢查整個跳過（握手仍必回）——**auth-220 本來就開著 `ALLOW_LOCAL_LOGIN=true`**，先前 404 純粹是我方握手缺失。握手修好後完整 live e2e 通過：DCR → authorize → be2-auth POPUP 真帳密登入 → CONFIRM_LOGIN_DOMAIN 握手 → code → PKCE token exchange → OAuth Bearer 打 `/mcp` tools/list（5 工具）。另修一個 live 揪出的舊 db schema 問題（web_sessions 缺 identity_id → complete 500，openDb 已加重建 migration）。**prod 才有真外部依賴**：prod `isDevEnv` 硬編 false，需改 auth-service config 把 be2-mcp origin 納入 `login.be2.domain`（單值 env `BE2_DOMAIN`、`includes()` 精確比對；可自備 PR）。搭 be2-web 便車攔 code 是死路（code 一次性、be2-web 先消耗）。契約已 live 修正（`{event:'UPDATE_AUTH_TOKEN',data:{authorizationCode,device}}`,commit 705850c）。

## 真實 postMessage 契約（live 攔到,供部署後對照）

```js
// be2-auth popup → opener，序列（origin: https://auth-220.sit.kkday.com）
{ event: 'AUTH_LOGIN_READY' }                                  // 握手：opener 必須 500ms 內回下面這則,否則 popup 自路由 /404
// opener → popup（targetOrigin 鎖 be2-auth origin）
{ event: 'CONFIRM_LOGIN_DOMAIN' }
// be2-auth popup → opener（登入成功後）
{ event: 'UPDATE_AUTH_TOKEN', data: { authorizationCode, device } }  // code 在 data.data.authorizationCode
```
opener 用 `authorizationCode` back-channel 打 auth-service `GET /api/v1/login-authorization-code/{code}`（帶 service key）換 `{accessToken, refreshToken, businessList}`。**code 一次性**。
