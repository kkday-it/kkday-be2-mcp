# MCP 授權伺服器：DCR 與 CIMD 雙模相容設計與實作說明書

## 1. 概述 (Overview)
隨著 Model Context Protocol (MCP) 規格演進，客戶端認證已從**動態客戶端註冊 (Dynamic Client Registration, DCR)** 遷移至**客戶端 ID 元資料文件 (Client ID Metadata Documents, CIMD)**。
為確保舊版 AI 客戶端與新版免註冊客戶端皆能無縫對接，本設計採用**雙模並存（Hybrid/Dual Support）**與**抽象適配器（Adapter Pattern）**架構，達成無預先註冊、高擴展性、且無狀態（Stateless）的 MCP 伺服器設計。

---

## 2. 系統架構與元資料宣告 (Architecture & Discovery)

### 2.1 授權伺服器元資料宣告 (AS Metadata)
授權伺服器在路徑 `.well-known/oauth-authorization-server` 必須同時宣告 `registration_endpoint`（供 DCR 使用）與 `client_id_metadata_document_supported`（供 CIMD 使用）。

```json
{
  "issuer": "https://mcp-auth.example.com",
  "authorization_endpoint": "https://mcp-auth.example.com/authorize",
  "token_endpoint": "https://mcp-auth.example.com/token",
  "registration_endpoint": "https://mcp-auth.example.com/register",
  "client_id_metadata_document_supported": true,
  "response_types_supported": ["code"],
  "code_challenge_methods_supported": ["S256"]
}
```

---

## 3. TypeScript 核心實作

### 3.1 核心適配器 (`ClientResolver.ts`)

```typescript
import axios from 'axios';
import Redis from 'ioredis';
import { URL } from 'url';

// 定義標準的 Client Metadata 介面
export interface ClientMetadata {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope?: string;
}

export class ClientResolverAdapter {
  private redis: Redis;
  private cimdCacheTtlSec = 3600; // CIMD 快取 1 小時

  constructor(redisClient: Redis) {
    this.redis = redisClient;
  }

  /**
   * 統一對外的進入點：根據 client_id 自動分流解析
   */
  async getClientMetadata(clientId: string): Promise<ClientMetadata | null> {
    if (!clientId) return null;

    // 判斷是否為合法的 HTTPS URL -> 走 CIMD 流程
    if (clientId.startsWith('https://')) {
      return await this.resolveCimdClient(clientId);
    } 
    
    // 否則視為一般的隨機字串 -> 走 DCR 流程
    return await this.resolveDcrClient(clientId);
  }

  /**
   * 處理 CIMD 流程 (動態 HTTPS 抓取 + SSRF 防禦 + 快取)
   */
  private async resolveCimdClient(clientIdUrl: string): Promise<ClientMetadata | null> {
    try {
      // 安全檢查：防止 SSRF
      const parsedUrl = new URL(clientIdUrl);
      if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsedUrl.hostname)) {
        throw new Error('Security Violation: Localhost or internal IP is not allowed for CIMD');
      }

      // 檢查 Redis 中是否已有快取
      const cacheKey = `cimd:cache:${clientIdUrl}`;
      const cachedData = await this.redis.get(cacheKey);
      if (cachedData) {
        return JSON.parse(cachedData) as ClientMetadata;
      }

      // 實時透過 HTTPS 抓取 Metadata Document
      const response = await axios.get<ClientMetadata>(clientIdUrl, {
        timeout: 3000,
        headers: { 'Accept': 'application/json' }
      });

      const metadata = response.data;

      // 網域一致性驗證
      const clientDomain = parsedUrl.origin;
      const isRedirectUriValid = metadata.redirect_uris.every(uri => uri.startsWith(clientDomain));
      
      if (!isRedirectUriValid) {
        throw new Error('Security Violation: redirect_uris must match the client_id domain origin');
      }

      // 規格補正
      metadata.client_id = clientIdUrl;

      // 寫入快取
      await this.redis.setex(cacheKey, this.cimdCacheTtlSec, JSON.stringify(metadata));

      return metadata;
    } catch (error) {
      console.error(`Failed to resolve CIMD client [${clientIdUrl}]:`, (error as Error).message);
      return null;
    }
  }

  /**
   * 處理 DCR 流程 (從 Redis 撈取註冊資料)
   */
  private async resolveDcrClient(clientId: string): Promise<ClientMetadata | null> {
    const dcrKey = `dcr:client:${clientId}`;
    const dcrData = await this.redis.get(dcrKey);
    
    if (!dcrData) {
      return null;
    }

    return JSON.parse(dcrData) as ClientMetadata;
  }
}
```

### 3.2 DCR 註冊端點實作 (`DcrEndpoint.ts`)

```typescript
import { Request, Response } from 'express';
import crypto from 'crypto';
import Redis from 'ioredis';

const redis = new Redis();

export const handleDcrRegistration = async (req: Request, res: Response) => {
  try {
    const { redirect_uris, client_name, grant_types, response_types } = req.body;

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Missing redirect_uris' });
    }

    const clientId = `dcr_${crypto.randomBytes(16).toString('hex')}`;

    const clientMetadata = {
      client_id: clientId,
      client_name: client_name || 'Legacy MCP Client',
      redirect_uris,
      grant_types: grant_types || ['authorization_code'],
      response_types: response_types || ['code']
    };

    const dcrKey = `dcr:client:${clientId}`;
    await redis.setex(dcrKey, 604800, JSON.stringify(clientMetadata)); // 7 天過期

    return res.status(201).json(clientMetadata);
  } catch (error) {
    return res.status(500).json({ error: 'server_error' });
  }
};
```

---

## 4. 安全考量 (Security & Protections)
* **防範 SSRF (Server-Side Request Forgery)**：禁止解析內網 IP。
* **網域一致性檢查 (Domain Validation)**：驗證 `redirect_uris` 與 `client_id` URL 的 Domain 是否相符。
* **DCR 速率限制 (Rate Limiting)**：限制每小時註冊次數，防止 DB Flooding。
* **強制 PKCE (Proof Key for Code Exchange)**：公開客戶端必須強制要求 `code_challenge`（S256）。
