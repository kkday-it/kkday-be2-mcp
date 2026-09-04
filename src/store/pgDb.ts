// src/store/pgDb.ts
import { trace } from '@opentelemetry/api'
import pg from 'pg'
import type { Db } from './dbTypes.js'
import type { DbConnection } from '../config.js'
import { wrapQueryWithSpan } from './dbObservability.js'

// int8(BIGINT/COUNT) → Number：全碼庫值域為 ms timestamp 與 count（<< 2^53），spec §5。
pg.types.setTypeParser(20, (v: string) => Number(v))

const POOL_STATS_INTERVAL_MS = 60_000

export function createPgDb(conn: DbConnection): Db {
  const pool = new pg.Pool({
    ...(conn.connectionString ? { connectionString: conn.connectionString } : {
      host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database,
    }),
    ssl: conn.ssl,
    max: 5,                            // spec §7：單 pod 小池
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  })
  // 必掛：idle 連線斷線（RDS failover/重啟）時 pool 發 'error' event——沒 listener 的
  // EventEmitter error 會讓整個 Node process crash。log 後放給 pool 自行汰換即可。
  pool.on('error', (err) => { console.error('[be2-mcp] pg pool idle client error:', err.message) })

  // 與 toolPipeline.ts / executor.ts 同一套：createPgDb 呼叫時取一次 tracer，之後每次 query
  // 各自 startActiveSpan。OTEL_MODE=off 時 trace.getTracer 拿到的是 OTel API 內建 no-op tracer
  // （見 src/otel.ts 註解），span 建立/結束零額外開銷、不需另外 gate。
  const tracer = trace.getTracer('be2-mcp')
  const wrap = (q: Pick<pg.PoolClient, 'query'>): Pick<Db, 'query'> => {
    const spanned = wrapQueryWithSpan(tracer, async (sql, params) => {
      const r = await q.query(sql, params)
      return { rows: r.rows, rowCount: r.rowCount ?? 0 }
    })
    return {
      async query<R>(sql: string, params?: unknown[]) {
        const result = await spanned(sql, params)
        return { rows: result.rows as R[], rowCount: result.rowCount }
      },
    }
  }

  // pool 使用率每 60s 一行 log（stdout，JSON）：totalCount/idleCount/waitingCount。unref() 讓它
  // 不阻擋 process 自然結束；close() 時 clearInterval 停止（見下方 close）。
  const statsTimer = setInterval(() => {
    console.log(JSON.stringify({
      msg: 'pg_pool_stats',
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    }))
  }, POOL_STATS_INTERVAL_MS)
  statsTimer.unref()

  return {
    query: (sql, params) => wrap(pool).query(sql, params),
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn({
          query: (sql, params) => wrap(client).query(sql, params),
          transaction: () => { throw new Error('nested transaction not supported') },
          close: async () => { throw new Error('close inside transaction not supported') },
        })
        await client.query('COMMIT')
        return result
      } catch (e) {
        // ROLLBACK 自身也可能 throw（連線層錯誤）——吞掉它，確保拋出的是原始錯誤
        try { await client.query('ROLLBACK') } catch { /* connection-level failure; pool 會汰換 */ }
        throw e
      } finally {
        client.release()
      }
    },
    close: async () => {
      clearInterval(statsTimer)
      await pool.end()
    },
  }
}
