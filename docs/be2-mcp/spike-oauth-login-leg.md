# Spike T-oauth-login-leg — authorize 的 be2-auth 登入腿走 REDIRECT 或 POPUP

日期：2026-08-13　狀態：**定論 = POPUP（已驗證，免 live spike）**

## 問題

OAuth `/oauth/authorize` endpoint 需要驅動 be2-auth 帳密+2FA 登入，才能換 be2 token、鑄 authz code。兩種驅動法：
- **REDIRECT flow**：`GET auth/be2/login?loginFlow=REDIRECT&redirectPath=<be2-mcp callback>`，登入後 be2-auth 把 token POST 回 `redirectPath`。體驗最像標準 OAuth（純瀏覽器導轉），但**跨網域 `redirectPath` 是否被 be2-auth `validateRedirectPath` 接受未實證**（Phase 0 B2 殘留）。
- **POPUP flow**：`auth-220/auth/be2/login?loginFlow=POPUP` + postMessage（origin 驗證），已在 `ssoRoutes.ts` 用於確認頁 SSO。

## 決策：POPUP

**理由**：
1. **POPUP 已 SIT be2-220 實測跑通**（phase0-inventory A8）——be2-web 自己就是用這條，`ssoRoutes.ts` 的確認頁 SSO 也是。零未知。
2. REDIRECT 的跨網域 `redirectPath` allowlist 行為未實證；賭它可行會引入一個 live 阻擋點。
3. authorize 腿用 POPUP，可**直接復用 `ssoRoutes.ts` 的 `exchangeCodeToIdentity` helper + postMessage + origin 檢查**（Task 4 已抽出），實作面最省、與確認頁同一套經驗證的機制。
4. 使用者離線期間以此保守選項推進，不阻塞 subagent-driven 迴圈。

**取捨**：OAuth authorize 用彈窗而非純 redirect，體驗略不像教科書 OAuth，但功能等價、對 Claude Code/Desktop 的 OAuth 客戶端無影響（它只在意拿到 authz code 回 redirect_uri）。

## 對 Task 9 的指示

authorize endpoint：驗參數（client_id/redirect_uri allowlist/PKCE challenge/state）→ 渲一個過場頁，用 POPUP 開 be2-auth 登入 → postMessage（驗 origin）收 be2 code → `exchangeCodeToIdentity` 建 identity + 設 be2mcp_sid cookie（SSO-seamless）+ 鑄一次性 authz code → 導回 `redirect_uri?code=&state=`。

## 未做（未來優化）

REDIRECT flow 的跨網域 `redirectPath` 若日後想驗（換取純 redirect 體驗），再開一個獨立 live spike。非本波阻擋項。phase0-inventory.md B2 維持「POPUP 已證、REDIRECT 未證」。
