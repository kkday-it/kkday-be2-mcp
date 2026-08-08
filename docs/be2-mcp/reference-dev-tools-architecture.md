# 參考實作：kkday-development-tools MCP 架構

> 逆向分析自 kkday-it 三個 repo（2026-08-08）。這是**唯一已在 KKday 上線、已對 claude.ai 實戰驗證**的自訂 MCP，be2 MCP 的 OAuth 外殼直接借鏡它。
> **注意：dev-tools 完全沒有串 kkday-auth-service** — 它自己就是認證權威（Google SSO + 自建 Passport + 自建 RBAC）。be2 MCP 的認證內核必須換掉，見 `be2-mcp-auth-design.md`。

## 三個 repo 的分工

| Repo | 角色 |
|---|---|
| `kkday-aws-atlantis/kkday-development-tools/` | Terraform infra（Route53、IAM pod-identity、ECR）— **不是原始碼** |
| `kkday-development-tools/` | 真正的 app 原始碼（Laravel 11 / PHP 8.4） |
| `kkday-k8s-apps/cloud/kkday-development-tools/` | K8s Deployment + `oauth:purge` CronJob |

app 本體是一個內部**開發者自助平台（IDP）**：DB 帳號申請、K8s config manager、RBAC、申請單流程、VibeCode。MCP 只是 VibeCode 模組長出的一根 API 觸手，復用平台的認證與 S3。

## MCP 傳輸層（`app/Http/Controllers/Mcp/` + `app/Mcp/`）

- **Streamable HTTP**，非 stdio。**純手刻 JSON-RPC 2.0，無任何 MCP SDK 套件。**
- 入口：`POST /api/mcp`，掛 `auth:api`（Laravel Passport）middleware。
- `McpController::handle()` 只實作 4 個 method：`initialize` / `ping` / `tools/list` / `tools/call`。protocol version `2025-03-26`。
- `McpToolRegistry` 用一個 `match()` 分派 5 個 tool，回 `{content:[{type:text,...}], structuredContent:{...}}`。

## 認證：自架 OAuth 2.1 外殼（be2 要抄的核心）

Claude client 只會講 OAuth 2.1，dev-tools 用 Passport 架了一層外殼：

1. **Discovery**（`OAuth/MetadataController`）：`/.well-known/oauth-protected-resource`（RFC 9728）+ `/.well-known/oauth-authorization-server`（RFC 8414）。宣告 authorize/token/register endpoint、PKCE `S256`、scope `mcp`、`token_endpoint_auth_methods_supported=none`。
2. **DCR 動態註冊**（`OAuth/RegisterController`，RFC 7591）：`POST /oauth/register` 建 public client（無 secret、PKCE）。
   - `redirect_uri` **allowlist**：`https://claude.ai/api/mcp/auth_callback`（完全比對）+ RFC 8252 loopback（`http://localhost:<port>/callback`、`127.0.0.1`）。
   - `user_id=NULL` 全域 client、每次都建新、不去重。
   - **response 刻意不放 `client_secret` key（連 null 都不行）** — 否則 Claude Code 的 zod schema 型別衝突。
3. **Authorize**：Passport 自動註冊的 `/oauth/authorize`。未登入時丟 `AuthenticationException` → `bootstrap/app.php` handler → `redirect()->guest(login)` → **Google Workspace SSO**（Socialite）。
4. **Token**：PKCE S256 換 access + refresh。
5. 每次 tool call：Bearer token → `auth:api` guard 解出 `PlatformUser`。

## 授權 Gate（`AuthServiceProvider`）

- **inactive user 一律 deny**（涵蓋 Web + MCP 所有查 role 路徑）。
- **stateless fail-closed**：MCP 無 session → 查 DB 拿權限；Web 有 session → 只信登入快取，沒快取即 deny。

## Tool 設計慣例（be2 直接沿用）

- **input 永不接收身分**：S3 key 一律 server 端用「token user 的 email」推導（`emailKey`），input 不收 email。防越權靠 `str_starts_with($key, "share/{emailKey}/")` 前綴比對。
- **每次 tool call 都 audit log**（actor email + tool name）。
- **檔案 bytes 繞過 LLM**：pre-signed PUT 直傳 S3，confirm 階段才驗 size（10MB）+ HTML magic bytes，通過才從 `pending/` CopyObject 到 `share/`。

## 部署

- EKS `cloud` namespace，nginx + PHP-FPM 雙 container，pod-identity 綁 ServiceAccount（IAM 只給 RDS/Route53 唯讀）。
- 對外：Route53 `development-tools.{kkday.com|stage.kkday.com}` → ALB `kkday-eks-rd-tools-public`。
- stage(ap-southeast-1) / prod(ap-northeast-1)，CI 用 Woodpecker。
- `oauth:purge` CronJob 每天硬刪過期 token + ghost DCR client（`passport:purge` 只清 token 三張表、不碰 `oauth_clients`，所以自寫 `oauth:purge`）。
