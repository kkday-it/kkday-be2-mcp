# be2 MCP — 模組化架構規劃（handoff 草稿）

日期：2026-08-13　狀態：**已落地，見 spec/catalog**
> 目的：讓 be2 MCP 從「product 單一 domain」走向可擴展的**多模組**（訂單、商品公告、折扣券、兌換券…），使「加一個 domain」= 寫一個 module 註冊進去，**不重寫治理層**。
> 搭配讀：`be2-mcp-rd-design.md`（現有 SA/SD）、`mcp-ui-exploration.md`（分級批准）、`phase0-inventory.md`（逐 domain 盤點史）。

## 0. 為何是現在

- 現有 domain-specific 邏輯（`createChangeset` 的 `ACTION_CODES`、`computeShelfDiff`/`inventoryDiff`、executor 的 if 分支、confirm/panel 的 domain 判斷）**散在共用檔裡**。domain 一多 → switch 地獄、每加一個都改到 core。
- **時機**：在接第一個真正獨立的 module（訂單）**之前**抽介面，才有 product 當現成參考實作；接了兩三個再抽會很痛。

## 1. Core / Module 邊界（最重要的決定）

**治理層是 domain-agnostic 的，不該每接一個 module 重寫。** 切成兩塊：

**Core（閉合、不隨 domain 改）提供：**
authn（OAuth 外殼 + auth-service）· authz（/verify 委派）· token store · change-set 生命週期（狀態機、stale check、CAS 執行恰好一次）· 確認頁/面板/nonce 通道 · **分級批准 L1/L2/L3 強制** · append-only 稽核 · OTel · rate budget · scope-binding · 命名空間與 rollout gating。

**Module（可加、self-contained）提供 domain 的那幾格：**
讀現況、語義驗證、算 diff、執行寫入、端點契約、businessList 碼、風險等級、（選）面板描述。

→ 加訂單 = 寫一個 `orderModule` 註冊進 registry，**不碰 core**。

## 2. Module 介面草案（brainstorming 起點，非定稿）

```ts
interface DomainModule {
  id: string;                       // 'product' | 'order' | 'announcement'
  actions: ActionSpec[];            // 此 module 處理的 action_types
  readState(ctx: ModuleCtx, refs: Ref[]): Promise<StateSnapshot>;   // 抓現況（算 diff / 相對編輯）
  validate(ctx: ModuleCtx, items: ChangeItem[]): ValidationResult;  // schema + 業務規則
  computeDiff(ctx: ModuleCtx, items: ChangeItem[], snap: StateSnapshot): Diff;  // before→after
  execute(ctx: ModuleCtx, approved: ChangeItem[]): Promise<ExecResult>;         // read-merge-write
  panel?: PanelDescriptor;          // 選配：MCP Apps 面板
}

interface ActionSpec {
  action_type: string;              // 命名空間：'product.shelf_toggle'、'order.cancel'
  risk: 'L1' | 'L2' | 'L3';         // ★ server 權威，module 宣告、core 強制（agent 不能自稱）
  businessListCodes: string[];      // 需要的授權碼（per-domain 實查）
  endpoint: EndpointDescriptor;     // base path / method / merge-vs-replace / modify_user / reversible
  writable: boolean;                // 唯讀 module（如公告查詢）→ false
}

// core 注入給 module 的能力（module 不自己碰 token / audit / gateway 原生）
interface ModuleCtx {
  identity: Identity;               // 由 token 推導，module 不接收身分
  gateway: GatewayClient;           // 已帶 /verify 的下游呼叫
  audit: AuditSink;                 // append-only，before/after 由 core 記
  scope: ScopeChecker;              // 這個 oid 本 session 有沒有被 read 過
}
```

**設計原則**：module 只表達「這個 domain 的資料怎麼讀/驗/diff/寫」，**一切治理（身分、授權、批准、稽核、rate、scope）由 core 統一做**。這樣分級批准、self-approval 防護、稽核，全部**一次寫好、所有 module 免費繼承**。

## 3. 重構計畫（product 當第一個 module）

1. **先把共用機器壓成 domain-agnostic**：change-set 狀態機、executor loop、confirm/panel、audit event shape 抽掉所有 `if action==='shelf'…` 分支，改呼叫 `module.computeDiff()/execute()`。
2. **把 product 邏輯退進 `modules/product/`**：`shelf_toggle`、`inventory_setting`、（3b）`price` 三個 action 成為 product module 的 `actions`。
3. **穩定 core 內部介面**（重構時同步鎖定，別讓它們一直變）：`ChangeItem` shape、`Diff` 表示、executor 的 read-merge-write 契約、tier 分類器輸入、audit event shape。**這些一變，每個 module 都壞** → 是這次重構最該定死的東西。
4. **加 registry**：`registerModule(productModule)`；core 依 `action_type` 前綴路由到對應 module。

## 4. 逐模組 onboarding checklist（模板化）

每個新 domain 照這張走（沿用 Phase 3a 的切片流，正式化）：

- [ ] **外部依賴**：一個在該 domain 有寫權的帳號/環境、該 domain 的 businessList 動作碼、（若碰真寫入）契約 probe。→ **頭號阻擋（可寫帳號）會逐模組重演**，先當標準前置。
- [ ] **contract probe**：端點、必填、merge-vs-replace、`modify_user`、可逆性 → 填 `EndpointDescriptor`。
- [ ] **readState**：擴充/新增 L0 讀取（嚴禁盲寫）。
- [ ] **validate / computeDiff / execute**：實作 module 三格。
- [ ] **risk 標記**：每個 action 標 L1/L2/L3（見 §6 watch-out）。
- [ ] **eval + 安全測試**：draft-only、scope-gate、注入、該 domain diff 正確性（共用 eval 模板）。
- [ ] **rollout gating**：feature flag × 環境 × 人群 × Apps-capability。

## 5. Rollout gating（對齊五軸圖的「領域」軸）

modularize 讓「領域」變一等公民：每個 module 可獨立開關，維度 = **module × 環境（SIT/stage/prod 內網）× 人群（pilot/…）× Apps-capability（面板 host 才註冊 app-only tool）**。core 讀 initialize 的 `capabilities.extensions` 決定要不要對該 session 註冊面板工具（spike 已證非 Apps host 不過濾 app-only）。

## 6. 三個 watch-out（別踩）

1. **別假設所有 domain 都「product 形狀」**。訂單有狀態機（booking status）、取消/退款多半**不可逆 = 大量 L3**，甚至不見得適合 change-set/draft-only；商品公告是內容、低風險、可能**唯讀或近唯讀**。→ module 介面要容納：不同風險輪廓、不同寫入形狀、**唯讀 module**（`writable:false`）。別把 product 假設焊進 core。
2. **別過早過度抽象**。介面要從**兩個真實模組**（product + 訂單）萃取，不是憑空設計。→ 順序：做完 product → 用 product 抽介面 → **訂單當第二模組驗證介面真的通用** → 才算 modularize 完成。
3. **命名空間**：工具（`be2_order_*`/`be2_product_*`）、`action_type`、businessList 碼皆 per-domain 命名避免碰撞；另備一份 **module catalog** 文件講「現在支援哪些 domain/action/風險等級」。

## 7. 建議順序

1. 收尾 product：價格 3b + **首次真實寫入**（頭號阻擋，需可寫帳號）。
2. **抽 module 介面**（product 當參考實作）——本規劃的主工。
3. 訂單當第二模組驗證介面 → 通用性成立才算 modularize 完成。
4. 之後每個新 domain 走 §4 模板 + 外部依賴 checklist。

## 8. Open questions（給 brainstorming）

- `ChangeItem`/`Diff` 要多通用才夠？（product 的 per-date/per-supplier vs 訂單的狀態轉移，能不能同一個 shape？）
- 不走 change-set/draft-only 的 domain（如訂單即時操作）怎麼掛進同一套治理？還是另開一類 module？
- 唯讀 module（公告查詢）要不要也吃 scope-binding / rate budget？
- risk 分級規則要不要 per-action 硬編，還是 `(action × 批量 × 可逆性)` 動態算？
- registry 是編譯期靜態註冊，還是支援 per-deployment 開關某些 module？

## 9. 給新 session 的開場 prompt

```
接手 be2 MCP 模組化架構。先讀，不要背其他 context：
- docs/be2-mcp/module-architecture.md（本規劃）
- docs/be2-mcp/be2-mcp-rd-design.md（現有 SA/SD）
- docs/be2-mcp/mcp-ui-exploration.md（L1/L2/L3 分級批准）

走主管線：superpowers:brainstorming 針對「core/module 邊界 + DomainModule 介面」
（先回答 §8 的 open questions）→ 產 module 架構 spec（docs/superpowers/specs/）→ agy-peer-review。
重構以 product 當第一個 module、訂單當第二個驗證通用性；治理層不重寫。
```
