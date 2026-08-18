# Factory 輸入副本 — bundle 上下架（自 ~/Downloads/ENDPOINTS.md 複製，2026-08-18）

## Hosts
| Purpose | SIT |
|---|---|
| Product API | `https://api-gateway-220.sit.kkday.com/product/api/v1` |

**成功契約**：HTTP 200 且 `meta.status` = `100000`（product API）。

## Onshelf/offshelf — bundle（product API）
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/products/{prodOid}/bundle-package-configs` | read bundle (組合方案) state |
| `PUT` | `/products/{prodOid}/bundle-package-configs` | flip bundle `is_active` now |
