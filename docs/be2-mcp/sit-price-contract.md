# 3b 價格域（成本售價）契約 — 探查報告

> 目的：為 **Phase 3b 價格 action_type** 備妥契約，讓它能照 `module-onboarding.md` 直接上車。
> 來源：**權威** = `kkday-it/product-team-docs` 的 `Product/系統操作手冊/04-成本售價設定.md`（product team 維護）；輔以 phase0 patrol（`draft/product/item/{itemOid}/official-price` PUT 等）。
> 探查日期：2026-08-19（自主探索，全程唯讀）。**live wire 樣本尚缺**（見 §5），但端點/欄位/架構已由手冊定案，足以開工。

---

## 1. 一句話定位

價格域 = **以 SKU 為單位、依「時間格」設定成本/售價/官方價/固定幣別價/組合包售價**。與庫存（live、即時）、shelf-toggle（live）**根本不同**：**價格全部走 draft**（`/product/api/v1/drafts/...`），寫入落 `draft_sku_price` / `draft_sku_cost`，**需另一步 publish/workflow 才上線**。

---

## 2. 架構關鍵：draft-based → 天然對齊 change-set draft-only

- 價格寫入端點全在 `drafts/...`：改的是**草稿**，不動線上；草稿可丟棄、可經 `PUT drafts/product/{prodOid}/workflow` 發佈才生效。
- **對 change-set 的含意**：一個「調價」change-set 的 executor 若只寫 draft，是**極低風險**（可撤回、不影響線上售價）；「發佈上線」是明確的高風險第二步（對齊 phase0「執行寫 draft（可撤回）+ publish 另作明確步驟」）。→ 建議 3b 首發 action_type **止於 draft**（例如 `price_adjust_draft`），publish 另議。

---

## 3. 端點清單（手冊，權威）

### 讀取
| Method | 端點 | 說明 |
|---|---|---|
| POST | `api/v1/drafts/items/{item}/quotations/search` | **取得品項成本與售價**（主讀取，成本+售價一起） |
| GET | `api/v1/drafts/items/{item}/prices` | 取得品項售價資料（所有 SKU） |
| GET | `api/v1/drafts/items/{item}/costs` | 查詢所有 SKU 成本 |
| GET | `api/v1/drafts/items/{item}/official-prices` | 官方價 |
| GET | `api/v1/drafts/items/{itemOid}/cost-setting` | 成本設定（`price_type`/`price_rule_type`/幣別等） |
| GET | `api/v1/drafts/items/{item}/price-currency` | 售價幣別 |
| POST | `api/v1/drafts/items/{item}/quotations/search/last-modify` | 成本售價最後異動 |
| GET | `api/v1/drafts/items/{item}/quotations/status` | 更新成本售價狀態（async 判斷） |

### 寫入（皆 draft）
| Method | 端點 | 說明 |
|---|---|---|
| PUT | `api/v1/drafts/items/{item}/quotations` | **更新指定日期/場次的成本售價**（首選：精準、per-date/session） |
| PUT | `api/v1/drafts/items/{item}/prices` | 更新所有 SKU 售價 |
| PUT | `api/v1/drafts/items/{item}/costs` | 更新所有 SKU 成本 |
| PUT | `api/v1/drafts/product/{product}/items/quotations` | 跨方案批次成本售價 |
| PUT | `api/v1/drafts/product/{product}/items/import-quotations` | 匯入報價單（CSV 批次） |
| PUT | `api/v1/drafts/items/{item}/official-prices` | 官方價 |
| PATCH | `api/v1/drafts/products/{product}/fix-prices` | 固定幣別價批次（CSV） |
| POST | `api/v1/gross-margin/availability` | **毛利率驗證**（寫入前應先驗，低/負毛利需理由，見下） |

> 每次改售價會**觸發折扣清除**（`PUT prices`/`quotations`/`import-quotations` 皆是）——動態變價系統的副作用，diff/executor 需知。

---

## 4. 資料形狀（手冊，權威）

### 時間格（time cell）= 定價維度
`price_type`（0=每日均一 / 1=依日期定價）× 場次（無 / 有）→ 4 種情境：
| 情境 | 時間格 |
|---|---|
| 均一價 + 無場次 | 只有一個 `fullday`，所有日期共用 |
| 均一價 + 有場次 | 每場次一格 |
| 依日期定價 + 無場次 | 每個銷售日期一個 `fullday` |
| 依日期定價 + 有場次 | 每日期 × 每場次各一格 |

### 核心 JSONB 欄位（`draft_sku_price` / `draft_sku_cost`）
- `origin_price` JSONB：`{ 場次|"fullday": { "日期": 金額 } }`（原始幣別售價）
- `origin_cost` JSONB：同形狀（供應商報價）
- `fix_price` JSONB：`{ 幣別: { "日期": 金額 } }`（多幣別固定價）
- `official_price` decimal：SKU 官方價（靜態、獨立、選填）
- `bundle_price` JSONB：組合包售價
- **與庫存 `remain_qty` 同家族的巢狀**：外層 key=場次/fullday、內層 key=日期、值=金額。

### 成本設定（`cost-setting`）
- `price_type`：0=每日均一 / 1=依日期定價
- `price_rule_type`：0=首日價 × 天數 / 1=逐日加總（住宿常用）
- 成本制（固定金額，多供應商報價、一次指派一家）vs 佣金制（售價 × 佣金率、只能一家供應商）
- 幣別：售價幣別發佈後可改；成本幣別可改但**會清空既有成本資料**。

### 毛利率（GPM）
`(USD售價 - USD成本) / USD售價 × 100%`；低毛利/負毛利需填理由（`low-gpm-reason` / `negative-gpm-reason`，負毛利需主管審核）。→ 相對調價（「漲價 10%」）的 executor 應先過 `POST gross-margin/availability` 再寫。

---

## 5. 未竟（非阻擋，開工前補即可）

- [ ] **live wire 樣本**：`POST drafts/items/{item}/quotations/search` 的實際 request body + 200 response envelope/JSONB（確認場次/日期鍵名與 envelope 是 `meta.status "100000"`）。本次自主探索取樣受阻：(a) 價格頁 SPA route 非 `cost-price/edit-detail`（404），需走 `search-draft → 商品 → 成本售價 tab`（memory `be2-web-navigation-debug`）；(b) 直接以頁面 token 打 API 被安全政策擋（正確，需人在場或走 UI）。→ 下次有人監督時，開價格頁點「查詢」攔一次即補齊。
- [ ] **modify_user**：沿用通則 = JWT platformId（shelf/inventory 已雙證），價格待實發確認。
- [ ] **draft workflow 發佈語義**：`PUT drafts/product/{prodOid}/workflow` 狀態機（phase0 已記 EDIT→FINALIZED→…）與「調價後是否要自動送審」的產品決策。

---

## 6. 對 `module-onboarding.md` §1 的對應（3b 上車就緒度）

| checklist 項 | 狀態 |
|---|---|
| 讀取現況端點 | ✅ `quotations/search` / `prices`（手冊） |
| 寫入端點 + read-merge-write | ✅ `PUT quotations`（per-date/session）；draft-based 天然可逆 |
| 欄位/形狀 | ✅ origin_price/cost JSONB `{場次|fullday:{日期:金額}}`、official_price、fix_price（手冊） |
| 相對編輯（漲價 X%）語義 | ✅ 可行；需先過 `gross-margin/availability` |
| businessList 動作碼 | ⬜ 待查真實 businessList（仿 shelf/inventory 用 `product.*` 實查） |
| live wire 樣本 | 🟡 §5（不阻擋設計，開工前攔一次） |

→ **factory 判定**：價格域可直接進段②「產」（schema/diff/renderer 靠手冊足夠）；executor 的 live 驗收待 live 樣本 + businessList 動作碼。**建議首發止於 draft、風險最低。**

---

## 附：相關
- 權威手冊：`product-team-docs/Product/系統操作手冊/04-成本售價設定.md`（見 memory `product-team-docs-manual`）
- 庫存契約（同巢狀家族參照）：`sit-write-contracts.md` §inventory
- draft/publish workflow：`phase0-inventory.md` §C 方案域「draft→live 工作流」
