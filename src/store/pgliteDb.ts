// src/store/pgliteDb.ts
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { Db } from './dbTypes.js'

// int8 正規化：**不用 typeof 猜**（PGlite 依版本可能回 bigint 或 string）——用 query 結果的
// fields metadata（dataTypeID===20 即 int8）確定哪些欄位要轉 Number（值域 = ms timestamp/count，
// << 2^53，spec §5）。session_id 等真字串欄位不會被誤轉。
function wrap(q: PGlite | Transaction): Pick<Db, 'query'> {
  return {
    async query<R>(sql: string, params?: unknown[]) {
      const r = await q.query<Record<string, unknown>>(sql, params as never[])
      const int8Cols = (r.fields ?? []).filter(f => f.dataTypeID === 20).map(f => f.name)
      if (int8Cols.length > 0) {
        for (const row of r.rows) {
          for (const c of int8Cols) {
            if (row[c] != null) row[c] = Number(row[c])   // 吃 bigint 或 string 都正確
          }
        }
      }
      // rowCount 來自 PGlite command-tag：SELECT 回傳行數、UPDATE/DELETE 回傳異動行數；
      // 優先採用 rowCount（PGlite 原生），fallback rows.length 作為兜底（SELECT 或異動 0 筆兩者值同）。
      return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length }
    },
  }
}

// 內部：把已建好的 PGlite 實例包成 Db。獨立匯出供 tests/support/testDb.ts 用——
// migration 檔是多語句 SQL，PGlite 的 query() 走 extended protocol 一次只能一句
// （實跑驗證：'cannot insert multiple commands into a prepared statement'），
// 故 openTestDb 需要在建 Db 前先用同一個 pg 實例的 exec() 直接跑 migrations。
export function wrapPgliteDb(pg: PGlite): Db {
  return {
    query: (sql, params) => wrap(pg).query(sql, params),
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return pg.transaction(async (t) => fn({
        query: (sql, params) => wrap(t).query(sql, params),
        transaction: () => { throw new Error('nested transaction not supported') },
        close: async () => { throw new Error('close inside transaction not supported') },
      })) as Promise<T>
    },
    close: () => pg.close(),
  }
}

export async function createPgliteDb(): Promise<Db> {
  const pg = new PGlite()
  return wrapPgliteDb(pg)
}
