# be2-mcp 需求來源（Jira 用）

> 專案：`kkday-it/kkday-be2-mcp`｜申請人：lance.chien｜組別：Harness 工程部｜2026-09-03

## 需求類型

內部工具／技術治理（風險收斂），非商業功能需求。

## 背景（為什麼要做）

1. **vibe coding 風險收斂**：現在多位同仁各自用 AI 工具（Claude Code / Desktop 等）寫腳本直接對 be2 操作，工具分散、無統一身份驗證、無寫入防護、無稽核軌跡。需要一個公司治理下的收斂平台。
2. **be2 批次操作痛點**：商品上下架、庫存、排程等批次任務目前靠人工在 be2-web 逐筆點擊，高頻高工時（例：單一使用者庫存批改 1.18 萬次/月）。
3. **企業標準缺口**：既有自製工具繞過 kkday-auth-service，身份與授權不可追溯。

## 目標（做什麼）

建置 **be2 MCP server**（`kkday-be2-mcp`）：讓員工透過 Claude（Code / Desktop）以自然語言完成 be2 商品批次任務，全程符合企業標準：

- **身份貫穿**：認證一律經 kkday-auth-service（OAuth 2.1 外殼 + be2-auth 登入），身分由 token 推導，不自建 RBAC，授權以 businessList + `/verify` 為準。
- **draft-only 寫入**：agent 不直接寫入；所有變更收斂成 change-set，人工在確認頁／精靈面板批准後才執行。
- **全鏈路稽核**：每次 tool call 與每筆執行 append-only audit log（無 token 明文）。

## 本次申請範圍（infra）

部署至 EKS：SIT（sit-220）→ Stage → Production（prod 先限定申請人與特定 AM dry-run）。需獨立 PostgreSQL、Redis（多副本鎖）、dkron（每日 oauth-purge）、config-manager、egress 白名單（auth-service + be2 gateway 443），不開公網。

## 現況（已完成的驗證）

- SIT be2-220 已完成 read / change-set write / 批次精靈全鏈路 live 驗收（470+ 自動化測試綠）。
- 認證設計借鏡已上線的 kkday-development-tools OAuth 外殼，內核換 kkday-auth-service（設計文件已過同儕審查）。

## 預期效益

- 批次操作工時大幅下降（自然語言 → 批次 change-set 一次批准執行）。
- vibe coding 各自為政的風險收斂到單一治理平台（身份、授權、稽核、寫入防護統一把關）。
