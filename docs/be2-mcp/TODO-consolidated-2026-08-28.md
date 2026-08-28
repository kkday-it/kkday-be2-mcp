# be2 MCP — 待辦大盤 (2026-08-28 梳理)

> 取代式更新前一份 `TODO-consolidated-2026-08-21.md`(該份的 cloud-ready 項已於本次完成)。
> 狀態快照:main = `1906bdc`(含 cloud-ready Phase A + workbench 已整合);開著的 PR = **#8**(workbench 面板寬度,reviewed 乾淨待 merge)。

---

## ✅ 這波 session 完成(2026-08-27 ~ 28)

- **cloud-ready Phase A**:spec + plan(皆 agy APPROVED)→ 9-task subagent-driven TDD 實作 → 驗收(本機容器 smoke + live OAuth 身分貫穿到真實 SIT + Playwright 面板)→ 與 workbench 整合(merge main)→ 雙軸 code review + 修正 → **merged 進 main(PR #7)**。內容:bind `BE2_MCP_BIND_HOST`、public URL `BE2_MCP_PUBLIC_BASE_URL`、Host 白名單、`/readyz`、SIGTERM graceful(含長連線 drain / 非乾淨關機 exit(1))、tsc production build → `dist/src/index.js`、multi-stage Dockerfile(node:22-bookworm-slim)、Node 釘 22、runbook、`ci` 納入 build。
- **workbench 面板寬度自適應**:`.wrap` 760px → `min(1360px,100%)` + 註解同步。雙軸 + Codex(gpt-5.5)review 皆 0 finding。**PR #8 open,待 merge。**
- **cerebrum-gateway 接入**:討論摘要整理進 `cerebrum-gateway-integration-handoff.md` 頂部(給 RD 主管的拍板議題),待跨團隊會議。
- memory:`agy-headless-permission-wall`、`oauth-invalid-request-stale-dcr-cache` 兩條已存。

---

## 🔜 立即 / 小(可即刻收)

### T1. Merge PR #8(workbench 寬度)
Reviewed 乾淨(Claude 雙軸唯一過時註解已修 + Codex gpt-5.5 0 finding),ci 678 綠。待人拍板 merge → main。

### T2. Housekeeping
- repo root 有 5 個 Playwright 驗證截圖 `.png`(`wb-820/1440/1728`、`workbench-merged-sit220`、`workbench-wide-1280-empty`)未追蹤 → 刪除或加 `.gitignore`。
- 4 個 pre-existing untracked 文檔定歸屬:`cerebrum-gateway-integration-handoff.md`(**已含 RD 討論摘要,建議 commit / 分享**)、`mcp_hybrid_design_doc.md`(見 T9,且 **root 與 be2-mcp 兩份重複、去重**)、`mcp_poc-reference.md`。

---

## 🟡 Carried-forward(原始 handoff,尚未動)

### T3. framework #3 — registry 登記
main 已有 `PROJECT.yaml`(解鎖)→ 對 `kkday-vibe-framework` 開 PR,`registry/registry.yaml` 加一行 `kkday-it/kkday-be2-mcp`。獨立小任務、最快能收。

### T4. framework #8 — appconfig/appsecret 貢獻
審 `framework-contrib-appconfig-appsecret.md` 草稿 + 對 owner 口徑 → 開 PR。

### T5. PR #6 review 債(已在 main)
- 刪殘留 `src/tools/openBatchWizard.ts` + `src/tools/openAnnouncementWizard.ts`(`be2_open_workbench` 已取代舊入口;**確認 app.ts 無註冊、無 import 後**刪)。
- `renderShelfCard` / `renderDiffCard` 抽共用;`invKey()` helper;`S.func` / `S.invMode` switch 收斂。
- 補 eval 案例:「混方向」(上下架同批被擋)、「公告 ingest」。

---

## 🔵 較大軌道(需前置 / 跨團隊 / 走完整管線)

### T6. cerebrum-gateway 接入(be2-mcp 當 MCP gateway 聚合 cerebrum)
**卡三個 gate**:①**Ownership / on-call**(平台級,RD 主管/組織拍板;不解不正式化)②**治理邊界**(cerebrum 寫入無人工批准 → 建議 v1 只代理讀取/preview,與 cerebrum team 對齊)③**elicitation spike**(工程可先做:驗 Claude Code/Desktop 對 `elicitation/create` 支援度)。三者到位再 grill-me → brainstorming → spec → agy → writing-plans → impl。工程細節見 `cerebrum-gateway-integration-handoff.md`(身份斷言 RS256、動態工具聚合 `cerebrum_` prefix、絕不轉發 refreshToken、放 `src/core/gateway/`)。

### T7. cloud-ready 上 stage EKS(live 部署)
Phase A 程式已 merge 但**尚未部署**。依賴:DevOps 部署 + `STAGE_AUTHSVC_SERVICE_KEY`(repo 目前缺,向 auth-service team 申請)+ stage 寫入權限。驗收 = 員工用 Claude Code/Desktop 對 stage MCP 完成 OAuth 登入 + read + change-set 批准 e2e。文件:`cloud-ready-phaseA-runbook.md`、`deploy-architecture.md`。

### T8. cloud-ready Phase C(HA / 多副本)
對齊 main 上 `docs/superpowers/specs/2026-08-26-be2-mcp-cloud-ready-migration-design.md`(agy APPROVED 的廣義遷移設計):SQLite → PostgreSQL(store 抽象 + 雙後端;注意 better-sqlite3 同步 → pg async 是全鏈路重構)、in-process 鎖(refresh single-flight / inventory mutex / MCP session)→ Redis 分散式鎖、scheduler in-process poller → HTTP endpoint(CronJob 觸發)、forward-only migration runner。Phase A 是第一片(單副本);解開 `replicas=1` 才進 Phase C。

### T9. DCR / CIMD 雙模相容(OAuth 外殼演進)
- **現況**:OAuth 外殼 **DCR-only**(discovery 只宣告 `registration_endpoint`;`src/` 無任何 `client_id_metadata_document*`)。設計文件 `mcp_hybrid_design_doc.md` 存在但 **0 實作**(且 root 與 be2-mcp 重複兩份、需去重)。
- **內容**:MCP client 認證 DCR → **CIMD**(Client ID Metadata Documents:client_id 是指向 metadata 文件的 URL、免預先註冊、stateless)。雙模並存:discovery 同時宣告 `registration_endpoint` + `client_id_metadata_document_supported`,adapter pattern 統一 authorize/token 對 DCR-client 與 CIMD-client 的處理。
- **價值**:(a) 未來 MCP client 走 CIMD;(b) **根治 `invalid_request` 那類坑**(CIMD client_id 是穩定 URL、不靠 per-server DCR 註冊,免「快取舊 client_id vs 空 db」錯配 + DCR ghost-client 累積 + `oauth-purge` 負擔,見 memory `oauth-invalid-request-stale-dcr-cache`)。
- **前置/流程**:informal design → 轉正式 spec(brainstorming→spec→agy)或若設計夠實直接 writing-plans→agy→impl;動工前先去重 + 收進版控。與 T6 同屬 OAuth 外殼層,可考慮排序。

---

## 🐙 GitHub Issues(open #1–#4,2026-08-22 建,多自 mcp_poc 遷移)

### I-#4. 防呆:mid → prod_oid 解析(自足、可即做 ⭐)
be2-web 網址數字是 **mid**、product API 吃 **prod_oid**;使用者/agent 複製網址 mid 當 prod_oid → 404 not_found,且 **mid==oid 時剛好會過**(如 2358)→「時好時壞」最難查。**策略 A(推薦、不猜)**:工具輸入分 `prod_mid?` / `prod_oid?` 擇一必填;給 mid 走共用 `resolveProdOid(mid)`(打 `drafts/products/mid-{mid}/info` 換 canonical oid),**所有吃商品的工具共用**(find_products / get_product_plans / get_inventory_settings / batchView / create scope / open wizard);canonical oid 才進 `readOids`;錯誤訊息提示「可能是 mid 非 oid」。**非外部阻擋、價值高、獨立 → 快贏候選**。

### I-#1. refactor:batch-wizard 逐型 switch → WizardDescriptor(≈ T5)
`src/ui/batch-wizard.ts` 對 `actionType` 逐型分支散在 **17 處**(PR #19 Standards 軸標 Repeated Switches / Divergent Change)。用已存在的 `WizardDescriptor`(`src/core/changeset/module.ts` 的 `wizard?`)收斂成介面方法(`renderStatusCell`/`renderDiffCard`/`postExecuteVerify`/`stepExtras`/`rowDisabled`/`onRowToggle`),面板一律 `WIZARDS[actionType].xxx()`。驗收:`grep -c "actionType === '"` 顯著下降(理想 0)、加新型面板零改。**與 T5 的 switch 收斂債重疊,更正式**。(註:workbench 已統一入口,需先確認 batch-wizard.ts 與 workbench.ts 的關係再動。)

### I-#2. live-write 真 200 gate(= T7 的寫入驗收哩)
inventory / announcement / shelf 各跑一次**真 200 寫入 e2e**(建 change-set→批准執行→be2 讀回)+ 塊B 排程「建→到點自動執行→讀回」+ SIT 淨零測試(改值→還原)。**外部授權阻擋**(非程式缺陷,draft-only + 契約已驗):庫存 be2-220 AU9403(per-URI verify 缺 grant,stage 曾真 200)、公告 svc-b2c 403(從未 live 寫)、上下架視商品 owner(be2-web 真請求已 Playwright 攔驗)。→ 併入 **T7**(等授權/stage 解鎖)。

### I-#3. announcement POST wire body 待驗(#2 子項)
`src/modules/announcement/create/executor.ts#toBody` 目前是 §6.2 表單語義 best-guess(標 UNVERIFIED),從未對 svc-b2c 真 create。待 svc-b2c 授權解了,建一筆 `isEnabled=off` 拋棄式 → Playwright/probe 攔真 request → 校正欄位鍵名 / `prodOids` array-vs-csv / per-lang content 形狀 / PATCH merge-vs-replace。draft-only、爆炸半徑小、fix-forward。**卡 #2 同一個 svc-b2c 403**。

---

## 建議優先序

1. **即刻**:merge PR #8(T1)+ housekeeping(T2)。
2. **快贏(獨立、非外部阻擋)**:framework #3 registry(T3,最短)、**issue #4 mid→prod_oid 防呆**(價值高、走 TDD 一支共用 resolver)。
3. **價值大但需前置**:T7 + issue #2/#3(stage 部署 + live-write 真 200,等 DevOps/service key/svc-b2c 授權)、T6(cerebrum,等 RD 主管拍 ownership + 治理邊界);T9(DCR/CIMD)與 T6 同層可一起規劃。
4. **背景清償**:T5 review 債 + issue #1(batch-wizard switch→WizardDescriptor)、T4 framework #8。
5. **未來大工程**:T8 Phase C HA。
