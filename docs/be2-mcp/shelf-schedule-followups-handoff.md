# 上下架 / 排程 改進 — 新 session 待辦 handoff

> 來源:2026-08-21 面板 demo 驗收時使用者提出的 4 點。**這不是 spec,是接力包。** 走主管線:brainstorming → spec(`docs/superpowers/specs/`)→ agy-peer-review → writing-plans → agy → subagent + TDD。重用既有 `shelf_schedule` / `shelf_toggle` module,勿重造。

## 現況錨點(demo 驗收時的狀態)
- BAA batch-wizard 目前上下架相關只有 **`shelf_schedule`(排程上下架,per-plan reserve_queue)**;`shelf_toggle_product/plan/bundle`(即時上下架)**不在 wizard**,走 `be2_create_changeset` + changeset-panel/確認頁。
- 面板現況欄:shelf_schedule 顯示「排程筆數」、inventory_platform 顯示平台字串——**都沒顯示 is_active 上架/下架**。
- 真 prod_oid:上下架測試商品 **35992**(mid 2247)。

## 4 個待辦

### ① 單次批次只能「全上架」或「全下架」,不可混(不管即時或排程)
- **需求**:一次 batch 操作的 target 方向必須一致(全上 or 全下),禁止同批混上下。
- **現況**:目前**未強制**——shelf_schedule 的「預設時間套用」可對不同列套不同 status(上架/下架/取消),shelf_toggle 的 items 也可帶混合 target_is_active。使用者 demo 時剛好沒混,但系統沒擋。
- **要做**:
  - `validate` 加「同一 change-set 內方向一致」檢查(混合 → INVALID_ITEMS)。
  - UI 防呆:整批用**單一方向選擇**(radio:上架/下架),而非逐列可各自設向。

### ② 商品層上下架(不只方案層)
- **需求**:能「整個商品上/下架」(一鍵全商品),不只逐方案。
- **現況**:`shelf_toggle_product`(整商品 `PUT product-configs/{oid}/switch`)module 已存在,但**沒接進 wizard**;wizard 只做 plan/schedule 粒度。
- **要做**:wizard 加「商品層」選項(接 `shelf_toggle_product`,或 batch 帶該商品所有方案);排程層若也要商品層,需確認 be2 是否支援商品層 reserve。

### ③ 面板要顯示當前「上架/下架」狀態
- **需求**:每個商品/方案列顯示「目前:上架 / 下架」,操作前看得到現況。
- **現況**:`batchView` 的 `BatchPlan` **已帶 `is_active`**(從 package-configs 讀),只是面板現況欄沒呈現它(顯示的是排程數/平台)。
- **要做**:`renderPlanTable` 加「現況:上架/下架」欄(色點+文字);shelf 相關 action_type 都顯示 is_active。低工(資料已在手)。

### ④ 排程可「個別編輯」單一筆,不只取消
- **需求**:設了 3 筆排程,發現中間一筆設錯 → 能**單獨編輯那一筆**(改時間/方向),不必整組重來。
- **現況(使用者印象正確)**:`shelf_schedule` 的 reserve_queue 是**整組 full-replace**;UI 只能「加入(預設時間套用)」+「取消排程(清空整組)」。**沒有 per-entry 編輯**;change-set 層級可「取消(cancelled)」但不能「編輯」。
- **要做**:
  - UI:step1/檢視頁列出既有 queue **逐筆**,每筆可**編輯/刪除**。
  - executor:仍是 full-replace 寫回(be2 契約),但 UI 先讀現有 queue → 讓使用者改單筆 → 組新 queue 寫回(等效個別編輯)。
  - 確認「編輯已批准的排程」語義:目前批准後只能 cancel;若要改,是否走「取消舊的 + 建新的」還是支援 reschedule。

## 建議切法
- ①③ 較小(validate + UI 呈現),可先做;②④ 較大(新粒度 / per-entry 編輯 UI)。
- 可能一份 spec 涵蓋「上下架 wizard 強化」(①②③)+ 另一份「排程逐筆編輯」(④),或合併。由 brainstorming 決定。
- 驗收沿用 dev panel(`/dev/panel/batch-wizard?action_type=...&prod_oids=35992`)+ 真寫入走有寫權的商品(35992 的 shelf switch 此帳號 403,需對的商品/授權——見 `sit-write-contracts.md`)。

## 相關檔
- module:`src/modules/product/shelfSchedule/*`、`src/modules/product/shelfToggle/*`
- 面板:`src/ui/batch-wizard.ts`(renderPlanTable / renderDefaultTimeBar / diff 卡)
- 讀取:`src/tools/batchView.ts`(`BatchPlan.is_active` 已有)
- 契約:`docs/be2-mcp/sit-write-contracts.md`
