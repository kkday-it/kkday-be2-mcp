import { describe, it, expect } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAppResources } from '../src/server/appResources.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('缺檔 → 回空陣列、不丟例外', () => {
  const server = new McpServer({ name: 't', version: '0' })
  const empty = mkdtempSync(join(tmpdir(), 'ui-'))
  expect(registerAppResources(server, { uiDir: empty })).toEqual([])
})
it('有檔 → 註冊並回 uri', () => {
  const server = new McpServer({ name: 't', version: '0' })
  const dir = mkdtempSync(join(tmpdir(), 'ui-'))
  writeFileSync(join(dir, 'products-panel.html'), '<html></html>')
  writeFileSync(join(dir, 'changeset-panel.html'), '<html></html>')
  const done = registerAppResources(server, { uiDir: dir })
  expect(done).toContain('ui://be2/products-panel.html')
  expect(done).toContain('ui://be2/changeset-panel.html')
})
