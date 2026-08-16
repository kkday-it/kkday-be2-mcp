# be2 MCP — MCP Apps 接入 Runbook（面板）

> 對象：想在 **Claude Desktop**（MCP Apps host）用互動面板批准 change-set 的使用者/開發者。承接 `docs/be2-mcp/phase2b-runbook.md`（確認頁 SSO，非 Apps host 的退路）——本文件只講 MCP Apps 面板這條**額外**通道，兩者並存、不互斥。環境錨定 SIT `be2-220`。

## 這是什麼

Phase 2b 起，change-set 的批准有**兩條通道**：

1. **面板 nonce 通道（Apps host，本文件）**：`be2_create_changeset` / `be2_get_changeset_status` 回傳的結構化內容裡帶 `uiResourceUri`，MCP Apps host（目前只驗證過 Claude Desktop）會抓對應的 `ui://…` 資源渲染成一個互動 iframe 面板。面板逐筆勾選 + 按「確認執行」/「拒絕」，直接呼叫 app-only 工具 `app_confirm_changeset`——這個工具**不在 model 的工具清單裡**（spike T6 已證：host 會把 `visibility:['app']` 的工具從送給 model 的 `tools` 陣列濾除），nonce 只在另一個同樣 app-only 的 `app_get_changeset_view` 回傳裡發放，兩者合起來讓「被注入/幻覺的 model」結構上拿不到批准所需的憑證。細節見 `docs/superpowers/specs/`（MCP Apps 面板 spec）與 `docs/be2-mcp/spike-t6-findings.md`。
2. **be2-auth SSO 確認頁（退路）**：見 `docs/be2-mcp/phase2b-runbook.md`。**Claude Code（終端機 host）沒有 Apps 渲染能力，一律走這條**——agent 只會在文字裡回報 `changeset_id`，使用者自行到瀏覽器開 `http://127.0.0.1:8787/confirm/<changeset_id>` 批准。面板路徑失效（host 不支援、資源缺檔等）時，面板本身也保留一顆「前往核准（確認頁）」按鈕、以 `openLink` 開同一個確認頁，兩條通道殊途同歸。

**兩者都不允許 agent 自我批准**：確認頁要 `be2mcp_sid` session cookie，面板要 nonce——agent（model）兩者都拿不到。

## 前置需求（在 phase1a/phase2a/phase2b 之上，新增的部分）

- **`npm run build:ui` 必須先跑過一次**，才會有 `dist/ui/*.html`（面板的打包產物，esbuild 把 `src/ui/*.ts` inline 進對應 `src/ui/*.html` 模板）。`npm run dev` **不會**自動重建面板——改了 `src/ui/*.ts` 後要重新 `npm run build:ui` 再重啟/重連 server 才會生效。`npm run ci` 已內含這一步（見 `package.json` 的 `ci` script），CI 不會漏掉；但本機手動起 server 測面板時要記得手動跑。
- **Claude Desktop**（目前唯一驗證過會渲染面板的 host；spike T1/T6 皆針對它）。
- Desktop 走 **HTTP + mcp-remote stdio shim**——Desktop 官方文件化的 connector 路徑是本機 stdio server；be2-mcp 是 Streamable HTTP（`127.0.0.1:$BE2_MCP_PORT`），兩者接不上，中間需要一層 shim 把 stdio 轉打本機 HTTP（`mcp-ui-spike-checklist.md` 已驗證：直連 loopback HTTP 的自訂 connector無法渲染，shim 才行）。

## `claude_desktop_config.json` 範例

```json
{
  "mcpServers": {
    "be2-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8787/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization: Bearer ${BE2_MCP_BEARER}"
      ]
    }
  }
}
```

- `http://127.0.0.1:8787` 依你的 `BE2_MCP_PORT` 調整（預設 8787）。
- `--header "Authorization: Bearer <bearer>"`：`<bearer>` 就是 `npm run bootstrap-user` 印出的那顆一次性 static bearer（見 `phase1a-runbook.md` 「2. Enroll」），**跟 Claude Code 用的是同一顆**——be2-mcp 對 Desktop/Code 兩種 host 一視同仁，身分一律由這顆 bearer 推導，不因 host 而異。上例用 `${BE2_MCP_BEARER}` 環境變數占位，實務上請直接把明文 bearer 貼進這個 JSON 檔（`claude_desktop_config.json` 是你本機的設定檔，不會被 commit）——**切勿把這顆 bearer 貼進任何會進版控/聊天記錄/文件的地方**。
- `mcp-remote` 用 `npx -y` 拉，不需要另外全域安裝；版本見 `spike-t6-findings.md`（spike 當時測的是 `0.1.37`）。

改完設定檔後重啟 Claude Desktop 才會生效。

## 面板批准怎麼用

1. 跟 agent 說「幫我把商品 `<prodOid>` 下架」之類的請求（同 Phase 2a/2b），agent 呼叫 `be2_create_changeset`。
2. Desktop 偵測到回傳帶 `uiResourceUri`，自動抓 `ui://…` 資源、渲染成面板（一個 iframe），顯示目前 diff（現況 → 目標，逐 item）。
3. 面板每列預設**全部勾選**；如果要排除某個 item，取消該列勾選——但注意：目前後端是「全有或全無」語意，取消勾選 = 讓整批送出時因 `confirmed_keys` 與伺服器記錄的完整集合對不上而被拒（`CONFIRMED_KEYS_MISMATCH`），**不是**「只執行剩下勾選的」。要調整範圍請直接讓 agent 建一個範圍不同的新 change-set，不要靠面板取消勾選。
4. 按「確認執行」：
   - 一般 action_type：直接呼叫 `app_confirm_changeset`（帶 nonce + diff_version + confirmed_keys），伺服器端即時重算 diff、比對 staleness、CAS、執行、寫入稽核，通常在同一次呼叫內就拿到終態（`done`/`partial`/`failed`）。
   - **高風險 action_type（目前是 `inventory_setting`，庫存寫入立即影響前台可售並清快取）**：按「確認執行」不會馬上送出，面板會先顯示一個紅字二次確認 banner，要求再按一次「確定執行」才真的呼叫 `app_confirm_changeset`；按「取消」則回到勾選畫面，什麼都不送。
5. 按「拒絕」：change-set 轉為 `rejected`，不執行、可重建。
6. 若 be2 現況在你審閱期間又變了（diff 過期），伺服器回 `DIFF_STALE`，面板會顯示「現況已變」提示與一顆「回檢視重載」按鈕——**不是自動重拉**，按下後才重新呼叫 `app_get_changeset_view` 取得新 diff + 新 nonce（伺服器偵測到 stale 時已把重算後的 diff/diff_version 寫回該 change-set，所以重載後拿到的版本必與此刻現況一致，不會再次卡在同一個 stale 版本），回到「檢視」步驟讓你重新審閱、再按一次批准。
7. 面板上永遠保留一顆「前往核准（確認頁）」按鈕（`openLink` 開 `/confirm/<id>`）——即使面板批准可用，也可以改用確認頁；兩者互不影響，同一個 change-set 誰先按（CAS）誰生效，另一邊會拿到 `ALREADY_PROCESSED`。

## Claude Code（無 Apps 能力）怎麼辦

Claude Code 是終端機 host，沒有 MCP Apps 渲染能力（`hostSupportsApps` 判定為否）。這種 host：

- `be2_create_changeset` / `be2_get_changeset_status` 一樣正常回傳文字內容（`changeset_id`、`status`、diff 摘要），但**不會**有面板；agent 只能在文字裡把 `changeset_id` 報給你。
- app-only 工具（`app_get_changeset_view`、`app_get_confirm_link`、`app_confirm_changeset`）對非 Apps host **一律不註冊**（`src/server/app.ts` 依 `hostSupportsApps(caps)` 分派 `registerAppTool` vs. 一般 `registerTool`；非 Apps host 連工具本身都不存在，不是只隱藏 UI）——這代表 Claude Code 環境下 model 連「看得到但用不了」的機會都沒有，攻擊面比 Desktop 更小。
- 批准**只能**走 `docs/be2-mcp/phase2b-runbook.md` 的確認頁 SSO 流程：你自己到瀏覽器開 `http://127.0.0.1:8787/confirm/<changeset_id>`，登入 be2-auth（POPUP），審閱、批准/拒絕。

## 疑難排解

| 症狀 | 原因 | 處理 |
|---|---|---|
| Desktop 沒有跳出面板，只有純文字 | 忘了 `npm run build:ui`（`dist/ui/*.html` 不存在或是舊的） | 跑 `npm run build:ui`，重啟 be2-mcp server，重新連線（必要時重啟 Desktop） |
| Desktop 連不上 be2-mcp | `claude_desktop_config.json` 的 URL/port 跟目前 `BE2_MCP_PORT` 不一致，或 server 沒在跑 | 確認 `npm run dev` 正在跑、port 與設定檔一致；`curl http://127.0.0.1:8787/healthz` 應回 `ok` |
| 面板顯示但沒有勾選框/確認執行按鈕 | change-set 已離開 `pending_approval`（已被批准/拒絕/過期），或這個 host 沒通過 spike T6 等價驗證（本文件只驗證過 Claude Desktop，換 host 需重驗，見 `spike-t6-findings.md`「對計畫的影響」段） | 用 `be2_get_changeset_status` 查目前狀態；換 host 前先重跑 T6 等價 spike |
| 按「確認執行」回 `CONFIRMED_KEYS_MISMATCH` | 取消勾選了某個 item（見上「面板批准怎麼用」步驟 3：目前是全有全無語意） | 全部勾選後重按，或改請 agent 建一個範圍縮小後的新 change-set |
| 按「確認執行」回 `NONCE_INVALID` | nonce 過期或已被消耗（單次使用） | 重新整理面板（觸發 `app_get_changeset_view`）取得新 nonce |
| 按「確認執行」回 `ALREADY_PROCESSED` | 這個 change-set 已經被另一邊（確認頁，或另一個分頁的面板）批准/拒絕過 | 用 `be2_get_changeset_status` 查真正結果，不要重試 |

## 已知限制 / carry-forward

- **只驗證過 Claude Desktop**。claude.ai 網頁與未來的 Desktop 版本都需要重跑 T6 等價 spike 才能信任「app-only 工具對 model 不可見」這個安全前提（見 `spike-t6-findings.md` 的 host 相依 caveat）。
- **`npm run build:ui` 不是自動的**：忘記跑是最常見的「面板不出現」原因，見上表。
- 高風險 action_type 白名單目前只有 `inventory_setting`（硬編在 `src/ui/changeset-panel.ts` 的 `HIGH_RISK_ACTIONS`）；未來新增高風險 action_type 時記得同步更新這份清單。
