// src/store/dbTypes.ts
// transport 抽象（pg.Pool / PGlite），非雙 backend——兩實作跑同一套 PG 方言 SQL（spec §3.1）。
export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>
  /** fn 內所有 tx.query 走同一連線；fn throw → ROLLBACK 後 rethrow，正常返回 → COMMIT */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}
