import { loadConfig } from './config.js'
import { initOtel } from './otel.js'
import { openDb } from './store/db.js'
import { buildApp } from './server/app.js'

const config = loadConfig()
initOtel(config.otelMode)
const app = buildApp({ config, db: openDb(config.dbPath) })
app.listen(config.port, '127.0.0.1', () => {
  console.log(`be2-mcp listening on http://127.0.0.1:${config.port}/mcp (env: ${config.gatewayUrl})`)
})
