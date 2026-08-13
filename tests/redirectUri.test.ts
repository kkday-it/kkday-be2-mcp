import { describe, it, expect } from 'vitest'
import { isAllowedRedirectUri } from '../src/oauth/redirectUri.js'

// Task 7：open-redirect 防禦——DCR 的 redirect_uri allowlist 是唯一防線，故驗證邏輯必須是
// 「new URL() 解析 + 精確欄位比對」，不可用字串 prefix/naive regex（否則 `localhost.evil.com`
// 這種變形會被字串前綴誤判為合法）。以下測資涵蓋合法值與常見繞過手法。
describe('isAllowedRedirectUri', () => {
  it('放行 claude.ai callback + loopback（localhost/127.0.0.1，任意 port，路徑須為 /callback）', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isAllowedRedirectUri('http://127.0.0.1:54321/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost:8999/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://127.0.0.1/callback')).toBe(true)
  })

  it('擋 open-redirect 變形：偽裝 host、路徑不符、非法 scheme', () => {
    // 字串前綴/naive regex 常見繞過：host 前綴相符但其實是另一個網域
    expect(isAllowedRedirectUri('http://localhost.evil.com/callback')).toBe(false)
    expect(isAllowedRedirectUri('http://127.0.0.1.evil.com/callback')).toBe(false)
    expect(isAllowedRedirectUri('https://claude.ai.evil.com/api/mcp/auth_callback')).toBe(false)
    // 路徑不對
    expect(isAllowedRedirectUri('http://localhost:1/other')).toBe(false)
    // 非法/危險 scheme
    expect(isAllowedRedirectUri('javascript:alert(1)//callback')).toBe(false)
    // claude.ai 但帶 port（host 比對含 port，非 hostname）或路徑不符
    expect(isAllowedRedirectUri('https://claude.ai:8443/api/mcp/auth_callback')).toBe(false)
    expect(isAllowedRedirectUri('https://claude.ai/wrong/path')).toBe(false)
    // claude.ai 但用 http（非 https）
    expect(isAllowedRedirectUri('http://claude.ai/api/mcp/auth_callback')).toBe(false)
    // loopback 但用 https（allowlist 只定義 http loopback）
    expect(isAllowedRedirectUri('https://localhost/callback')).toBe(false)
    // 完全無法解析
    expect(isAllowedRedirectUri('not a url')).toBe(false)
    // 空字串
    expect(isAllowedRedirectUri('')).toBe(false)
  })
})
