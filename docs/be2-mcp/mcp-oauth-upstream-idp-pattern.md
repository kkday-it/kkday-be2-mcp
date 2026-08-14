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

**實測結論（2026-08-14,playwright 逐一驗證）**：be2-auth 的 guard 是**固定 host 白名單**（只認 be2-web/be2-220 等已註冊 origin,非 `.kkday.com` 後綴檢查）。127.0.0.1、假 kkday 主機名(http)、假 kkday 主機名(https+信任憑證) 全 404;唯 be2-web 渲染。搭 be2-web 便車攔 code 也死路（code 一次性、be2-web 先消耗）。→ **唯一通路 = 把 be2-mcp 部署 origin 加進 be2-auth 白名單**（be2-auth team 動作,外部依賴）。be2-mcp 的 OAuth code 完整、283 tests 綠,契約已 live 修正（`{event:'UPDATE_AUTH_TOKEN',data:{authorizationCode,device}}`,commit 705850c）。

## 真實 postMessage 契約（live 攔到,供部署後對照）

```js
// be2-auth popup → opener，序列（origin: https://auth-220.sit.kkday.com）
{ event: 'AUTH_LOGIN_READY' }                                  // 握手（opener 不需回應）
{ event: 'UPDATE_AUTH_TOKEN', data: { authorizationCode, device } }  // code 在 data.data.authorizationCode
```
opener 用 `authorizationCode` back-channel 打 auth-service `GET /api/v1/login-authorization-code/{code}`（帶 service key）換 `{accessToken, refreshToken, businessList}`。**code 一次性**。
