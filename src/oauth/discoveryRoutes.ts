import express from 'express'

// Task 6：OAuth 2.1 外殼的第一步——discovery。照抄 kkday-development-tools 的做法
// （見 docs/be2-mcp/reference-dev-tools-architecture.md）：RFC 9728 protected-resource
// 讓 client 找到 authorization server，RFC 8414 authorization-server metadata 宣告
// PKCE S256 + public client（token_endpoint_auth_methods_supported=['none']）。
// 兩支皆公開（不掛 bearer 驗證），單純回靜態 JSON。
export function buildDiscoveryRouter({ baseUrl }: { baseUrl: string }): express.Router {
  const r = express.Router()
  r.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  })
  r.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({ resource: baseUrl, authorization_servers: [baseUrl] })
  })
  return r
}
