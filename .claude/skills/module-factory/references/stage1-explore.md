# 段① 探索

**執行者：Claude**（agy 跑不了 shell/瀏覽器）。目標：把一個新 domain 的 API 契約從黑箱變成可稽核的契約報告，並判定 GATE 1 走向。

## 第一步：輸入複製動作（spec §1）

外部設計文件（如 `~/Downloads/ENDPOINTS.md`）不是 repo 檔——**先複製進 repo** 當可稽核起點：

```bash
cp <外部輸入文件> docs/be2-mcp/factory-input-<domain>.md
```

之後段①/② 的一切引用都指 repo 內副本，不依賴 repo 外的幻影路徑。

## 三個探索 agent（Claude 並行執行）

### endpoint-prober — 攔真實請求

目標：host / path / 必要 header / 成功 envelope。做法（本專案 announcement 探索的實證流程）：

1. `.env` 取 SIT 帳密（`AUTH_email`/`AUTH_pwd`）；**密碼經瀏覽器 evaluate 直接注入 DOM，絕不進對話文字、絕不落檔**（落檔會被 credential classifier 擋）。
2. playwright 登入 be2-220（`https://be2-220.sit.kkday.com/`）→ 導到目標功能頁。
3. `browser_network_requests` filter 目標 API → `browser_network_request <index>` 抽 request/response header（即使回 502/403，request header 仍在）。
4. 敏感值（x-api-key 等）**只寫進 `.env`**（gitignored），契約報告以 `<存於 .env XXX>` 佔位。
5. **也可繞過登入**：若功能是純 API，用 `.env` 的 be2 token（或 store 內 token）+ curl 直打 gateway 驗證——本專案 announcement 就用這條交叉驗證 token 種類差異（S2S vs web-session）。

### bundle-miner — 逆向授權碼

前端 bundle 內埋著 businessList 授權碼。做法：

```bash
curl -s <前端頁> | grep -oE 'src="[^"]+\.js"'      # 找 bundle
curl -s <bundle.js> -o /tmp/b.js
grep -oE 'product\.[a-z-]+\.[a-z]+' /tmp/b.js | sort -u   # businessKey/授權碼
```

寫進契約報告「businessList 授權碼」節（讀=`.query`、寫=`.update` 類）。

### reference-reader — 判定最像的現成格

讀 `src/modules/product/*/`（shelfToggle/inventorySetting/inventoryPlatform/shelfSchedule）四個現成 module，判定新標的「最像哪個」——依據：寫入形狀（flip 布林 vs 數量 vs 佇列取代）、host/envelope、單筆 vs 批次。寫進契約報告「參考格對照」節（每格指定 `<最像的>/​<同名檔>` 當 stage② 範本）。

## 產物 → GATE 1

產 `docs/be2-mcp/sit-<domain>-contract.md`（照 `contract-report-template.md` 七節）。**GATE 1 判定看報告的兩欄**：

- 「item 欄位形狀」節填實與否 → 決定**欄位 gate**（未填 → block 段②）。
- 「未解 gate 項」節有無授權黑箱 → 決定**授權 gate**（有 → executor-only PENDING）。

用 `AskUserQuestion` 把判定攤給人確認後才進段②（SKILL.md 的 GATE 1 判定準則）。
