import { loadConfig } from './config.js'
import { initOtel, shutdownOtel } from './otel.js'
import { createPgDb } from './store/pgDb.js'
import { buildApp } from './server/app.js'
import { makeShutdown } from './server/shutdown.js'
import { shouldStartPoller } from './server/schedulerMode.js'

const config = loadConfig()
initOtel(config.otelMode)
const db = createPgDb(config.db)
const app = buildApp({ config, db })

let stopScheduler: (() => Promise<void>) | undefined
const server = app.listen(config.port, config.bindHost, () => {
  console.log(`be2-mcp listening on ${config.publicBaseUrl}/mcp (bind ${config.bindHost}:${config.port}, env: ${config.gatewayUrl})`)
  // Task 10: SCHEDULER_MODE=http — cloud-ready 硬約束「排程走 HTTP endpoint 非 in-process
  // timer」（CLAUDE.md 上雲硬約束）：不啟動 poller，改由外部 cron 打
  // POST /api/jobs/scheduler-tick 驅動同一顆 scheduler.tick。poller 模式下 start() 內部會在
  // 進入 setTimeout 迴圈前先跑一次 auditStranded()（見 scheduler.ts）；http 模式沒有 start()
  // 可以搭這班順風車，故這裡直接呼叫 app.locals.auditStranded 補上同一次啟動時警示。
  if (shouldStartPoller(config)) {
    stopScheduler = (app.locals.startScheduler as (() => () => Promise<void>) | undefined)?.()
  } else {
    void (app.locals.auditStranded as (() => Promise<void>) | undefined)?.()
      .catch(err => console.error('[be2-mcp] auditStranded (SCHEDULER_MODE=http startup) error:', (err as Error).message))
  }
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
