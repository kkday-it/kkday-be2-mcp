import express from 'express'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { AppPipelineDeps } from './appPipeline.js'
import { wrapAppTool } from './appPipeline.js'
import { APP_TOOLS } from '../tools/appTools.js'
import { requestContext } from './requestContext.js'
import { CredentialStore } from '../store/credentialStore.js'

export interface DevPanelDeps {
  db: Database.Database
  appDeps: AppPipelineDeps
}

const ALLOWED_PANELS = ['batch-wizard', 'changeset-panel', 'products-panel']
const DEV_SECRET = 'be2mcp_dev_panel_secret'
const DEV_SESSION_ID = 'dev-panel-session'

export function buildDevPanelRouter(deps: DevPanelDeps): express.Router {
  const router = express.Router()

  router.get('/panel/:name', (req, res) => {
    const name = req.params.name
    if (!ALLOWED_PANELS.includes(name)) {
      res.status(404).send('Panel not allowed')
      return
    }

    const uiDir = join(process.cwd(), 'dist', 'ui')
    const panelPath = join(uiDir, `${name}.html`)
    if (!existsSync(panelPath)) {
      res.status(404).send('Panel HTML not built. Run npm run build:ui first.')
      return
    }

    const html = readFileSync(panelPath, 'utf8')
    // minimal shim injected before panel bundle
    const shim = `
      <script>
        window.__DEV_APP_SHIM__ = true;
        // The dev hook in panelShared.ts will bypass real MCP connect.
      </script>
    `
    // Append the shim in the head so the panel's own script will see it
    const out = html.replace('<head>', '<head>' + shim)
    res.send(out)
  })

  router.post('/panel-tool', (req, res) => {
    void (async () => {
      const { name, arguments: args } = req.body
      const tool = APP_TOOLS.find(t => t.name === name)
      if (!tool) {
        res.status(404).json({ error: { message: `Tool ${name} not allowed` } })
        return
      }

      // Identity: reuse the newest identity in IdentityStore
      const identity = deps.db.prepare('SELECT identity_id FROM be2_identities ORDER BY updated_at DESC LIMIT 1').get() as { identity_id: string } | undefined
      if (!identity) {
        res.status(400).json({ error: { message: 'No identities found. Run bootstrap-user first.' } })
        return
      }

      // Ensure the dev secret resolves to the newest identity
      const credHash = CredentialStore.hash(DEV_SECRET)
      deps.db.prepare('INSERT OR IGNORE INTO credentials (cred_hash, identity_id, kind, expires_at, updated_at) VALUES (?, ?, ?, null, ?)')
        .run(credHash, identity.identity_id, 'static_bearer', Date.now())

      const handler = wrapAppTool(tool, deps.appDeps)
      const ctx = {
        bearer: DEV_SECRET,
        sessionId: DEV_SESSION_ID,
        clientInfo: 'dev-panel-harness',
      }

      const result = await requestContext.run(ctx, () => handler(args))
      
      // If there's a result, we return it in the format the panel expects.
      if (result.isError) {
         // Return a 200 with the error inside so fetch does not throw prematurely? 
         // Real MCP callServerTool returns the envelope. 
         // Wait, result is already { content: [...], isError: true } or similar.
         // Panel fetch expects either standard json containing result, or throws on not ok.
         // Let's just return result directly as JSON.
         // The panel shim we build inside panelShared.ts will return this directly.
      }
      res.json(result)
    })().catch(err => {
      if (!res.headersSent) res.status(500).json({ error: { message: err.message } })
    })
  })

  return router
}
