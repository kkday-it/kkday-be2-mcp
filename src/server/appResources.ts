import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const PANELS: Array<{ uri: string; file: string }> = [
  { uri: 'ui://be2/products-panel.html', file: 'products-panel.html' },
  { uri: 'ui://be2/changeset-panel.html', file: 'changeset-panel.html' },
  { uri: 'ui://be2/batch-wizard.html', file: 'batch-wizard.html' },
  { uri: 'ui://be2/announcement-wizard.html', file: 'announcement-wizard.html' },
  { uri: 'ui://be2/workbench.html', file: 'workbench.html' },
]

// 面板永遠是增強層：dist/ui 缺檔（沒跑 build:ui）就略過註冊、warn，工具照常文字運作。
export function registerAppResources(server: McpServer, opts: { uiDir?: string } = {}): string[] {
  const dir = opts.uiDir ?? join(process.cwd(), 'dist', 'ui')
  const done: string[] = []
  for (const p of PANELS) {
    const path = join(dir, p.file)
    if (!existsSync(path)) { console.warn(`[be2-mcp] app resource skipped (missing ${path})`); continue }
    const html = readFileSync(path, 'utf8')
    registerAppResource(server, p.file, p.uri, { mimeType: RESOURCE_MIME_TYPE },
      async uri => ({ contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html }] }))
    done.push(p.uri)
  }
  return done
}
