// src/store/pgDb.ts
import pg from 'pg'
import type { Db } from './dbTypes.js'
import type { DbConnection } from '../config.js'

// int8(BIGINT/COUNT) → Number：全碼庫值域為 ms timestamp 與 count（<< 2^53），spec §5。
pg.types.setTypeParser(20, (v: string) => Number(v))

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
  const wrap = (q: Pick<pg.PoolClient, 'query'>): Pick<Db, 'query'> => ({
    async query<R>(sql: string, params?: unknown[]) {
      const r = await q.query(sql, params)
      return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 }
    },
  })
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
    close: () => pool.end(),
  }
}
