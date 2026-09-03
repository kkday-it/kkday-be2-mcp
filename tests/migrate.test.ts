import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { runMigrations } from '../src/store/migrate.js'

function target(pg: PGlite) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const r = await pg.query<Record<string, unknown>>(sql, params as never[])
      return { rows: r.rows }
    },
    exec: async (sql: string) => { await pg.exec(sql) },
  }
}

describe('runMigrations', () => {
  it('空 DB 套用全部 migration、建出 schema_migrations 記錄', async () => {
    const pg = new PGlite()
    const applied = await runMigrations(target(pg))
    expect(applied).toEqual(['0001_baseline.sql', '0002_grants.sql'])
    const t = await pg.query<Record<string, unknown>>(`SELECT filename FROM schema_migrations ORDER BY filename`)
    expect(t.rows.map((r: Record<string, unknown>) => r.filename)).toEqual(['0001_baseline.sql', '0002_grants.sql'])
    // 11 張表存在抽查
    await pg.query(`SELECT 1 FROM change_sets LIMIT 0`)
    await pg.query(`SELECT 1 FROM audit_log LIMIT 0`)
    await pg.close()
  })

  it('重跑 = no-op（冪等）', async () => {
    const pg = new PGlite()
    await runMigrations(target(pg))
    const second = await runMigrations(target(pg))
    expect(second).toEqual([])
    await pg.close()
  })

  it('migration 檔失敗時整檔 rollback、不記錄', async () => {
    const pg = new PGlite()
    await expect(runMigrations(target(pg), 'tests/fixtures/bad-migrations')).rejects.toThrow()
    const t = await pg.query(`SELECT filename FROM schema_migrations`)
    expect(t.rows.length).toBe(0)
    await pg.close()
  })
})
