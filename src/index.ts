import { loadConfig } from './config.js'
import { initOtel, shutdownOtel } from './otel.js'
import { openDb } from './store/db.js'
import { buildApp } from './server/app.js'
import { makeShutdown } from './server/shutdown.js'

const config = loadConfig()
initOtel(config.otelMode)
const db = openDb('./data/be2-mcp-transition.sqlite')  // TODO(Task 7): switch to createPgDb(config.db)
const app = buildApp({ config, db })

let stopScheduler: (() => Promise<void>) | undefined
const server = app.listen(config.port, config.bindHost, () => {
  console.log(`be2-mcp listening on ${config.publicBaseUrl}/mcp (bind ${config.bindHost}:${config.port}, env: ${config.gatewayUrl})`)
  stopScheduler = (app.locals.startScheduler as (() => () => Promise<void>) | undefined)?.()
})

const shutdown = makeShutdown({
  server, db,
  stopScheduler: () => stopScheduler?.() ?? Promise.resolve(),
  shutdownOtel,
  graceMs: 25_000,   // < k8s terminationGracePeriodSeconds（DevOps 設 ≥30s）
})
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
