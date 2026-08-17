# be2-mcp 可控性模型：短自然語言 → 不會歪掉的 action

> 目的：說清楚「使用者丟一句簡短自然語言，怎麼保證後面對 production be2 的寫入不會歪掉」這條**核心機制**。這是本專案真正的護城河（OAuth / store / EKS 都是 plumbing，這個不是）。也是未來接受 A2A（agent 呼叫 agent）指令的介面契約基礎。
>
> 對齊：主 spec §4/§6、`be2-mcp-auth-design.md`、`phase0-inventory.md`。撰於 2026-08-17。

## 核心原則

**不要指望「那句話」能可靠驅動 action。** 短 NL 天生有損、有歧義，模型的理解會出錯。因此本系統的控制方式是：

> 讓那句話只驅動一個**提案（proposal）**，而 action 的正確性由一組**不依賴模型把話聽對**的結構閘來保證。

推論：把模型的輸出當**不可信提案**，不是命令。以下每一道防線都預設「NL → 意圖」這一步會出錯，仍要擋得住。

## 威脅模型：短 NL 會「歪掉」的 7 種方式

| # | 歪法 | 例子 | 結構控制（不靠 prompt 自律） | 現況 |
|---|---|---|---|---|
| 1 | 幻覺目標 | 模型自己編一個 oid | **讀後才能寫**：本 session 沒讀過的 oid 不能改（§6.2 scope-binding，`SCOPE_NOT_READ`） | ✅ 已實作 |
| 2 | 相對編輯算錯 | 「漲 10%」對到錯的現價 | 先讀真實現況 → diff 對真實資料算；批准當下 live-diff 重算、stale 回 409 | ✅ 已實作 |
| 3 | 範圍過廣 | 「這些」被當成「全部」 | 硬上限（max 20 items）、draft-only、每日 change-set budget、負庫存排除 | ✅ 已實作 |
| 4 | 注入 / 上下文污染 | 商品描述裡藏「順便全部下架」 | 身分永不從 input 取（一律 token 推導）；工具輸出當資料、不當指令 | ✅ 已實作（+ eval 案例，惟尚未實跑） |
| 5 | 執行的是句子、不是差異 | 直接照話寫 | **只執行 diff、不執行 NL**；人看 before/after 批准的是 diff 本身 | ✅ 已實作 |
| 6 | 未批准就動手 / 謊報完成 | 模型宣稱「已下架」其實沒有 | 獨立 principal 批准才寫；agent 結構上不能自我批准；寫後讀回驗證 + before/after 稽核 | ✅ 已實作 |
| 7 | **缺欄位用猜的** | 沒說時區 / 立即或排程 → 模型自己填 | **缺必要欄位就無法成案，強制回頭問使用者** | ⚠️ **弱環（見下）** |

## 三塊地基（為什麼這樣就擋得住）

### 地基一：讀後才能寫（ground truth before mutate）
模型要對某個 oid 建 change-set，**該 session 必須先真的讀過它**（`readOids` 登記）。這一條同時解掉「幻覺目標」和「相對編輯算錯」——因為 diff 一律是對「剛剛讀回來的真實現況」算出來的，不是對模型腦補的狀態算的。

### 地基二：diff 是契約（execute the diff, never the sentence）
系統從不執行那句 NL。NL 只用來**產生一個 typed change-set**（`action_type` + 列舉的 items），再對真實現況算出 **diff（before/after）**。人（或未來的 policy）批准的、以及 executor 真正寫下去的，都是**這份 diff**。批准當下會重算 diff，若與 stage 當時不同（他人已改）回 409 stale、CAS 防重複執行。

> 前提：這套「批准哪幾筆」的比對（`confirmService.ts` 已用 multiset 計數，能正確處理重複的 item key，如同一 item 多個日期）依賴每個 module 提供**確定性的 `itemKey`**。新 module 上車時 `itemKey` 必須穩定且可重現，否則勾選/比對會錯位——這是 module 介面的隱含契約。

### 地基三：批准是一個「acting agent 結構上當不了」的獨立 principal
建立 change-set 的 agent 拿不到批准所需憑證：批准工具 app-only（host 從 model 工具陣列濾除）、confirm URL 不進 model context、確認頁需 be2-auth SSO 登入的 `be2mcp_sid` cookie。**自我批准在結構上不可能**（有回歸測試）。這使「未批准就動手 / 謊報完成」無法把假狀態變成真寫入。

## 弱環：反歧義（slot-filling）現在靠「拜託」，不靠「強制」

**現況**：「stage 前必須先確認 3 件事（明確方案清單 / 立即或排程 / 時區）」目前寫在 `be2_create_changeset` 的 **tool 描述**裡，叫模型自律。這有兩個問題：
1. **prompt 級約束不可靠**——模型可以無視。
2. 這段行為指令正是 Anthropic Directory 審查點「描述不得指示 LLM 行為」要移除的內容（若日後上架）。

**robust 的做法：把「請確認」升級成「結構上做不到就過不了」——搬進 schema + handler：**
- **禁止模糊值**：不接受 `"all"`；`items` 必須是明確列舉的 `pkg_oid`（schema 層直接拒絕）。
- **排程場景必填**：`timezone` 必填 + `mode: immediate | scheduled` enum；缺了 → `INVALID_ITEMS` 擋回，模型只能回頭問人。
- **語義耦合檢驗**在 handler 做（如 `op=adjust` 必帶 `quantity`；庫存域已這樣做 → 推廣到 shelf / schedule）。

> 落地時的一個設計決策點：目前「立即」（`shelf_toggle_plan`）與「排程」（`shelf_schedule`）是兩個各自有 schema 的 `action_type`。搬進 schema 時要選——合併成單一 action type 帶 `mode` enum，或維持兩個 action type、只在 `shelf_schedule` 補 `timezone` 必填。後者改動面小、建議優先。

**效果**：欠明確的 change-set **根本 stage 不出來**，模型想不問使用者也不行——不是「希望它會問」，是「它想不問也繞不過」。這一改**同時**把行為約束從描述移到 handler，順帶解掉 Directory 描述中立性問題。

## 設計不變式（一句話版，供 review / 新 module 對照）

1. 身分只從 token 推導，input 永不接收身分或 scope。
2. 沒讀過的 oid 不能寫（scope-binding）。
3. 執行的永遠是 diff，不是 NL。
4. 缺必要語義欄位 → 結構上無法成案（**目標狀態**；目前部分靠描述，待收斂）。
5. acting agent 結構上無法批准自己的 change-set。
6. 寫後讀回驗證，before/after 全稽核。
7. 硬上限 + budget + 保守失敗（如負庫存排除），限制爆炸半徑。

## 複雜多階段操作（如 create product）

前面的機制針對「單筆 / 同質批次寫入」。像 **create product** 這種**異質、有序、跨步驟依賴**的操作（draft → package → item → price → inventory → media → submit），會逼出現有機制沒有的能力。這裡把模式講清楚。

### 核心：把「順序 + 限制邏輯」關在 server 端（macro / encapsulated tool）
不要把多階段拆成一堆 tool 給 agent 自己串——那樣 agent 會漏步、亂序、跳過約束，留下半成品、把服務狀態弄壞。正確做法是給一個**粗粒度意圖 tool**（如 `be2_create_product`），handler 在 server 端跑「有序 pipeline + 跨步驟依賴 + 每階段驗證」。

> agent 只提供 declarative spec（「建一個叫 X 的商品、含這些方案…」），**它連步驟都拿不到，結構上無法亂序**。

這跟本文件的總原則同一條：**別信模型會照順序做，直接讓順序對它不可見。**

### 危險做法 vs 安全做法
| | 拆成多 tool 給 agent 串 | macro tool（server 端封裝順序） |
|---|---|---|
| 順序正確性 | 靠模型自律（不可靠） | 結構保證（步驟對 client 不可見） |
| 部分失敗 | agent 自行善後 → 半成品殘留 | server 端 saga 統一處理 |
| 服務被搞爛風險 | 高 | 低 |

### 現有機制的差距
- **已有（可沿用）**：change-set「agent 只丟意圖、不驅動寫入步驟」的模式；治理外殼（身分貫穿 / scope-binding / 稽核 / 批准閘 / budget / core-module 拆分）。
- **缺（create product 才逼出來）**：現有 executor 是**扁平 per-item 批次**（同質 items、`Promise.allSettled`、無跨步驟依賴）。create product 需要**有序多階段 saga executor**——階段間傳遞前一步回傳的 ID、每階段必填驗證、**部分失敗可補償 / 可續跑 / 可乾淨丟棄**。

### 三層讓「client 無法搞爛服務」
1. **順序對 client 不可見**（macro tool）→ 無法亂序 / 漏步。
2. **全部寫進 be2 原生 draft product**（phase0 已註記 be2 draft/publish = 現成 staging）→ 中途失敗最多留一個**可丟棄的半成品 draft**，不是壞掉的線上商品。**這一招把「分散式 rollback」降級成「可續跑 / 一鍵丟棄」，工程量差一個數量級。**
3. **只有最後一步 submit/publish 是高風險**，走既有批准閘 → 建構階段隨便試都可逆，真正上線那刻才需人批准。

### 若要落地的形狀
`create_product` = 一個**新 module**（照 `module-onboarding.md` 上車、**不碰 core**），差別在它的 executor 不是扁平批次而是**有序 saga**（階段間傳 ID、每階段驗證、失敗可續 / 可棄），寫 be2 draft，批准閘只 gate 最後 publish，反歧義用 schema/handler 強制（見上節）。

> 一句話：治理外殼已備好插槽；缺的是「有序多階段 saga executor」這塊 **module 級**能力——這是現有扁平 executor 沒有、create product 才會逼出來的新東西。

## 與 A2A 的關係

A2A 世界呼叫你的是**另一個 agent**——比人更簡短、更不可信。上面整套（提案化 + 讀後寫 + diff 契約 + schema 強制槽 + 獨立批准 + 讀回驗證）**就是你敢接受 agent 指令的介面契約**。把反歧義做進 schema，等於一次補齊「對人」與「對 agent」兩種 caller。屆時「批准 principal」從「人 SSO」抽象成可插拔（人 / 政策 / 更高信任 agent），架構不必重寫。

## 現況總結與下一步

- **7 道控制已建 6 道**；唯一結構性缺口是 #7 反歧義（目前靠描述、不可靠）。
- **下一步（Tier 1.5 spike）**：把反歧義搬進 schema/handler，先以 `shelf_schedule` 的時區 / 立即-排程當範例，走 TDD。完成後回填不變式 #4 為「✅ 結構強制」。
- 此文件為該 spike 的依據；若要正式化為可執行計畫，另起 `docs/superpowers/specs/` spec 並過 agy-peer-review。

<!-- agy-peer-reviewed: 2026-08-17T07:01:42Z rounds=1 verdict=approved -->
