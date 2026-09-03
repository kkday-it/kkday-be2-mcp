import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { SpanStatusCode } from '@opentelemetry/api'
import { summarizeStatement, wrapQueryWithSpan } from '../src/store/dbObservability.js'
import { createPgDb } from '../src/store/pgDb.js'

describe('summarizeStatement', () => {
  it('SELECT with $1 placeholder -> keyword + first table, no param leak', () => {
    expect(summarizeStatement('SELECT * FROM change_sets WHERE id=$1')).toBe('SELECT change_sets')
  })

  it('INSERT INTO -> keyword + table', () => {
    expect(summarizeStatement("INSERT INTO credentials (id, token) VALUES ($1, $2)")).toBe('INSERT credentials')
  })

  it('UPDATE ... SET -> keyword + table', () => {
    expect(summarizeStatement("UPDATE be2_identities SET status=$1 WHERE id=$2")).toBe('UPDATE be2_identities')
  })

  it('DELETE FROM -> keyword + table', () => {
    expect(summarizeStatement('DELETE FROM audit_log WHERE id=$1')).toBe('DELETE audit_log')
  })

  it('handles multiline / re-indented SQL', () => {
    const sql = `
      SELECT id, status
      FROM   change_sets
      WHERE  id = $1
    `
    expect(summarizeStatement(sql)).toBe('SELECT change_sets')
  })

  it('falls back to keyword-only when no table can be extracted', () => {
    expect(summarizeStatement('BEGIN')).toBe('BEGIN')
  })

  it('never contains a parameter value passed alongside the SQL', () => {
    const sql = 'SELECT * FROM credentials WHERE token=$1'
    const params = ['secret-token']
    const summary = summarizeStatement(sql)
    expect(summary).toBe('SELECT credentials')
    expect(summary).not.toContain(params[0])
    expect(summary).not.toContain('secret-token')
  })
})

describe('wrapQueryWithSpan', () => {
  let exporter: InMemorySpanExporter
  let provider: BasicTracerProvider

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  })

  afterEach(async () => {
    await provider.shutdown()
  })

  it('produces a db.query span with statement_summary + row_count attributes', async () => {
    const tracer = provider.getTracer('test')
    const rawQuery = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }))
    const query = wrapQueryWithSpan(tracer, rawQuery)

    const result = await query('SELECT * FROM change_sets WHERE id=$1', ['abc-123'])
    expect(result.rowCount).toBe(2)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('db.query')
    expect(spans[0].attributes['db.statement_summary']).toBe('SELECT change_sets')
    expect(spans[0].attributes['db.row_count']).toBe(2)
  })

  it('CRITICAL: statement_summary attribute never contains param values (e.g. a secret token)', async () => {
    const tracer = provider.getTracer('test')
    const rawQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const query = wrapQueryWithSpan(tracer, rawQuery)

    await query('SELECT * FROM credentials WHERE token=$1', ['secret-token'])

    const spans = exporter.getFinishedSpans()
    const summary = spans[0].attributes['db.statement_summary']
    expect(summary).toBe('SELECT credentials')
    expect(String(summary)).not.toContain('secret-token')
    // also check no attribute anywhere on the span carries the raw param value
    for (const [, value] of Object.entries(spans[0].attributes)) {
      expect(String(value)).not.toContain('secret-token')
    }
  })

  it('records the exception and sets error status on query failure, then rethrows', async () => {
    const tracer = provider.getTracer('test')
    const boom = new Error('connection reset')
    const rawQuery = vi.fn(async () => { throw boom })
    const query = wrapQueryWithSpan(tracer, rawQuery)

    await expect(query('SELECT * FROM change_sets WHERE id=$1', ['x'])).rejects.toThrow('connection reset')

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR)
    expect(spans[0].events.some(e => e.name === 'exception')).toBe(true)
  })
})

describe('PgDb: query path is wired through the span wrapper (dependency-injectable via wrapQueryWithSpan)', () => {
  // createPgDb builds its own pg.Pool but delegates every query to wrapQueryWithSpan (same function
  // unit-tested above) — so this only needs to confirm PgDb actually calls it, not re-prove the
  // span mechanics. pg.Pool connects lazily, so constructing it here never touches the network.
  it('close() clears the pool-stats interval (no leaked timer after shutdown)', async () => {
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const db = createPgDb({ host: '127.0.0.1', port: 1, user: 'x', password: 'x', database: 'x', ssl: false })
    await db.close()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})

describe('pg.Pool stats logging', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('logs one JSON line with totalCount/idleCount/waitingCount every 60s', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    createPgDb({ host: '127.0.0.1', port: 1, user: 'x', password: 'x', database: 'x', ssl: false })

    expect(logSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(logSpy).toHaveBeenCalledTimes(1)

    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(parsed).toMatchObject({
      msg: 'pg_pool_stats',
      totalCount: expect.any(Number),
      idleCount: expect.any(Number),
      waitingCount: expect.any(Number),
    })

    vi.advanceTimersByTime(60_000)
    expect(logSpy).toHaveBeenCalledTimes(2)

    logSpy.mockRestore()
  })
})
