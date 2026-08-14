// Task 7：redirect_uri allowlist——DCR 動態註冊與（後續 Task 8/9）authorize/token 流程共用的
// 唯一防線，防止 open-redirect。刻意用 `new URL()` 解析後對「精確欄位」比對（protocol +
// host/hostname + pathname），而非字串 prefix/regex：字串前綴比對會被 `localhost.evil.com`、
// `claude.ai.evil.com` 這類偽裝 host 繞過（它們確實以合法字串「開頭」，但 URL 解析後 host 完全
// 不同）。允許清單照抄 reference-dev-tools-architecture.md 的兩類：
//   1. Claude 官方 callback：https://claude.ai/api/mcp/auth_callback（完全比對，含 scheme）
//   2. RFC 8252 loopback：http://{localhost|127.0.0.1}[:port]/<任意路徑>——loopback 的安全性
//      來自 host 是本機（攔截風險在 port 監聽者，跟 path 無關），port 與 path 由 client 自訂：
//      Claude Code 用 /callback，mcp-remote（Claude Desktop stdio 代理）用隨機 port +
//      /oauth/callback（live 2026-08-14 被舊的固定 path 規則擋下 DCR，故放寬）。
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  // 用 u.host（含 port）比對 claude.ai，確保帶 port 的偽裝（claude.ai:8443）不會被誤判為相符。
  if (u.protocol === 'https:' && u.host === 'claude.ai' && u.pathname === '/api/mcp/auth_callback') return true
  // loopback 用 u.hostname（不含 port）比對，因為 loopback 允許任意 port；path 不限（見上）。
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
  return false
}
