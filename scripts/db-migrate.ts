// @ts-nocheck
// TODO(Task 4): remove @ts-nocheck once src/config.ts exports resolveDbConnection
// scripts/db-migrate.ts
// `npm run db:migrate` — CI / k8s Job 用（cloud spec §2.5、部署序：migrate 成功才 rollout）。
// 連線 env 與 app 相同（DB_* 或 DATABASE_URL），但應以 be2mcp_owner 帳號執行（spec §8.2）。
import pg from 'pg'
import { runMigrations } from '../src/store/migrate.js'
import { resolveDbConnection } from '../src/config.js'

async function main(): Promise<void> {
  const conn = resolveDbConnection(process.env)   // Task 4 提供；缺 env 會 throw（只印變數名）
  const client = new pg.Client({ ...conn, ssl: conn.ssl })
  await client.connect()
  try {
    const applied = await runMigrations({
      query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }),
      exec: async (sql) => { await client.query(sql) },
    })
    console.log(applied.length === 0
      ? 'db-migrate: up to date (no pending migrations)'
      : `db-migrate: applied ${applied.join(', ')}`)
  } finally {
    await client.end()
  }
}
main().catch((e) => { console.error('db-migrate FAILED:', (e as Error).message); process.exit(1) })
