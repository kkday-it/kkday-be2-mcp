# be2-mcp 登出/撤銷(logout / revoke)設計 — 2026-08-21

> TODO-consolidated A2。範圍拍板(2026-08-21):RFC 7009 `/oauth/revoke` + discovery 宣告 + 確認頁「斷開所有 Claude 連線」全做。方案 1(grant 級撤銷 + 獨立連線管理頁)獲採。

## 1. 背景與問題

be2-mcp 的 OAuth 連線目前**沒有任何使用者主動撤銷手段**:

- Claude client 拿到的 OAuth access/refresh token 只會因 30 天 refresh 過期、refresh-reuse 偵測、或 `onReauthRequired`(be2 refresh 死亡)而失效。
- 人若想「斷開 Claude 對 be2 的存取」,唯一辦法是等過期。`/confirm/logout` 只清確認頁的 web session cookie,與 OAuth 連線無關。
- Discovery 未宣告 `revocation_endpoint`,OAuth-aware client 無從得知撤銷入口。

## 2. 現況事實(設計依據)

1. **一條 OAuth 連線 = 一個獨立 `identityId`**:每次 authorize 的 `exchangeCodeToIdentity` 都鑄新 `randomUUID` identity(`ssoRoutes.ts`)。同一個 be2 帳號(`userLabel` = JWT `authKey`)多次連線會有多個 identity 並存。
2. **憑證三種 kind**:`oauth_access`(Claude MCP bearer)、`web_session`(確認頁 cookie)、`static_bearer`(headless fallback)。同一 identity 可同時掛多種(OAuth authorize 會順手鑄同 identity 的 SSO-seamless `web_session` cookie)。
3. **family revoke 已有先例**:`tokenRoutes.ts` refresh-reuse 偵測 = `oauthStore.deleteRefreshByIdentity(id)` + `credentials.deleteByIdentityAndKind(id, 'oauth_access')`,**刻意保留 `web_session`**。
4. **ghost identity cascade 已有先例**:`app.ts` 的 `purgeCredential`(區域函式):刪 credential 後若 `countByIdentity === 0` 則刪 identity(identity 列存真實 be2 access/refresh token,無人引用即為憑證洩漏風險孤兒,`oauth-purge` 亦會掃)。
5. **路由順序**:`ssoRoutes`(`/confirm/login`、`/confirm/session`、`/confirm/logout`)先掛,`confirmRoutes`(`GET /confirm/:id`)後掛;`/confirm/login` 的 `next` allowlist 正則 `^\/confirm\/[A-Za-z0-9_-]+$` 已可容納 `/confirm/connections`。
6. **確認頁登入 gate 先例**:`confirmRoutes.requireSession` = `be2mcp_sid` cookie → `webSessions.get` → credential kind 必須是 `web_session`。

## 3. 設計總覽

三個交付物,共用一個新的 grant 撤銷 helper:

```
POST /oauth/revoke ──┐
                     ├──> revokeGrant(identityId)   [src/oauth/revocation.ts]
/confirm/connections ┘         = deleteRefreshByIdentity
  「斷開所有 Claude 連線」        + deleteByIdentityAndKind('oauth_access')
                                + identity 無 credential 引用時刪 identity
discovery += revocation_endpoint
```

**撤銷語義 = grant 級**:因為 identity 天然就是「一次 authorization grant」,對 identity 做 kind-scoped 全刪正好等於 RFC 7009 的「same authorization grant」建議語義,且與既有 reuse-detection 形狀一致(保留 `web_session`——撤 Claude 連線不踢確認頁登入)。

## 4. `POST /oauth/revoke`(RFC 7009)

新檔 `src/oauth/revokeRoutes.ts`,掛在 `app.ts` 的 token router 旁(公開端點,無 bearer middleware;public client 以持有 token 本身為授權)。

### 4.1 請求

- 只收 POST;`application/x-www-form-urlencoded` 與 JSON 都解析(與 `tokenRoutes` 同做法)。
- 參數:`token`(必填)、`token_type_hint`(選填,`access_token`|`refresh_token`)、`client_id`(選填,public client)。

### 4.2 token 解析

- `hash = CredentialStore.hash(token)`,依 hint 排序做兩種查找;hint 缺席或查無,**必須**擴大到另一種(RFC 7009 §2.1):
  - **refresh**:`oauthStore.getRefresh(hash)`。`consumed === 1` 的列照樣命中——撤銷一顆已 rotate 掉的舊 refresh,結局同 reuse-detection(family revoke),同一條路。`exp` 過期列亦照樣命中做撤銷(冪等、無害)。
  - **access**:`credentials.get(hash)` 且 **kind 必須是 `oauth_access`**。`static_bearer` / `web_session` 的 secret 被呈上來一律視為 unknown(no-op 200)——公開端點不得撤銷非 OAuth 面向的憑證。
- 查無 → **200 空 body**(不當 token 存在性 oracle,RFC 7009 §2.2)。

### 4.3 client 歸屬檢查

- `client_id` 有提供才檢查(鏡射 `tokenRoutes` refresh grant 的寬鬆行為;public client 的真正授權是持有 token)。
- refresh 列自帶 `clientId` 直接比;access 憑證不存 clientId,經 `oauth_refresh.access_cred_hash` 反查取得(新 store 方法 `getRefreshByAccessCredHash`);反查不到(edge:family 已亡)則無從比對,**跳過檢查、照撤**(possession 足矣)。
- 比對不符 → 視為 unknown token,**no-op 200**(不洩漏)。

### 4.4 撤銷動作

命中即 `revokeGrant(identityId)`(§3 helper):

1. `oauthStore.deleteRefreshByIdentity(identityId)` — 整條 refresh family(含 consumed 歷史列)。
2. `credentials.deleteByIdentityAndKind(identityId, 'oauth_access')` — 該 grant 的所有 access bearer。
3. 若 `credentials.countByIdentity(identityId) === 0` → `identities.delete(identityId)`(ghost 清理;若同 identity 還有 `web_session`,identity 與其 be2 token 保留——確認頁 session 仍需要它)。

回應一律 **200 空 body**(成功、no-op、重複撤銷皆同)。`token` 缺席 → 400 `invalid_request`。

### 4.5 稽核

命中撤銷時 `audit.record`:`tool: 'oauth_revoke'`、`userLabel` = 被撤 identity 的 userLabel、params 記 token kind 與 client_id(絕不記 token 明文;`AuditLog` 既有 JWT redact 不夠——這裡從源頭就只傳 kind/hash 前 8 碼)。no-op 不記(避免公開端點被灌垃圾 audit)。

## 5. Discovery 宣告

`discoveryRoutes.ts` 的 authorization-server metadata 加:

```json
"revocation_endpoint": "<baseUrl>/oauth/revoke",
"revocation_endpoint_auth_methods_supported": ["none"]
```

## 6. `/confirm/connections` 連線管理頁

掛在 `ssoRoutes.ts`(先於 `confirmRoutes` 的 `/confirm/:id`,不會被吞)。

### 6.1 GET

- 登入 gate 同確認頁(`be2mcp_sid` → `web_session` kind);未登入 → redirect `/confirm/login?next=/confirm/connections`(既有 `NEXT_RE` 已放行)。
- 以目前 session identity 的 `userLabel` 列出**同一個 be2 帳號**名下所有「Claude 連線」:有至少一顆 `oauth_access` credential 或至少一列 `oauth_refresh` 的 identity。顯示每條連線的 `updatedAt` 與總數。
- 一顆按鈕:「斷開所有 Claude 連線」→ `POST /confirm/connections/revoke-all`。**不做逐條斷開**(YAGNI;TODO 要求即為「斷開所有」)。

### 6.2 POST `/confirm/connections/revoke-all`

- 同一登入 gate。CSRF:`be2mcp_sid` 是 `SameSite=Lax`,跨站 POST 不帶 cookie,天然擋掉;不另做 CSRF token。
- 以 `userLabel` 找出所有 identity(新 store 方法 `IdentityStore.listByUserLabel`,比對沿用 `confirmRoutes.sameUser` 的 trim+lowercase 正規化),逐一 `revokeGrant`。
- **現任 web session 不動**:按完頁面仍登入著,重新渲染顯示「已斷開 N 條連線」。當前 identity 的 oauth credential 一樣被撤(它就是使用者要斷的東西之一)。
- `static_bearer` **不在撤銷範圍**(v1 決策):它是 ops 經 `bootstrap-user` 手動核發的 headless fallback,生命週期由 ops 管;頁面文案註明「headless static bearer 不受此操作影響」。
- 稽核:每條被撤連線記一筆 `tool: 'confirm_connections_revoke_all'`。

### 6.3 UI

沿用 `ssoRoutes` 既有 server-rendered 極簡 HTML 風格(inline `<script>` 用既有 `js()` escape;文字內容用既有 esc 慣例)。不動面板/wizard 資產。

## 7. Store 層新增(全部是薄查詢,不碰 core)

| 位置 | 新方法 | 用途 |
|---|---|---|
| `OAuthStore` | `getRefreshByAccessCredHash(hash)` | §4.3 access→clientId 反查 |
| `OAuthStore` | `countRefreshByIdentity(identityId)`(或 list) | §6.1 判定「這 identity 是條 Claude 連線」 |
| `CredentialStore` | `countByIdentityAndKind(identityId, kind)` | §6.1 同上(`oauth_access` 那一半的判定) |
| `IdentityStore` | `listByUserLabel(userLabel)`(SQL `lower(trim(user_label))` 比對) | §6.2 橫跨 identity 撤銷 |
| `src/oauth/revocation.ts` | `revokeGrant(deps, identityId)` | §4.4 共用 helper;`app.ts` 的 `purgeCredential` 維持原樣不動(它是 credential 級 cascade,語義不同) |

## 8. 邊界(寫給使用者與 reviewer 的明話)

1. **be2-mcp 撤銷 ≠ be2-web SSO 登出**:撤銷只是把 be2 token 從 be2-mcp 的 store 刪掉;auth-service 端的 JWT 在其 TTL(~50min)內仍有效,be2-web 的登入不受影響。auth-service 沒有已確認的 server 端單 token 撤銷 API,不在本案範圍。
2. **Claude client 端殘留**:Claude Code/Desktop 快取的 DCR client 與 token 檔不會因 server 端撤銷而消失;下次 tool call 會撞 401 → client 依 `WWW-Authenticate` 重走 OAuth(需重新登入 be2)。這是預期行為,runbook 記一筆即可。
3. **`static_bearer` 不受影響**(§6.2 決策)。
4. **revoke 端點是公開端點**:no-op 一律 200、不記 audit、純 hash 查找,無 oracle、無放大面;不掛 rate budget(與 token endpoint 同姿態)。

## 9. 測試計畫(TDD,新檔 `tests/oauthRevoke.test.ts` + `tests/confirmConnections.test.ts`)

**revoke 端點**:
1. refresh token 撤銷 → 整 family 消失(含 consumed 列)、`oauth_access` credentials 消失、`web_session` 存活、ghost identity 被清/有 web_session 則保留。
2. access token 撤銷 → 同 grant 級效果(經 accessCredHash 反查)。
3. unknown token / `static_bearer` secret / `web_session` secret / 空字串以外的垃圾 → 200 no-op,store 無變化。
4. `token` 缺席 → 400 `invalid_request`。
5. `token_type_hint` 給錯(refresh 標成 access_token)→ 仍找到並撤銷。
6. `client_id` 不符 → 200 no-op 且 store 無變化;`client_id` 缺席 → 照撤。
7. 重複撤銷同一顆 → 兩次都 200(冪等)。
8. 撤銷後原 access bearer 打 `/mcp` → 401;原 refresh 打 `/oauth/token` → `invalid_grant`。
9. audit:命中記一筆、no-op 不記、params 無 token 明文。

**discovery**:metadata 含 `revocation_endpoint` 兩欄位。

**connections 頁**:
10. 未登入 GET → redirect login(next 正確)。
11. 登入後 GET → 列出同 userLabel 全部連線(含另一 identity 的),不含別人的。
12. POST revoke-all → 同 userLabel 所有 identity 的 oauth 憑證/refresh 全消失、目前 web_session 仍有效(再 GET 一次 200)、別的 userLabel 不受影響、`static_bearer` 存活。
13. userLabel 大小寫/空白差異(sameUser 正規化)仍匹配。
14. 稽核逐連線記錄。

**回歸**:`npm run ci` 全綠;既有 reuse-detection、logout、oauth-purge 測試不動仍綠。

## 10. 非目標

- 逐條連線斷開 UI、連線命名/裝置指紋。
- auth-service 端 token 撤銷、be2-web SSO 登出聯動。
- DCR ghost client 清理(仍歸 `oauth-purge` 未來項)。
- `static_bearer` 生命週期管理。
