# be2 MCP 模組型錄 (Module Catalog)

本型錄列出目前所有已註冊的 `action_type` 及其關鍵行為約定（來源：`src/modules/**/module.ts`，欄位值以 code 為準）。

| Action Type | Item Shape 摘要 | ItemKey 形狀 | Authz Codes & onMissing | Diff Hash 綁定 (Stale Guard) | Executor 形狀 | Renderer 警語 | Wizard |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `shelf_toggle_product` | `prod_oid`, `target_is_active` | `prod_oid`（帶 `pkg_oid` 時 `prod_oid:pkg_oid`） | `product.product-sale-status.update`<br>onMissing: `block` | 綁現況 (`current_is_active`) | 逐 prod 分組序列、group 失敗隔離 | 名稱為 be2 內容（untrusted）、以 oid 核對 | 無 |
| `shelf_toggle_plan` | `prod_oid`, `pkg_oid`, `target_is_active` | `prod_oid:pkg_oid` | `product.product-sale-status.update`,<br>`product.bundle-package-sale-status.update`<br>onMissing: `block` | 綁現況 (`current_is_active`) | 逐 prod 分組序列（單 PUT 帶多 pkg）、group 失敗隔離 | 同上 | 無 |
| `inventory_setting` | `item_oid`, `supplier_oid`, `op`, `quantity`, `dates` | `item_oid:supplier_oid` | `product.product-inventory.update`<br>onMissing: `block` | `set` 綁現況 (`current`)；<br>`adjust` 綁操作 (`dates`/`quantity`)——live drift 不作廢批准 | 逐 item 序列 + in-process per-key mutex + busy-guard 輪詢 | **紅字高風險**：庫存寫入立即影響前台可售並清 cache | 無 |
| `inventory_platform` | `item_oid`, `supplier_oid`, `target`, `affected_pkgs` | `item_oid:supplier_oid` | `product.product-inventory.update`<br>onMissing: **`warn`**（ACTION_CODE_UNVERIFIED，權威檢查在 gateway /verify） | 綁現況 (`current`) | 批次（Promise.allSettled，item×supplier 獨立） | 寫入單位是 item×supplier、方案清單僅展示；`affected_pkgs_unverified` 逐列註記 | **有** |
| `shelf_schedule` | `prod_oid`, `pkg_oid`, `queue` | `prod_oid:pkg_oid` | `product.product-sale-status.update`,<br>`product.bundle-package-sale-status.update`<br>onMissing: **`warn`**（同上） | 綁現況 (`current_queue`，排序後 hash) | 逐 prod 分組（單 PUT 帶多 pkg、reserve_queue 整組取代） | **紅字高風險**：原排程整組取代、時間皆 UTC | **有** |
| `shelf_toggle_bundle` | `prod_oid`, `bundle_pkg_oid`, `target_is_active` | `prod_oid:bundle_pkg_oid` | `product.bundle-package-sale-status.update`<br>onMissing: `block` | 綁現況 (`current_is_active`) | 逐 prod 分組、read-merge-write | 名稱 untrusted、以 oid 核對 | 無 |
| `announcement` | `prod_oids[]`, `name`, `is_enabled`, `start_time`, `end_time?`, `langs[]`, `contents[]` | `announce:name:prod_oids(sorted):start_time` | `product.announcement.update`<br>onMissing: **`warn`** | target-only（create 無 live current）：綁 name/prod_oids/start_time/end_time/is_enabled/langs/**contents**；`existing_count` 不綁 | 逐筆 POST（**module-local svc-b2c client**，非 core GatewayClient；`metadata.status '0000'` 判定、`x-api-key`+`user-uuid`=platformId）、403→per-item failed | **紅字高風險**：公告即時對前台顯示；start/end 伺服器端雙時區（UTC+GMT+8）、per-lang 內文預覽 | **有**（獨立入口 `be2_open_announcement_wizard` + 專用 `announcement-wizard.html`，非 batch grid） |

---
**💡 開發須知**：新增 module 請照 [`module-onboarding.md`](./module-onboarding.md)；驗收標準 = 不碰 `src/core/`。

> `shelf_toggle_bundle` 為 **Module Factory 首發驗證產物**（2026-08-19，stage 商品 19513 契約）——證明 factory 三段端到端可動。live 寫入 PENDING（PUT body 未對 stage 實測）。
