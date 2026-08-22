# Endpoint inventory

The complete set of BE2 endpoints the app can reach. Nothing outside this list
is callable — the Tauri HTTP scope (`capabilities.default.json`) blocks any host
not named below, and the app only implements these paths.

**This is the surface to (a) security-sanity-check and (b) get a heads-up about
when it changes.** A change to any path, method, envelope, or payload shape below
can quietly break the app.

## Hosts (base URLs)

| Purpose | Production | SIT |
|---|---|---|
| Product API | `https://api-gateway.kkday.com/product/api/v1` | `https://api-product.sit.kkday.com/api/v1` |
| Announcement API (svc-b2c) | `https://api-gateway.kkday.com/svc-b2c/api/v1` | `https://api-gateway.sit.kkday.com/svc-b2c/api/v1` |
| Auth / login | `https://auth.kkday.com`, `https://be2.kkday.com` | `https://auth.sit.kkday.com`, `https://be2.sit.kkday.com` |
| Local token helper (optional, opt-in) | `http://localhost:3456` | same |

**Success contract:** HTTP 200 **and** envelope status — `meta.status` `100000`
for the product API, `metadata.status` `0000` for the announcement API. Anything
else is treated as a failure and reported verbatim; the app never auto-retries.

---

## Auth (all hosts above, login flow)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `{auth}/api/v1/auth/be2/login` | account/password → authorization code |
| `GET` | `{be2}/v2/api/v1/auth/login-authorization-code/{code}` | code → access/refresh token pair |
| `PATCH` | `{auth}/api/v1/refresh-token/{refreshToken}` | rotate the token pair |

## Onshelf / offshelf (product API)

| Method | Path | Used by | Purpose |
|---|---|---|---|
| `GET` | `/products/{prodOid}/package-configs` | both | list packages + live `is_active` + any reserve queue |
| `PUT` | `/products/{prodOid}/package-configs/reserve-active` | scheduled | schedule on/off; one call per product, all its packages |
| `PUT` | `/products/{prodOid}/package-configs` | instant | flip package `is_active` now |
| `GET` | `/product-configs/{prodOid}/switch` | instant | read product-level active state |
| `PUT` | `/product-configs/{prodOid}/switch` | instant | flip product `is_active` now |
| `GET` | `/products/{prodOid}/bundle-package-configs` | instant | read bundle (組合方案) state |
| `PUT` | `/products/{prodOid}/bundle-package-configs` | instant | flip bundle `is_active` now |
| `GET` | `/drafts/products/{prodOid}/info` | display | product name + `prod_mid` for the UI link (non-fatal) |

## Inventory platform (product API)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/products/{prodOid}/packages` | enumerate packages + supplier mapping (`show_supplier=1`) |
| `GET` | `/items/{itemOid}/basic-info` | current inventory setting + supplier configs |
| `GET` | `/items/{itemOid}/spec` | SKU names |
| `PUT` | `/item-configs/{itemOid}/inventory-setting` | 基本設定 mode (control_type / inventory_type) |
| `PUT` | `/items/{itemOid}/supplier-configs/{supplierOid}/inventory-setting` | platform switch (BE2 / SCM / external booleans) |

## Scheduled inventory — quantity (product API, beta)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/items/{itemOid}/basic-info` | mode + SKUs (the only read the create flow needs) |
| `POST` | `/items/{itemOid}/inventories/search` | pre-fire snapshot of current `remain_qty` |
| `PUT` | `/items/{itemOid}/inventories/{supplierOid}/quantity` | set quantity (`modify_type` = set/overwrite) |
| `GET` | `/items/{itemOid}/inventories/{supplierOid}` | *(implemented but gateway-restricted — effectively unused)* |

## Product announcement (svc-b2c)

Additionally requires a fixed frontend `x-api-key` header + a `user-uuid` header
(both mirror the BE2 admin frontend; the key value is omitted from this folder).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/product/announcement` | list rows (`page`/`perPage`/`prodOids` query params) |
| `POST` | `/admin/product/announcement` | create one row spanning all selected `prodOids` |
| `PATCH` | `/admin/product/announcement/{announcementOid}` | partial update *(plumbed, unused in practice)* |
