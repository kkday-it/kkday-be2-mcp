import { PGlite } from '@electric-sql/pglite'
import type { Db } from '../../src/store/dbTypes.js'
import { wrapPgliteDb } from '../../src/store/pgliteDb.js'
import { runMigrations } from '../../src/store/migrate.js'

// 取代舊 openDb(':memory:')：每呼叫一個全新 in-memory PGlite + 全部 migrations。
// vitest 每檔一個 worker process，檔內多次呼叫也各自獨立 → 隔離語義與 :memory: 等價。
//
// 注意：runMigrations 的 exec 直通 pg.exec()（非 wrapPgliteDb 的 query()）——
// migration 檔是多語句 SQL，PGlite query() 走 extended protocol 一次一句會噴
// 'cannot insert multiple commands into a prepared statement'；exec() 才支援多語句。
export async function openTestDb(): Promise<Db> {
  const pg = new PGlite()
  await runMigrations({
    query: async (sql, params) => {
      const r = await pg.query<Record<string, unknown>>(sql, params as never[])
      return { rows: r.rows }
    },
    exec: async (sql) => { await pg.exec(sql) },
  })
  return wrapPgliteDb(pg)
}
