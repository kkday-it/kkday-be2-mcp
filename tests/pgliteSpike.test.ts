// PGlite 方言/行為 conformance（spec §14 風險 gate）。永久保留：升級 PGlite 時此檔守住
// 我們依賴的每一個 PG 行為。若本檔任一 case 失敗 → PGlite 不可用，退 testcontainers（spec §14）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

describe('PGlite dialect conformance', () => {
  let pg: PGlite
  beforeAll(async () => {
    pg = new PGlite()  // in-memory
    await pg.exec(`
      CREATE TABLE t_identity (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE t_upsert (k TEXT PRIMARY KEY, n BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE t_cas (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE t_bool (k TEXT PRIMARY KEY, consumed BOOLEAN NOT NULL DEFAULT FALSE);
      CREATE TABLE t_audit (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, msg TEXT NOT NULL);
      CREATE FUNCTION t_audit_immutable() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER t_audit_no_update BEFORE UPDATE ON t_audit FOR EACH ROW EXECUTE FUNCTION t_audit_immutable();
      CREATE TRIGGER t_audit_no_delete BEFORE DELETE ON t_audit FOR EACH ROW EXECUTE FUNCTION t_audit_immutable();
    `)
  })
  afterAll(async () => { await pg.close() })

  it('IDENTITY 自增', async () => {
    await pg.query(`INSERT INTO t_identity (v) VALUES ($1)`, ['a'])
    await pg.query(`INSERT INTO t_identity (v) VALUES ($1)`, ['b'])
    const r = await pg.query<{ id: number | bigint }>(`SELECT id FROM t_identity ORDER BY id`)
    expect(Number(r.rows[0].id)).toBe(1)
    expect(Number(r.rows[1].id)).toBe(2)
  })

  it('ON CONFLICT DO UPDATE（upsert 計數）', async () => {
    await pg.query(`INSERT INTO t_upsert (k, n) VALUES ($1, 1) ON CONFLICT (k) DO UPDATE SET n = t_upsert.n + 1`, ['x'])
    await pg.query(`INSERT INTO t_upsert (k, n) VALUES ($1, 1) ON CONFLICT (k) DO UPDATE SET n = t_upsert.n + 1`, ['x'])
    const r = await pg.query<{ n: number | string | bigint }>(`SELECT n FROM t_upsert WHERE k = $1`, ['x'])
    expect(Number(r.rows[0].n)).toBe(2)
  })

  it('ON CONFLICT DO NOTHING', async () => {
    const a = await pg.query(`INSERT INTO t_upsert (k) VALUES ($1) ON CONFLICT DO NOTHING`, ['y'])
    const b = await pg.query(`INSERT INTO t_upsert (k) VALUES ($1) ON CONFLICT DO NOTHING`, ['y'])
    expect(a.affectedRows ?? 0).toBe(1)
    expect(b.affectedRows ?? 0).toBe(0)
  })

  it('CAS：條件式 UPDATE 的 affectedRows 恰為 0/1', async () => {
    await pg.query(`INSERT INTO t_cas (id, status) VALUES ('c1', 'pending')`)
    const win = await pg.query(`UPDATE t_cas SET status='approved' WHERE id='c1' AND status='pending'`)
    const lose = await pg.query(`UPDATE t_cas SET status='approved' WHERE id='c1' AND status='pending'`)
    expect(win.affectedRows).toBe(1)
    expect(lose.affectedRows).toBe(0)
  })

  it('BOOLEAN round-trip', async () => {
    await pg.query(`INSERT INTO t_bool (k, consumed) VALUES ($1, $2)`, ['b1', false])
    await pg.query(`UPDATE t_bool SET consumed = TRUE WHERE k = $1`, ['b1'])
    const r = await pg.query<{ consumed: boolean }>(`SELECT consumed FROM t_bool WHERE k = $1`, ['b1'])
    expect(r.rows[0].consumed).toBe(true)  // 回 JS boolean，非 0/1
  })

  it('append-only trigger 擋 UPDATE/DELETE', async () => {
    await pg.query(`INSERT INTO t_audit (msg) VALUES ('x')`)
    await expect(pg.query(`UPDATE t_audit SET msg='y' WHERE id=1`)).rejects.toThrow(/append-only/)
    await expect(pg.query(`DELETE FROM t_audit WHERE id=1`)).rejects.toThrow(/append-only/)
  })

  it('transaction rollback', async () => {
    await expect(pg.transaction(async (tx) => {
      await tx.query(`INSERT INTO t_cas (id, status) VALUES ('tx1', 'pending')`)
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const r = await pg.query(`SELECT 1 FROM t_cas WHERE id='tx1'`)
    expect(r.rows.length).toBe(0)
  })

  it('BIGINT 取值可正規化為 number（ms timestamp 值域）', async () => {
    const ts = 1756900000000  // ~2^40.7，遠低於 2^53
    await pg.query(`INSERT INTO t_upsert (k, n) VALUES ($1, $2)`, ['ts', ts])
    const r = await pg.query<{ n: unknown }>(`SELECT n FROM t_upsert WHERE k = $1`, ['ts'])
    // PGlite 對 int8 的回傳型別（number/bigint/string）在此定案；PgliteDb wrapper 據此正規化
    expect(Number(r.rows[0].n)).toBe(ts)
  })

  it('COUNT(*) 可正規化為 number', async () => {
    const r = await pg.query<{ c: unknown }>(`SELECT COUNT(*) c FROM t_upsert`)
    expect(Number(r.rows[0].c)).toBeGreaterThan(0)
  })

  it('pg_advisory_lock 可用（migration runner 依賴）', async () => {
    await pg.query(`SELECT pg_advisory_lock(42)`)
    await pg.query(`SELECT pg_advisory_unlock(42)`)
  })
})
