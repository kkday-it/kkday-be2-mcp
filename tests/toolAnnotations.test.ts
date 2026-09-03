import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openTestDb } from './support/testDb.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { CredentialStore } from '../src/store/credentialStore.js'
import { buildApp } from '../src/server/app.js'
import type { Config } from '../src/config.js'
import { findProductsTool } from '../src/tools/findProducts.js'
import { productPlansTool } from '../src/tools/productPlans.js'
import { inventorySettingsTool } from '../src/tools/inventorySettings.js'
import { openWorkbenchTool } from '../src/tools/openWorkbench.js'
import { createChangesetTool, getChangesetStatusTool } from '../src/core/changeset/tools.js'
import {
  appGetChangesetViewTool,
  appGetConfirmLinkTool,
  appConfirmChangesetTool,
  appGetBatchViewTool,
  appCreateChangesetTool,
  APP_TOOLS,
} from '../src/tools/appTools.js'
import type { ToolDef } from '../src/tools/types.js'
import type { L2ToolDef } from '../src/server/l2Context.js'
import type { AppToolDef } from '../src/server/appPipeline.js'

describe('Tool Annotations - Unit Verification', () => {
  const modelTools: (ToolDef | L2ToolDef)[] = [
    findProductsTool as ToolDef,
    productPlansTool as ToolDef,
    inventorySettingsTool as ToolDef,
    openWorkbenchTool as ToolDef,
    createChangesetTool,
    getChangesetStatusTool,
  ]

  const appOnlyTools: AppToolDef[] = [
    appGetChangesetViewTool,
    appGetConfirmLinkTool,
    appConfirmChangesetTool,
    appGetBatchViewTool,
    appCreateChangesetTool,
  ]

  const allTools = [...modelTools, ...appOnlyTools]

  it('all tools must have annotations with title and readOnlyHint', () => {
    for (const tool of allTools) {
      expect(tool.annotations, `Tool ${tool.name} must have annotations defined`).toBeDefined()
      expect(tool.annotations?.title, `Tool ${tool.name} must have a non-empty title`).toBeTruthy()
      expect(typeof tool.annotations?.readOnlyHint, `Tool ${tool.name} must have boolean readOnlyHint`).toBe('boolean')
      expect(typeof tool.annotations?.destructiveHint, `Tool ${tool.name} must have boolean destructiveHint`).toBe('boolean')
      expect(typeof tool.annotations?.idempotentHint, `Tool ${tool.name} must have boolean idempotentHint`).toBe('boolean')
      expect(typeof tool.annotations?.openWorldHint, `Tool ${tool.name} must have boolean openWorldHint`).toBe('boolean')
    }
  })

  it('read-only tools have readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true', () => {
    const readTools = [
      findProductsTool,
      productPlansTool,
      inventorySettingsTool,
      getChangesetStatusTool,
      appGetBatchViewTool,
      appGetChangesetViewTool,
      appGetConfirmLinkTool,
    ]
    for (const tool of readTools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} should be readOnly`).toBe(true)
      expect(tool.annotations?.destructiveHint, `${tool.name} should not be destructive`).toBe(false)
      expect(tool.annotations?.idempotentHint, `${tool.name} should be idempotent`).toBe(true)
      expect(tool.annotations?.openWorldHint, `${tool.name} should have openWorldHint`).toBe(true)
    }
  })

  it('draft staging tools have readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true', () => {
    const draftTools = [
      createChangesetTool,
      openWorkbenchTool,
      appCreateChangesetTool,
    ]
    for (const tool of draftTools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} should not be readOnly`).toBe(false)
      expect(tool.annotations?.destructiveHint, `${tool.name} should not be destructive (draft only)`).toBe(false)
      expect(tool.annotations?.idempotentHint, `${tool.name} should not be idempotent`).toBe(false)
      expect(tool.annotations?.openWorldHint, `${tool.name} should have openWorldHint`).toBe(true)
    }
  })

  it('app_confirm_changeset has destructiveHint: true, readOnlyHint: false, idempotentHint: false, openWorldHint: true', () => {
    expect(appConfirmChangesetTool.annotations?.destructiveHint).toBe(true)
    expect(appConfirmChangesetTool.annotations?.readOnlyHint).toBe(false)
    expect(appConfirmChangesetTool.annotations?.idempotentHint).toBe(false)
    expect(appConfirmChangesetTool.annotations?.openWorldHint).toBe(true)
  })
})

describe('Tool Annotations - Integration through tools/list', () => {
  let http: Server
  let base: string
  const BEARER = 'be2mcp_' + 't'.repeat(48)

  beforeAll(async () => {
    const db = await openTestDb()
    const identityId = 'id-test-ann'
    new IdentityStore(db).upsert({
      identityId,
      userLabel: 'ann@kkday.com',
      accessToken: 'fake.jwt.token',
      refreshToken: 'r',
      businessList: [],
      accessExpiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    })
    new CredentialStore(db).insert({
      credHash: CredentialStore.hash(BEARER),
      identityId,
      kind: 'static_bearer',
      expiresAt: null,
      updatedAt: Date.now(),
    })

    const config: Config = {
      authsvcUrl: 'https://auth.invalid',
      gatewayUrl: 'https://gw.invalid',
      serviceKey: 'sk',
      port: 0,
      db: { host: 'localhost', ssl: false },
      schedulerMode: 'poller',
      otelMode: 'off', scheduleTz: 'Asia/Taipei',
      bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
    }

    const app = buildApp({ config, db })
    http = createServer(app)
    await new Promise<void>(r => http.listen(0, () => r()))
    base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  })

  afterAll(() => new Promise<void>(r => http.close(() => r())))

  it('returns annotations on tools listed through MCP protocol', async () => {
    const client = new Client({ name: 'ann-test', version: '0.0.1' })
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${BEARER}` } },
    })
    await client.connect(transport)
    const res = await client.listTools()
    await client.close()

    expect(res.tools.length).toBeGreaterThan(0)
    for (const tool of res.tools) {
      expect(tool.annotations, `Listed tool ${tool.name} must have annotations`).toBeDefined()
      expect(tool.annotations?.title, `Listed tool ${tool.name} must have title`).toBeTruthy()
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean')
    }
  })
})
