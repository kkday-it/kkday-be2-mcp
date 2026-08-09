# be2 MCP Phase 2b 設計 — SSO 確認頁 web app(取代 capability-URL 批准)

日期:2026-08-09
狀態:草稿(待使用者審閱 → agy-peer-review)
上位 spec:`docs/superpowers/specs/2026-08-07-be2-mcp-design.md`(§2 架構、§3 身份、§7 稽核);前一切片:`docs/superpowers/specs/2026-08-09-be2-mcp-phase2a-design.md`(§0/§11 把本切片延後到此)。
前置:Phase 2a 已實作 + 審查(feat/phase1a);change-set store / 狀態機 / diff / executor / confirm routes 已在,本切片**只換確認頁的「認證面」**並強化 UI。

## 0. 切片決策(本次已定)

- **定位**:純做 Phase 2b(SSO 確認頁),**寫入阻點(403 + modify_user userUuid resolver)平行處理、不納入 2b 交付**(使用者定案)。2b 不解 403、不承諾 modify_user resolver(但見 §7:SSO 登入流是它未來的自然歸屬)。
- **部署/session 模型**:**loopback 本機**(pilot 自跑 server + 瀏覽器),把 Phase 2a 的 capability-token 批准換成 **be2-auth SSO web session(httpOnly cookie)**;登入走 **A8 實證的 POPUP flow**。無需內網 ingress,延續 Phase 1a/2a 本機模型。
- **核心價值**:**關閉 Phase 2a 的 self-approval 洞**。2a 把一次性 token 帶外印到 server 終端已降低風險,但真正的信任邊界是:**批准需要一個 be2-auth SSO web session,agent(Claude/Code)沒有、也拿不到該 session cookie,故 agent 無法批准自己建的 change-set**。人工登入 = 不可被 agent 冒充的閘門。

## 1. 範圍與非目標

**目標**:確認頁成為一個有自己 be2-auth 登入的瀏覽器 web app。員工開確認頁 → 若無有效 session 則 be2-auth 登入(cookie 有效則靜默)→ 看 change-set diff → 批准 → server 用**該 session 的** be2 token 執行寫入。**批准者身份 = 登入的 be2 使用者**,必須等於 change-set 的 creator(§4 IDOR)。

**非目標**:
- 不解 403 寫入權限、不承諾 modify_user userUuid resolver(平行處理)。
- 不改 change-set 機制核心(store / 狀態機 / CAS 批准 / stale guard / executor / read-merge-write 全部沿用 2a)。
- 不上公網、不做多租戶(loopback 本機;內網多人服務是後續)。
- L2 tool 面(be2_create_changeset / status)不變。

## 2. 架構(疊加於 Phase 2a)

```
員工瀏覽器 ─開啟─> 確認頁 web app(be2-mcp 內,loopback)
  │  GET /confirm/:id
  │    └─無有效 session → 導去登入頁 /confirm/login?next=/confirm/:id
  │         └─ POPUP: window.open(auth-220/auth/be2/login?loginFlow=POPUP&redirectPath=<callback>)
  │              be2-auth 登入(cookie 有效則靜默;否則帳密+2FA 一次)
  │              → postMessage(UPDATE_AUTH_TOKEN / authorizationCode) 回 opener
  │         └─ 前端把 code POST 到 /confirm/session (server 端)
  │              server: exchangeCode(code, service key) → { be2 access/refresh, businessList }
  │                      建 web session(session_id)→ 存 be2 token 進「同一套 server 端 token store」
  │                      Set-Cookie: be2mcp_sid=<session_id>; HttpOnly; SameSite=Lax
  │  GET /confirm/:id(帶 cookie)→ 驗 session → live diff → 頁面
  │  POST /confirm/:id/approve(帶 cookie)→ 驗 session + session.user==creator
  │       → CAS pending→approved → executeChangeSet(用 session 的 be2 token)
  │  POST /confirm/:id/reject
  v
(change-set store / executor / audit：沿用 Phase 2a,不改)
```

- **確認頁 web app** = be2-mcp server 內的一組 route(`/confirm/*` + `/confirm/login` + `/confirm/session`),**非 MCP tool**(維持 draft-only:agent 面沒有任何可批准/執行的 tool)。
- **與 tool-call 面共用同一套 server 端 token store**(parent spec §3):web session 的 be2 token 存同一 store,續期同樣走 `TokenManager`(L2 refresh)。
- **執行**:批准當下用**該 web session 的**新鮮 be2 access token 執行寫入(不再用 change-set 建立者的 stored bearerHash;見 §4 身份對齊)。

## 3. be2-auth 登入流(A8 實證)

- **POPUP flow(主路徑,A8 SIT 實證)**:確認頁登入頁 `window.open(https://auth-220.sit.kkday.com/auth/be2/login?loginFlow=POPUP&redirectPath=<confirm-app callback>)`;be2-auth 登入成功後 `postMessage`(`UPDATE_AUTH_TOKEN` / authorizationCode)給 opener;確認頁前端把 code POST 到 server 的 `/confirm/session`;server 帶 **service key** 呼叫 `GET /api/v1/login-authorization-code/{code}` 換 `{accessToken, refreshToken, businessList}`(headless S2S,cookie 非必需,Phase 0 A4)。
- **be2-auth cookie → 靜默**:員工瀏覽器若已有有效 be2-auth cookie(已登入 be2-web),POPUP 秒回、免帳密+2FA(SSO-like,parent spec §2)。
- **REDIRECT flow(fallback)**:若 POPUP 在目標環境不可用,退回 `loginFlow=REDIRECT` + `redirectPath` 導回 `/confirm/session`。Phase 0 B2 小確認:REDIRECT 的 `redirectPath` 跨網域是否被 `validateOrigin`/allowlist 擋(POPUP 已證可用,列為次要)。
- **postMessage origin 檢查**:opener 收 postMessage 必須驗 `event.origin === auth-220 host`,防惡意頁面偽造 token 回填(安全硬性要求)。

## 4. 身份、授權、與 2a 的差異

- **確認頁認證從 capability-token 換成 web session cookie**:`/confirm/*` 不再吃 `?token=`;改驗 `be2mcp_sid` cookie → 查 web session → 取該 session 的 be2 token。這是 2b 的**唯一認證面改動**。
- **IDOR / 批准者對齊**:`/confirm/:id` 與 approve/reject 只服務 **session 的 be2 使用者 label == change-set `creator_label`** 的 change-set(不符 → 404,不洩存在)。即「只有建立者本人登入才能看/批自己的 change-set」,與 2a 的 capability-token-綁-creator 等價,但改由 SSO 身份強制。
- **執行用 session token(不用 stored creatorBearerHash)**:2a executor 用 change-set 存的 `creatorBearerHash` 撈 token;2b 批准是人工登入的 session,直接用 **session 的新鮮 be2 token** 執行 —— 更貼近「批准當下的人就是執行身份」。executor 介面已把 token 解析抽象成注入(`getFreshByHash` / 傳入 token),2b 傳 session token 即可,executor 邏輯不改。
- **draft-only 維持**:agent 面仍無批准/執行 tool;批准只在需要 be2-auth session 的瀏覽器頁,agent 無 session → 無法批准(**這就是關閉 2a self-approval 洞的機制**)。
- **授權仍委派 gateway**:寫入經 gateway 代打 `/verify`(403 fail-closed)不變。businessList 過濾照 2a。

## 5. Session 模型與資料

- **`web_sessions` 表**(SQLite,同 db):`session_id`(PK,高熵)、`user_label`、be2 token 參考(存同一套 token store;可用既有 `user_tokens` 以 `bearer_hash = sha256(session_id)` 復用,或新欄位——實作時二選一,介面隔離)、`created_at`、`last_seen_at`、TTL(如 8h 閒置過期)。
- **cookie**:`be2mcp_sid`,`HttpOnly; SameSite=Lax; Path=/confirm`(loopback 無 HTTPS,production 內網再加 `Secure`)。
- **續期**:session 的 be2 token 近到期時,由 `TokenManager` L2 refresh(與 tool-call 面同機制、同 single-flight);web session 本身閒置 TTL 到期需重登(be2-auth cookie 有效則靜默)。
- **登出/撤銷**:`POST /confirm/logout` 清 session;離職/降權由 refresh/`/verify` 的 user_status 於下次動作 fail-closed。

## 6. UI(功能面,YAGNI)

2b 交付一個**可用的**確認頁(server-rendered,無外部資產,延續 2a 的 esc/Referrer-Policy):登入頁、diff 頁(名稱[untrusted 標示]+ 現況→目標 + no_op/stale)、批准/拒絕、結果頁(per-item before/after + trace)。
- **沿用 2a**:live-diff 重算 + stale 409 guard、CAS 批准(執行恰好一次)、結果儀表板。
- **延後(非 2b 必要)**:trellis-poc Batch Wizard 的動態計數、prod 字串解鎖(高風險二次確認)、下載結果 —— 列為 2b 內選配或 2c;首交付以「SSO 認證面 + 功能可用頁」為準(關閉 self-approval 洞是 2b 的核心價值,UI 華麗度非)。

## 7. modify_user / 403 —— 平行,不納入 2b 交付(但標註自然歸屬)

- 依使用者定案,**2b 不承諾**解 modify_user userUuid 來源或 403 寫入權限。
- **標註**:2b 的 SSO 登入流(exchange → be2 token;be2-web 的 `token/sub-user` 回使用者上下文)是 userUuid resolver 未來最自然的歸屬 —— 當「有 shelf-write 權限的 SIT 帳號」到位、要打通 Phase 2a live e2e 時,在 2b 的 `/confirm/session` exchange 後順手解 userUuid 存進 session,取代 Phase 2a 的 `modifyUserFromPlaceholder`。此為 2b 完成後的**銜接點**,非本切片交付。

## 8. 依賴與風險

- **Phase 0 B2(be2-auth redirect/callback)**:POPUP flow A8 已 SIT 實證;剩 REDIRECT 跨網域 `redirectPath` allowlist 小確認(POPUP 為主則不阻擋)。**唯一需對 be2-auth team 的小確認**,非要對方開發。
- **postMessage origin 偽造**:§3 已列硬性 origin 檢查。
- **403 寫入權限**:與 2a 相同、平行;2b 不解 → 2b 的 live e2e 同樣止於「登入 + 建 session + 開 diff + 批准 → 執行 403 fail-closed」,真實 toggle 仍待寫入帳號(誠實標註,復用 2a runbook 的 PENDING 段模式)。
- **loopback + POPUP**:確認頁在 127.0.0.1,be2-auth POPUP 從瀏覽器開(be2-auth 是公司網可達),postMessage 回 loopback opener —— A8 模型可行;若 be2-auth 對 `redirectPath=127.0.0.1` 有 allowlist 限制,列 Phase 0 小確認(POPUP 的 redirectPath 檢查,§3)。

## 9. 測試與評估

- 單元/整合(vitest, TDD):session 建立/查詢/TTL 過期、cookie 驗證、`/confirm/session` exchange(mock be2-auth)、confirm 頁 session-auth(無 session→導登入、他人 session→404)、approve 需 session.user==creator、CAS 執行恰好一次(沿用 2a race 測)、postMessage origin 檢查(前端邏輯以整合測試涵蓋)。
- **安全測試**:agent 無 session cookie → approve 得 401/導登入(**證明 self-approval 洞已關**);偽造 origin 的 postMessage 被拒;capability-token 路徑已移除(不得殘留可繞過的舊批准面)。
- 上線前 `verify` skill 走真實 SIT:登入(POPUP,cookie 靜默)→ 建 session → 開 diff → 批准 → 執行(有寫入帳號則 toggle+revert;否則 403 fail-closed 驗證)。

## 10. 交付與退出條件

交付:確認頁 SSO 登入(POPUP)+ web session(cookie,同 store,server 續期)+ confirm 頁改 session-auth(移除 capability-token 批准面)+ IDOR 對齊(session.user==creator)+ 執行用 session token + 安全測試(agent 無法批准)。
退出條件(同 spec §11):該階段 eval/測試全綠 + code-review/agy 交叉審通過 + SIT 實測(verify skill;真實寫入待寫入帳號,其餘全綠)。

## 11. 與後續銜接

- 2b 完成 = Phase 2 的「一般員工可用」認證面就緒(parent spec §11 的 1b/2 對一般員工 GA 前提之一)。
- 內網多人服務(非 loopback)、完整 Batch Wizard UI、modify_user resolver + 寫入帳號打通 live e2e,為 2b 之後的獨立工作項。
