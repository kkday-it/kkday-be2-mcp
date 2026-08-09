import express from 'express'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type Database from 'better-sqlite3'
import type { Config } from '../config.js'
import { TokenStore } from '../store/tokenStore.js'
import { ReadOidStore } from '../store/readOidStore.js'
import { TokenManager } from '../auth/tokenManager.js'
import { AuthServiceClient } from '../auth/authServiceClient.js'
import { GatewayClient } from '../gateway/client.js'
import { AuditLog } from '../audit/auditLog.js'
import { RateBudget } from '../limits/rateBudget.js'
import { requestContext } from './requestContext.js'
import { wrapTool, type PipelineDeps } from './toolPipeline.js'
import { findProductsTool } from '../tools/findProducts.js'
import { productPlansTool } from '../tools/productPlans.js'
import { inventorySettingsTool } from '../tools/inventorySettings.js'
import type { ToolDef } from '../tools/types.js'

export interface ServerDeps { config: Config; db: Database.Database }

const TOOLS: ToolDef[] = [findProductsTool as ToolDef, productPlansTool as ToolDef, inventorySettingsTool as ToolDef]

export function buildApp({ config, db }: ServerDeps): express.Express {
  const store = new TokenStore(db)
  const deps: PipelineDeps = {
    tokenManager: new TokenManager(store, new AuthServiceClient({ baseUrl: config.authsvcUrl, serviceKey: config.serviceKey })),
    rateBudget: new RateBudget(db),
    audit: new AuditLog(db),
    gateway: new GatewayClient({ baseUrl: config.gatewayUrl }),
    readOids: new ReadOidStore(db),
  }

  const transports = new Map<string, StreamableHTTPServerTransport>()

  function newServer(): McpServer {
    const server = new McpServer({ name: 'be2-mcp', version: '0.1.0' })
    for (const tool of TOOLS) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputShape },
        wrapTool(tool, deps) as never)
    }
    return server
  }

  const app = express()
  app.use(express.json())
  app.get('/healthz', (_req, res) => { res.status(200).send('ok') })

  app.all('/mcp', (req, res) => {
    void (async () => {
      // Fast bearer gate: known-bearer check only (NO refresh here — pipeline refreshes per tool call).
      const auth = req.header('authorization') ?? ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (!bearer || !store.getByBearer(bearer)) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'unknown or missing bearer — run bootstrap-user' } })
        return
      }

      const sessionId = req.header('mcp-session-id')
      let transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        if (req.method !== 'POST') { res.status(400).json({ error: { code: 'NO_SESSION', message: 'unknown mcp session' } }); return }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: id => { transports.set(id, transport!) },
          onsessionclosed: id => { transports.delete(id) },
        })
        await newServer().connect(transport)
      }

      const ctx = {
        bearer,
        sessionId: transport.sessionId ?? 'pre-init',
        clientInfo: (req.header('user-agent') ?? 'unknown').slice(0, 120),
      }
      await requestContext.run(ctx, () => transport!.handleRequest(req, res, req.body))
    })().catch(err => {
      if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } })
      console.error('mcp request failed:', (err as Error).message)
    })
  })

  return app
}
