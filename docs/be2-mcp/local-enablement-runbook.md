# be2-mcp 本機啟用 + 接 Claude Code / Desktop 驗收 runbook

> 目的:把「在本機把 be2-mcp 跑起來 + 用 Claude Code 或 Claude Desktop 接上 + 驗收」的實際操作記下來,可重複。
> 2026-08-27 於 `feat/cloud-ready-phaseA` 實測通過(含 live OAuth 到真實 SIT 資料)。
> 相關:`oauth-runbook.md`(OAuth 外殼細節)、`cloud-ready-phaseA-runbook.md`(部署 env 契約)、`phase4a-runbook.md`(面板)。

---

## 1. 啟動 server(本機)

一律先打 SIT `be2-220`(免 stage 依賴,`.env` 已有 `SIT_AUTHSVC_SERVICE_KEY`)。

```bash
# 開發模式(tsx 直跑)
BE2_ENV=sit-220 npm run dev
# → listening on http://127.0.0.1:8787/mcp (bind 127.0.0.1:8787, env: api-gateway-220.sit)

# 或:模擬 production 產物(容器就是這樣跑)
npm run build && BE2_ENV=sit-220 node dist/src/index.js
```

冒煙檢查(另開 terminal):
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz   # 200 (liveness)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/readyz    # 200 (readiness, 查 DB)
```

**停 server(graceful)**:對它送 SIGTERM(`lsof -ti tcp:8787 | xargs kill`);會在數秒內乾淨退出(停 scheduler → 排空連線 → flush OTel → 關 DB),硬逾時 25s。

---

## 2. 接 Claude Code(CLI,OAuth)

```bash
claude mcp add be2-mcp --transport http http://127.0.0.1:8787/mcp
```
- **不要帶 `--header`**(那是 static bearer 舊路;這裡走 OAuth)。
- `claude mcp add` **只寫設定、不當場登入**。OAuth 握手在**第一次連線/使用**才觸發:在互動 session 打 `/mcp` → 選 `be2-mcp` → **Authenticate**(或重開一個 `claude` session)→ 這時才開瀏覽器到 be2-auth。
- 瀏覽器彈窗 = be2 官方登入頁,用 SIT 測試帳號(`.env` 的 `AUTH_email`/`AUTH_pwd`,或你自己的 be2 帳號)登入;有 2FA 照輸。
- 成功後彈窗關、Claude Code 顯示 connected。驗收:叫工具,例如「用 be2-mcp 查商品 <prodOid>」→ 回真實 SIT 商品名/方案/庫存即通。

### ⚠️ 若 authorize 回 `invalid_request`(空白頁一行字)
成因:Claude Code 把 DCR 註冊的 `client_id` **綁 server URL 快取**;若你以前在**別的目錄**(如舊 `mcp_poc/`)跑過 be2-mcp,那份快取的 client 只存在舊目錄的 db,現在的目錄是**另一個空 db**,authorize 查不到該 client → `invalid_request`。**非程式 bug。**
**快解**:換一個 port 起 server,用新名字新 URL 加 → 逼它跑全新 DCR:
```bash
BE2_ENV=sit-220 BE2_MCP_PORT=8788 npm run dev
claude mcp add be2mcp-demo --transport http http://127.0.0.1:8788/mcp
```
(`claude mcp remove` 不一定清掉綁 URL 的 OAuth 快取,換 port 比 remove/re-add 保險。)

---

## 3. 接 Claude Desktop(看互動面板)

**為什麼要用 Desktop**:MCP Apps 的互動面板(`ui://be2/*.html`:批次精靈、change-set 檢視、商品面板、公告精靈)只在**有 UI 的 host**(Claude Desktop / claude.ai 網頁)渲染;Claude Code CLI 只跑得到文字工具,看不到面板。

**接法**(Claude Desktop → Settings → Connectors → Add custom connector):
1. 名稱隨意(如 `be2-mcp`),URL 填 **`http://127.0.0.1:8787/mcp`**(或你跑的 port,如 8788)。transport = HTTP(Streamable)。
2. 儲存後 Desktop 會走 OAuth:開瀏覽器到 be2-auth → SIT 帳號登入 → 回來即 connected。
   - Desktop 是**獨立的 client**(跟 Claude Code CLI 分開的 OAuth 快取)→ 第一次接是全新 DCR,**不會**踩到 §2 那個跨目錄快取坑。
3. **叫出面板**:對 Desktop 說「開 be2 批次精靈」或直接請它用工具 **`be2_open_batch_wizard`**(公告用 `be2_open_announcement_wizard`)→ 右側/對話內會出現四步驟精靈面板(選擇→檢視 diff→批准→結果)。
   - 面板前提:server 要有跑過 `npm run build`(或 `npm run build:ui`)產出 `dist/ui/*.html`;`npm run dev` 也會用到,缺檔會降級成純文字(功能仍在、只是沒面板)。
4. **寫入批准走面板 nonce 通道**:agent 只能提 change-set draft;真正執行要你在面板按批准(app-only 的 `app_confirm_changeset`,model 工具清單看不到它)。這是設計上的安全不變式。

> 版本差異:Desktop 各版 Connectors 選單字樣可能不同;關鍵是「custom connector + HTTP MCP URL」。若 Desktop 版本沒有 custom connector,退路是用 `claude_desktop_config.json`,但 HTTP+OAuth 走 Connectors UI 最直接。

---

## 4. Server 端驗證(不看瀏覽器也能確認登入成功)

查當前環境的 db(sit-220 → `./data/be2-mcp-sit-220.sqlite`):
```bash
DB=./data/be2-mcp-sit-220.sqlite
for t in oauth_clients oauth_auth_codes oauth_refresh be2_identities credentials audit_log; do
  printf '%-18s = %s\n' "$t" "$(sqlite3 "$DB" "SELECT count(*) FROM $t;")"
done
sqlite3 "$DB" "SELECT datetime(ts/1000,'unixepoch','localtime'), user_label, tool, status FROM audit_log ORDER BY ts DESC LIMIT 8;"
```
登入 + 用工具後應看到:`oauth_clients≥1`(DCR)、`oauth_auth_codes/refresh≥1`(換碼)、`be2_identities≥1`(be2 token 落地,user_label=JWT authKey)、`credentials` 有 `oauth_access`(+ SSO `web_session`)、`audit_log` 記工具呼叫且**無 token 明文**。

---

## 5. 收尾

```bash
lsof -ti tcp:8787 | xargs kill        # 停 server(換 port 的話改 8788)
claude mcp remove be2-mcp             # 移除 Claude Code 設定(demo 用完)
# Claude Desktop:Settings → Connectors → 移除該 connector
```
`oauth-purge`(每日 cron 語義)可硬刪過期 token + ghost client:`npm run oauth-purge`。

---

## 附:env 快查

| env | 用途 | 本機值 |
|---|---|---|
| `BE2_ENV` | 環境 preset | `sit-220` |
| `BE2_MCP_PORT` | listen port | 預設 8787;撞快取時換 8788 |
| `BE2_MCP_BIND_HOST` | 綁定位址 | 本機留空(=127.0.0.1);容器設 `0.0.0.0` |
| `BE2_MCP_PUBLIC_BASE_URL` | 對外 base(含 scheme) | 本機留空(fallback loopback);部署設 `https://<域名>` |
| `BE2_MCP_ALLOWED_HOSTS` | Host 白名單 | 本機留空;設了 public URL 就要一起設域名 |
| `BE2_MCP_DEV_PANEL` | dev 面板 | **務必不設** |
