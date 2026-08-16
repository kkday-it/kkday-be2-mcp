# be2 MCP × mcp-ui — 友善介面探索 + 風險分級批准模型

日期：2026-08-11　狀態：探索規劃（草稿）
> 目的：用 mcp-ui 改善非工程師在 Claude 裡操作 be2 的體驗，同時不破壞「agent 無法自我核准」的安全命脈。核心結論：**按風險分級（L1/L2/L3）決定「批准落在哪條憑證域」**，而不是「所有批准都趕出 mcp-ui」。

## 1. 名稱釐清 + 是什麼（一句）

- **官方標準 = 「MCP Apps」**（spec repo：`modelcontextprotocol/ext-apps`）：標準化「UI over MCP」，工具用 `_meta.ui.resourceUri` 連到一個 UI resource，host 以 `resources/read` 取回、用 `AppRenderer` 渲染。MIME 為 `text/html;profile=mcp-app`。
- **`mcp-ui`**（`@mcp-ui/*` packages）= 實作 MCP Apps 標準的 **SDK**（它先發明了這概念、影響了 spec；同時相容較舊的 legacy「MCP-UI」嵌入式模式）。**標準名叫 MCP Apps，mcp-ui 是我們會用的 SDK。**

機制：MCP server 提供一個 `ui://` 的 HTML resource，host 在**沙箱 iframe** 裡渲染；UI 裡的按鈕透過 `postMessage` 發事件回 host（可觸發 tool call、開連結、送 prompt）。等於「工具回傳的不只是文字，是一塊互動面板」。

**關鍵利多：[Claude 已是官方支援的 MCP Apps host（✅）](https://github.com/MCP-UI-Org/mcp-ui#-supported-hosts)** → 對 Desktop / claude.ai 這類 GUI host，友善 UI 是可行的（Claude Code 終端渲染不出 iframe，見 §6）。

> **對安全設計有利的一點**：新的 **MCP Apps 模式**（`_meta.ui.resourceUri` + host `resources/read` 分開取 UI）比舊的 legacy 嵌入式（把 resource 直接塞進 tool 回應）**更可能把面板 HTML 排除在 model context 之外**——這正好幫到 §4.3 的 per-render nonce（若 model 看不到面板，nonce 才藏得住）。**因此優先走 MCP Apps 模式，不用 legacy 嵌入式。** 實際是否如此仍需 spike 驗（§6 首要題）。

## 2. 用在哪（對到 5 步）

| 步 | 現在 | mcp-ui 之後 |
|---|---|---|
| 01–02 理解+取資料 | agent 文字列商品 | 互動**商品/方案挑選器**（清單、勾選、搜尋） |
| 03–04 算 diff + 建草稿 | 文字 diff | 視覺化 **diff 面板**（before→after、高風險紅字、勾選要納入哪幾筆） |
| 05 核准 | 開瀏覽器確認頁 | **依風險分級**決定（見 §3） |

前四步（讀取 + 建草稿）純屬安全半段，用 mcp-ui 沒有爭議、體驗提升最大。爭議只在「05 核准落在哪」——這就是分級模型。

## 3. 核心：風險分級決定「批准落在哪條憑證域」

批准訊號可以落在兩條憑證上：**(a) mcp-ui 的 tool action**（走 agent 的 MCP session／bearer）或 **(b) be2-auth 獨立 session**（agent 拿不到）。分級決定用哪條：

| 等級 | 例子 | 影響/可逆 | 批准落在哪 | 補強 |
|---|---|---|---|---|
| **L1 低** | 單品上/下架 | 可逆、影響小 | **mcp-ui 面板「確認」→ 觸發寫入 tool**（同域） | 面板回傳實際選取項（intent echo）+ 執行前 stale check + 稽核 |
| **L2 中** | 批次下架 | 可逆、影響面較大 | **mcp-ui 面板批准，但補強** | ① server 端意圖驗證：面板須回傳「使用者實際勾選的每一筆」，非籠統 `approve=true`；② 執行前 stale check；③ 稽核 |
| **L3 高** | 價格、大批量、不可逆 | 高影響/難逆 | **不走 mcp-ui tool**；面板做視覺化 diff + 「前往核准」**link** → be2-auth 確認頁 | 獨立憑證域簽核、留獨立證據 |

**設計精神（使用者定調）**：「解法不是把所有批准趕出 mcp-ui，而是按風險分級決定批准落在哪條憑證上。那條線畫在 L3，不是畫在『所有批准』。」

## 4. 安全補強細節（工程落地要點）

這幾條決定分級模型「真的站得住」還是「看起來站得住」：

1. **等級判定必須 server 端權威**：由 server 依 `action_type` + 批量 + 可逆性推導 L1/L2/L3，**agent 不能自稱「這是 L1」走捷徑**。否則被注入的 agent 會把 L3 謊報成 L1。
2. **L1 也建議帶 intent echo（近免費）**：單品上架仍有「錯的商品被賣掉」的真金白銀窗口——狀態可逆 ≠ 期間傷害可逆。既然回傳選取項幾乎零成本，把它當 L1 的地板，不做「裸奔 approve」。
3. **L2 的 intent echo 能擋什麼、擋不了什麼（誠實）**：
   - 擋得住：籠統的「approve 全部」注入（因為要回傳精確勾選集）。
   - **擋不住**：一個知道自己 change-set 內容的 agent 自我批准（它本來就知道要勾哪些）。
   - 真正能咬的是「**對 model context 隱藏的 per-render nonce**」——面板渲染時 server 埋一個一次性、綁 `diff_version` 的 nonce，批准須回傳它。但這只在「host 不把面板 HTML 回灌 model context」時有效（見 §6 未知）。
   - **【2026-08-12 spike 實測結果】兩個前提都成立**（Claude Desktop）：(a) 面板 HTML **未進** model context（換 canary + 全新對話驗證，模型寫不出 canary 碼；注入 canary 也未觸發）→ per-render nonce 可行；(b) **更好的通道**：`visibility:["app"]` 的 app-only tool 在 Desktop 被 host 濾出模型工具清單、其結果也不進 context（面板實呼叫過、模型答不出 NONCE）→ **nonce 發放/回收首選 app-only tool**（規格級語義），面板 HTML 隱藏降為次要防線。**唯一附帶條件**：app-only 過濾是 host 行為、非協定保證（wire 層 `tools/list` 照列；Claude Code 這種非 Apps host 全曝光）→ server 必須 capability-gate：只對 initialize 宣告 `io.modelcontextprotocol/ui` extension 的 session 註冊 app-only tools。
   - 結論：**L2 走 mcp-ui 的殘餘自我批准風險是「有意識地接受」**——用「中影響 + 可逆 + stale check + 稽核」兜底，而非宣稱完全關閉。這條線畫在這裡是合理的取捨，但要寫明白、別自欺。（spike 後修正：有 app-only nonce 通道墊底，殘餘風險比原評估再小一階——agent 拿不到 nonce 就無法組出合法批准呼叫。）
4. **L3 = 面板負責漂亮、be2-auth 負責簽核**：mcp-ui 面板把 diff 呈現得易懂 + 一顆 `link` 按鈕開 be2-auth 確認頁；使用者在**正確的憑證域**用自己身分簽核、留獨立證據。**唯一不行的是把 L3 最終簽核塞進 mcp-ui 的 tool action**（那會與 agent 共用憑證域，破壞命脈）。
5. **stale check 三級通用**：任何等級，執行前都重抓 live state 重算 diff，對不上就退回（避免「批准當下現況已變」盲蓋）。

## 5. 降級：不能渲染就走文字（tier 規則不跟著掉）

host 渲染不出 mcp-ui（如 Claude Code 終端）→ **優雅降級走純文字流程**。但降級**只降介面、不降安全等級**：
- L3 文字版仍是「印出 be2-auth 確認頁連結、去那裡簽核」（link-out 不變）。
- L1/L2 文字版仍要 intent binding（要使用者確認具體項目，非一句 yes）。
- 換句話說：**mcp-ui 是體驗增強層，不是安全層**；安全等級由 server 分級決定，跟渲染與否無關。

## 6. Host 與技術未知（2026-08-12 spike 已驗，詳見 `mcp-ui-spike-checklist.md` Findings）

| 未知 | 為何關鍵 | **實測結果** |
|---|---|---|
| **Claude host 會不會把 `ui://` 面板 HTML 回灌 model context** | 決定 §4.3 的 per-render nonce 有沒有用（若 model 看得到 nonce，L2 的強化就漏）。**這是最關鍵的一題。** | ✅ **不會**（Desktop）。且 app-only tool（`visibility:["app"]`）連工具本身與結果都被 host 濾出 context → nonce 首選走這條。host 只往 context 注入一段「widget 已渲染」提示文字 |
| host 粒度（Desktop/web ✅、Code 終端 ✗） | 友善 UI 只對 GUI host 有意義；Code 一律走 §5 文字降級 | ✅ 如預期：Desktop 渲染成功（**需 mcp-remote stdio shim**，直連 loopback HTTP connector 未成）；Code 文字 fallback 不壞。⚠️ Code 端 app-only tool **全曝光**（host 不認得 visibility）→ server 須 capability-gate 註冊 |
| `link` action 能否穩定在使用者**真實瀏覽器**開確認頁 | L3 link-out 的前提；要能帶既有 be2-auth cookie 才能靜默 SSO | ✅ 開在**系統瀏覽器（Chrome）**，非內嵌 webview → 靜默 SSO 前提成立 |
| iframe 內是否可持有 be2-auth session（進階選項） | 若可，L3 也能「iframe 內嵌確認頁、自己 SSO、直打 /approve（不經 MCP tool）」，體驗更順——但需威脅建模，**先不做** | ⬜ 未驗（維持先不做） |
| mcp-ui/MCP Apps 規格流動性 | 綁還在演進的標準有版本風險 | 部分緩解：spec 2026-01-26 穩定版；ext-apps SDK 1.7.5 實測 API 與文件一致。tool action round-trip 亦驗過（逐筆勾選+nonce 完整帶回） |

## 7. 分階段（小步驗證）

1. **Spike（半天–1 天）**：最小 mcp-ui tool 回一塊 HTML 面板，在 Claude Desktop / claude.ai **實際渲染**——驗 host 渲染、link action 開外部瀏覽器、**面板 HTML 是否進 model context**（§6 首要）。
2. **唯讀友善化**：`be2_get_product_plans` 等回傳加 `ui://` 挑選器面板。純讀零風險，先拿體驗分。
3. **L1 批准面板**：單品上/下架的 diff 面板 + 「確認」tool action + intent echo + stale check。
4. **L2 補強**：批次下架面板，加 server 端逐筆意圖驗證（+ nonce，視 §6 首要題結論）。
5. **L3 link-out**：高風險面板做視覺化 diff + 「前往核准」link → be2-auth。
6.（可選、後段）威脅建模後評估「iframe 內嵌確認頁」。

## 8. 對應五軸 rollout 的「閘門/介面」

這不改「閘門」語義，是把它落地成介面：
- **L1 面板確認** ≈ 五軸圖的「低風險軟閘」。
- **L3 link-out be2-auth** ≈ 「逐筆人核准」。
- mcp-ui 面板 = 「核准介面」的一種更友善的殼，與「常駐待批清單頁 / 手機 push」並列（RD 版 §5.7）。

## 9. Open questions（2026-08-12 spike 後更新）

- ~~host 是否把面板 HTML 餵進 model context？~~ **已解**：不會（§6）；nonce 首選 app-only tool 通道。
- Desktop 與 **claude.ai** 的 mcp-ui 支援是否有差異？各自 link action 行為？（Desktop 已驗；claude.ai 未驗——首波不做公網 host，暫不驗。）
- L1/L2/L3 的**自動分級規則**具體長怎樣（action_type × 批量 × 可逆性 → 等級）？
- ~~降級偵測：server 怎麼知道 host 渲不渲染得出來？~~ **已解**：initialize 的 `capabilities.extensions["io.modelcontextprotocol/ui"]` 就是 capability 協商訊號（Desktop 有帶、Code 沒帶）；tool text result 一律附文字 fallback + app-only tools 依此 gate 註冊。
- 新增：面板 JS handshake 失敗時 Desktop 呈現**無提示空白**——正式面板需自帶 error/loading fallback 與（可行的話）`sendLog` 回報。
