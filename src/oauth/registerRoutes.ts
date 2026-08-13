import express from 'express'
import { isAllowedRedirectUri } from './redirectUri.js'
import type { OAuthStore } from './oauthStore.js'

// Task 7：DCR 動態註冊（RFC 7591）。照抄 reference-dev-tools-architecture.md 的
// RegisterController 做法：public client（無 secret、PKCE）、redirect_uri allowlist、
// 每次都建新 client（不去重）。
//
// 兩個安全重點：
// 1. redirect_uris 逐一過 isAllowedRedirectUri；任一個不合格 → 400、且不建立 client
//    （不做「部分接受」，避免半成品 client 留在 store 裡）。
// 2. 回應物件用「物件字面量」組出，刻意不放 client_secret 這個 key（連 null 都不行）——
//    Claude Code 的 zod schema 若看到 client_secret 這個 key（即使值是 null）會型別衝突，
//    這是已知限制，非疏漏。
export function buildRegisterRouter({ oauthStore, genId }: { oauthStore: OAuthStore; genId: () => string }): express.Router {
  const r = express.Router()
  r.post('/oauth/register', (req, res) => {
    const body = req.body as { redirect_uris?: unknown } | undefined
    const redirectUris = body?.redirect_uris
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(u => typeof u === 'string')) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris must be a non-empty array of strings' })
      return
    }
    const uris = redirectUris as string[]
    if (!uris.every(isAllowedRedirectUri)) {
      res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'one or more redirect_uris are not allowlisted' })
      return
    }
    const clientId = genId()
    oauthStore.insertClient({ clientId, redirectUris: uris, createdAt: Date.now() })
    // 物件字面量：沒有 client_secret 這個 key，'client_secret' in response 恆為 false。
    res.status(200).json({
      client_id: clientId,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
  })
  return r
}
