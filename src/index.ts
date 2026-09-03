import { loadConfig } from './config.js'
import { initOtel, shutdownOtel } from './otel.js'
import { createPgDb } from './store/pgDb.js'
import { buildApp } from './server/app.js'
import { makeShutdown } from './server/shutdown.js'

const config = loadConfig()
initOtel(config.otelMode)
const db = createPgDb(config.db)
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
// shutdown() 內部 try/finally 已吞下所有錯誤（見 shutdown.ts），保證回傳的 Promise 只 resolve、
// 不 reject——process.on 的 listener 型別要求 void 回傳，這裡用 void 運算子明確標記「刻意
// fire-and-forget」，而非漏 await（no-misused-promises 的 checksVoidReturn 檢查）。
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
