# be2 MCP — 關鍵資訊安全模型（白話版）

日期：2026-08-13
> 給 RD / PM / 主管 / 資安看的「為什麼這樣設計是安全的」說明。技術細節見設計 spec：`docs/superpowers/specs/2026-08-13-be2-mcp-oauth-shell-design.md`（OAuth 外殼）、`2026-08-12-be2-mcp-apps-panels-design.md`（面板批准）。對應 `CLAUDE.md` 鐵則 #4（draft-only、agent 不能自我批准）。

本文件回答四個常被問到的資安問題，全部用白話 + 生活類比。

---

## 1. 帳密會不會被 AI agent 拿到？→ 不會（這就是 OAuth 的重點）

**帳密只打進 be2-auth 自己的官方登入頁**（瀏覽器裡那個 be2 頁面）。AI agent（Claude）從頭到尾**看不到帳密**。

這跟你平常在 Claude 裡「連接 Slack / Jira / Google」**是同一套機制**（OAuth 2.1 authorization-code flow）：
- 按「連接 Slack」→ 瀏覽器彈出 Slack 登入 → 你登入 Slack（Claude 看不到你的 Slack 密碼）→ Slack 導回一個「授權碼」→ Claude 拿授權碼換 token。
- 我們做的事 = **讓 be2-mcp 對 Claude 表現得像 Slack/Jira 那樣的標準 OAuth 供應商**，Claude 內建的 OAuth 客戶端就自動會用，不用手貼任何憑證。

**現況（過渡期）**：OAuth 外殼尚未實作前，改用 `bootstrap-user` CLI 先登入換一顆長期 bearer 手貼進設定檔。帳密走 `.env`、由人跑 CLI，一樣不經 agent，但體驗較差、bearer 不過期。OAuth 外殼上線後這步消失。

---

## 2. 「授權碼（code）」是什麼？為什麼安全？→ 一張一次性寄物櫃號碼牌

登入成功後，AI agent 拿到的**不是帳密、也不是 token**，而是一個 **授權碼（authorization code）**：

- 它像**寄物櫃的號碼牌**：短命（幾秒~幾分鐘）、一次性、隨機字串。
- Claude 拿號碼牌 + **一把只有它自己有的暗號（PKCE code_verifier）**，去「取物櫃台」（`/oauth/token`）換出**真正的 token**。
- 號碼牌本身沒用：沒有那把暗號、或過期、或已被用過，都換不到東西。

**為什麼要分兩步（先 code 再 token）？** 因為「導回」那一步走的是**瀏覽器**（網址、瀏覽歷史、log 都會留痕）。你不想讓真 token 出現在這些地方，所以：
- 先給「低價值的號碼牌」走瀏覽器（就算被看到也沒用，需要 PKCE 暗號 + 一次性 + 短命）。
- 真 token 由 Claude 在**背後直接連線 POST** 換回，不經瀏覽器。

這是業界標準 **PKCE authorization-code flow（RFC 7636）**，Slack / Jira / Google 全用這套。

---

## 3. 「本機 loopback」是什麼？→ 授權碼送回你自己電腦，不上公網

OAuth 登入完成後，授權碼要送回一個網址（redirect_uri）。分兩種：

| Client | redirect_uri | 需不需要公網 |
|---|---|---|
| **Claude Code / Desktop（本情境）** | Claude 在**你本機臨時開一個埠**，如 `http://127.0.0.1:54321/callback`；授權碼導回這裡，Claude 在本機收 | **不用**。be2-mcp 內網部署即可 |
| claude.ai 網頁版（本情境不做） | `https://claude.ai/api/mcp/auth_callback`（Anthropic 雲端公開網址） | 要，且需資安核可 |

**流程舉例**（Claude Code）：Claude 發現要 OAuth → 本機開 `127.0.0.1:54321/callback` → 透過 DCR 註冊成 redirect_uri → 瀏覽器彈 be2 登入 → 登入後 be2-mcp 把瀏覽器導回 `http://127.0.0.1:54321/callback?code=xxx` → Claude 在本機那個埠**收到授權碼** → 背後換 token。**全程沒有一步經過公開網際網路**，所以會改生產後台的這支工具可以**只留內網**，資安姿態更好。

**防 open redirect**：redirect_uri 必嚴格 `new URL()` 解析後斷言 `hostname` 是 `localhost`/`127.0.0.1`、path 是 `/callback`，不用字串前綴比對（否則 `http://localhost.evil.com/callback` 之類會繞過）。

---

## 4. 「一個身分、多把鑰匙」（identity/credential 拆分）→ 就是 Google「管理裝置」那套

**問題**：我們要「一次 be2 登入，同時服務兩件事」——(a) 發 token 給 agent 連線用、(b) 在瀏覽器建立 session 讓確認頁免二次登入。若用最直覺的「一顆憑證綁一份 token」會出事（見下）。

**解法**：把「你是誰」和「你用哪把鑰匙進來」拆成兩層。**你天天在用這個模型**：

> Google 帳號的「管理裝置 / 第三方存取權」頁面——**一個 Google 身分**，底下同時掛著瀏覽器 session、手機 app token、你授權給某第三方 app 的 token。每一個都能**單獨撤銷**（把某台裝置登出）而不影響其他。

對映到 be2-mcp：

```
be2_identities（一次 be2 登入 = 一筆；be2 token 只存這裡一份）
  identity I1 : be2_access, be2_refresh, business_list

credentials（多把鑰匙，都指向同一身分，各自是不同的隨機字串）
  鑰匙 A : kind=oauth_access  → I1   （發給 agent 連線的 token）
  鑰匙 B : kind=web_session   → I1   （瀏覽器的 be2mcp_sid cookie）
  鑰匙 C : kind=static_bearer → I1   （過渡期手貼 bearer）
```

**這樣同時解掉三個安全/正確性問題**：

1. **agent 無法自我批准（最重要）**：agent 手上是鑰匙 A，確認頁認的是鑰匙 B——**不同字串**。agent 就算把自己的 A 當 cookie 送（`Cookie: be2mcp_sid=<A>`），server 一查這顆 hash 是 `kind=oauth_access`、不是 `web_session` → **確認頁拒收**。agent 結構上生不出鑰匙 B。這就是鐵則 #4「agent 拿不到批准所需憑證」在 OAuth 情境下的具體保證。
2. **token 續期不打架**：be2 token 只有 I1 一份。近到期時只 rotate I1，鑰匙 A/B 下次來查都讀到同一份新鮮 token——不會「其一 rotate 把另一顆搞失效」。
3. **換 token 不斷線**：agent token 到期換新（A→A'）時，刪 A 那列、加 A' 那列，**I1 不動**。連線 session 綁的是身分 I1、不是 token 字串 → 換 token 後 session 還活著；舊 A 立刻失效。

**一句話**：一份身分可以配多把鑰匙，每把鑰匙互不洩漏、可獨立作廢，身分的續期集中一處做。

---

## 這些如何合起來守住「agent 不能自己按下寫入」（鐵則 #4）

be2 是生產商品後台，寫入（上下架、改庫存價格）必須人工批准。防線分兩條路徑，**agent 兩條都進不去**：

| 批准路徑 | 用在 | agent 為什麼進不去 |
|---|---|---|
| **面板批准**（Desktop，MCP Apps） | 支援 Apps 的 host | 批准工具是 app-only，host 把它從 agent 的工具清單濾除（spike T6 已證）；批准要一次性 nonce，只從 app-only 通道發放、不進 agent context |
| **確認頁批准**（Claude Code 等退路） | 不支援 Apps 的 host | 批准要 `be2mcp_sid` cookie（鑰匙 B）。agent 有 curl，但拿不到瀏覽器那顆 cookie、也生不出（它只有鑰匙 A，kind 不符被拒） |

兩條路徑最終都收斂到同一套 server 端執行邏輯（重算 diff → 防重複執行 CAS → 寫入 → 全鏈路稽核），且寫入止於 draft、核准才執行、可逆、留證。

**殘留假設（誠實揭露）**：面板批准那條依賴「host 會把 app-only 工具擋在 agent 拿不到的地方」，目前只對 Claude Desktop 實測過（spike T6）；換 host（claude.ai、未來版本）需重驗。確認頁那條依賴 HttpOnly cookie 的瀏覽器隔離，是成熟機制。兩條並存，互為縱深防禦。
