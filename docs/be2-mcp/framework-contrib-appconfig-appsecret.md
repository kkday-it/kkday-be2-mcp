# 框架貢獻草稿 #8 — 把平台 APP CONFIG / APP SECRET 慣例補進 `vibe-cloud-ready-spec.md §2.2`

> **狀態：草稿，待審 → 對框架/平台 owner 對口徑 → 才對 `kkday-it/kkday-vibe-framework` 開 PR。本檔在 be2-mcp repo，不碰外部 repo。**
>
> 動機：平台 config-manager 的實際 UI 把每個服務的 env 拆成 **APP CONFIG（非機密）** 與 **APP SECRET（機密）**
> 兩個 dotenv 頁籤（多個既有服務截圖佐證：AI `cerebrum`、Laravel `api-b2c`）。但框架 `vibe-cloud-ready-spec.md
> §2.2` 目前只有**抽象三分類表**，沒對到這兩個頁籤與 `APP_*` 房規命名 → AI agent 照現行 §2.2 產出的
> `.env.example` 不會自動對齊平台填法。本貢獻把「平台落地形狀」補上。

---

## 建議：在框架 `vibe-cloud-ready-spec.md §2.2` 三分類表**之後**加入以下內容

### 2.2.1 平台落地形狀：兩個頁籤（APP CONFIG / APP SECRET）

平台 config-manager 把每個服務的環境變數存成**兩個 dotenv 頁籤**，你的 `.env.example` 三分類直接對映過去：

| §2.2 三分類 | 平台頁籤 | 注入時機 | 說明 |
|---|---|---|---|
| runtime 非機密（log level、bucket 名、region、feature flag…） | **APP CONFIG** | k8s env（非 Secret） | 明碼、可版控可見 |
| build-time 公開值 | **APP CONFIG** | build `--build-arg`（或同 runtime 非機密處理） | 前端 bundle 才需要；能挪 runtime 就挪 |
| runtime secret（DB 帳密、API key、`APP_KEY`、`*_TOKEN`…） | **APP SECRET** | **k8s Secret**（config-manager 注入） | 永不進 image、永不 commit |

> 一句話：**APP CONFIG = 明碼設定；APP SECRET = 機密**。`.env.example` 每個值標好屬哪一頁籤，平台團隊照著貼進兩個 tab。

### 2.2.2 房規命名（跨服務標準 `APP_*` 鍵）

平台既有服務（Laravel / Python 皆同款）用這組標準命名，新專案**沿用**以利平台工具鏈與可讀性：

**APP CONFIG（非機密）常見鍵**
| 鍵 | 用途 | 例 |
|---|---|---|
| `APP_NAME` | 服務名 | `api-b2c` |
| `APP_ENV` | 環境選擇器 | `sit` / `stage` / `prod` |
| `APP_PORT` | 監聽埠（綁 `0.0.0.0`） | `8000` |
| `APP_URL` / `APP_BASE_URL` | 對外 base URL（OAuth callback / 絕對連結由它組） | `https://<app>.sit.kkday.com` |
| `APP_DEBUG` | debug 開關 | `false` |
| `APP_LOG_PATH` | log 路徑（容器一律搭配 stdout） | `/data/logs/application/` |
| `LOG_CHANNEL` | log 輸出通道 | `stdout` |
| `LOG_LEVEL` | log 等級 | `debug` / `info` |
| `DB_HOST/PORT/USER/NAME` | RDS PostgreSQL 連線（非機密部分） | `postgresql-*.sit.kkday.com` |
| `REDIS_HOST/PORT/INDEX` | valkey/Redis（cache/session） | `valkey8.sit.kkday.com` |
| `AWS_REGION` / `AWS_BUCKET` | S3（憑證走預設鏈，不放 key） | `ap-southeast-1` |

**APP SECRET（機密）常見鍵**
| 鍵樣式 | 用途 |
|---|---|
| `APP_KEY`（`base64:…`） | 框架/Laravel 加密金鑰 |
| `DB_PASSWORD` | RDS 密碼 |
| `*_API_KEY` / `*_TOKEN` / `*_SECRET` | 第三方（OpenAI/Google/Slack…）金鑰 |
| `API_<SERVICE>_*` | 內部服務 S2S 金鑰（如 `API_AUTH_SERVICE_READ` / `API_AUTH_SERVICE_REFRESH`、`API_PRODUCT_SERVICE_*`、`API_GATEWAY_*`） |

> AWS 憑證：**不放** `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`（用 IAM role + SDK 預設憑證鏈，符 spec #9）。平台既有服務即使列出這兩格也是寫 `"REF FROM ENV"` 佔位、由平台注入，不填實值。

### 2.2.3 `.env.example` 範本（照兩頁籤 + 三分類註記）

```dotenv
# ============ APP CONFIG（非機密，明碼；貼進平台 APP CONFIG 頁籤）============
APP_NAME=<service-name>          # runtime 非機密
APP_ENV=sit                      # runtime 非機密｜環境選擇器 sit|stage|prod
APP_PORT=8000                    # runtime 非機密｜綁 0.0.0.0
APP_URL=https://<app>.sit.kkday.com   # runtime 非機密｜對外 base URL（OAuth callback/絕對連結由它組）
APP_DEBUG=false                  # runtime 非機密
LOG_CHANNEL=stdout               # runtime 非機密
LOG_LEVEL=info                   # runtime 非機密
DB_HOST=postgresql-<x>.sit.kkday.com  # runtime 非機密
DB_PORT=5432                     # runtime 非機密
DB_USER=<app_user>               # runtime 非機密（帳號名非機密；密碼在 SECRET）
DB_NAME=<db>                     # runtime 非機密
REDIS_HOST=valkey8.sit.kkday.com # runtime 非機密（若用 cache/session）
AWS_REGION=ap-southeast-1        # runtime 非機密
AWS_BUCKET=<bucket>              # runtime 非機密（憑證走 IAM role，不放 key）

# ============ APP SECRET（機密；貼進平台 APP SECRET 頁籤，config-manager 注入 k8s Secret）============
APP_KEY=base64:<...>             # runtime secret｜框架加密金鑰（若框架需要）
DB_PASSWORD=<...>                # runtime secret
API_AUTH_SERVICE_READ=<...>      # runtime secret｜內部 S2S（依實際 scope 命名）
# API_<SERVICE>_*=<...>          # runtime secret｜其他內部服務金鑰
# OPENAI_API_KEY=<...>           # runtime secret｜第三方（用到才列）
```

---

## 待與框架/平台 owner 對口徑（開 PR 前）

1. **邊界口徑**：哪些鍵算 APP CONFIG vs APP SECRET 是否有硬規（例如 `DB_USER` 算非機密、`DB_PASSWORD` 算機密——一般共識，但請確認平台是否有更嚴口徑，如帳號名也視為敏感）。
2. **`APP_KEY` 是否強制**：Laravel 服務有 `APP_KEY`，非 Laravel（如 be2-mcp Node、Python）不一定需要——spec 要不要把它標成「框架依賴才需要」。
3. **命名對映**：內部 S2S 金鑰平台用 `API_<SERVICE>_*`（如 `API_AUTH_SERVICE_READ/REFRESH`），既有專案的自訂命名（如 be2-mcp 的 `*_AUTHSVC_SERVICE_KEY`）要不要在 spec 建議統一收斂到 `API_*`。
4. **落點**：加在 `vibe-cloud-ready-spec.md §2.2` 之後，還是另開 `docs/platform-config-manager.md`？順帶更新 `vibe-project-template/.env.example` 用這套命名。

## 附：這對 be2-mcp 自己的意義
be2-mcp 遷移 spec §3.6 的「`.env.example` 三分類 + `APP_*` compat」正是這套慣例的落地；本貢獻是把 be2-mcp 要遵守的東西**反饋成框架通則**，讓後續 vibe 專案一開始就對齊平台兩頁籤。
