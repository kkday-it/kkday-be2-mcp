// src/store/migrate.ts
// Forward-only SQL migration 執行器（cloud spec §2.5）：字典序、單 transaction/檔、
// schema_migrations 記錄、advisory lock 防並行、可重跑。
// 被 scripts/db-migrate.ts（生產，經 pg client）與 tests/support/testDb.ts（PGlite）共用。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MigrationTarget {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  exec(sql: string): Promise<void>
}

const LOCK_KEY = 727_001  // 任意固定值：be2-mcp migration 全域鎖

export async function runMigrations(db: MigrationTarget, dir = 'db/migrations'): Promise<string[]> {
  await db.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`)
    const done = new Set(
      (await db.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename as string))
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    const applied: string[] = []
    for (const f of files) {
      if (done.has(f)) continue
      const sql = readFileSync(join(dir, f), 'utf8')
      // 單 transaction/檔：BEGIN + 檔內容 + 記錄 + COMMIT；任一步失敗 ROLLBACK、不記錄。
      await db.exec('BEGIN')
      try {
        await db.exec(sql)
        await db.query('INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, $2)', [f, Date.now()])
        await db.exec('COMMIT')
      } catch (e) {
        // ROLLBACK 自身可能 throw（連線已死）——吞掉，確保拋出的是原始 migration 錯誤
        try { await db.exec('ROLLBACK') } catch { /* ignore secondary error */ }
        throw new Error(`migration ${f} failed: ${(e as Error).message}`)
      }
      applied.push(f)
    }
    return applied
  } finally {
    // finally 內 throw 會覆蓋主錯誤——unlock 失敗只 log 不拋（連線死掉時鎖也隨 session 消失）
    try { await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]) }
    catch (e) { console.error('pg_advisory_unlock failed:', (e as Error).message) }
  }
}
