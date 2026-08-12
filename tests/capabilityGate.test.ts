import { describe, it, expect } from 'vitest'
import { hostSupportsApps } from '../src/server/app.js'
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'

describe('hostSupportsApps', () => {
  it('宣告 ui extension + 支援 mime → true', () => {
    const caps = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } }
    expect(hostSupportsApps(caps)).toBe(true)
  })
  it('未宣告 ui extension → false', () => {
    expect(hostSupportsApps({})).toBe(false)
    expect(hostSupportsApps(null)).toBe(false)
  })
  it('宣告 extension 但不含我們的 mime → false', () => {
    const caps = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/plain'] } } }
    expect(hostSupportsApps(caps)).toBe(false)
  })
})

describe('registerAppTool SDK 行為（先驗 SDK API 形狀，供 newServer 分派用）', () => {
  it('registerAppTool 註冊的工具在 tools/list 帶 _meta.ui.resourceUri', async () => {
    const server = new McpServer({ name: 't', version: '0' })
    registerAppTool(server, 'demo', {
      description: 'd', inputSchema: {}, outputSchema: { ok: z.boolean() },
      _meta: { ui: { resourceUri: 'ui://x/y.html' } },
    }, async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } }))
    const [cs, ss] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'c', version: '0' })
    await Promise.all([server.connect(ss), client.connect(cs)])
    const list = await client.listTools()
    const demo = list.tools.find(t => t.name === 'demo')!
    expect((demo._meta as any).ui.resourceUri).toBe('ui://x/y.html')
  })
})
