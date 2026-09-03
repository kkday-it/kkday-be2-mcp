// src/store/dbObservability.ts
// Task 12: db.query OTel span + statement summary — shared by PgDb (and, for testing, exercised
// standalone against a fake raw-query function so the wrapping logic doesn't need a live Postgres).
import { type Tracer, SpanStatusCode } from '@opentelemetry/api'

// SQL 首 keyword + 第一個表名——**絕不含參數值**（params 常帶 token/secret，見 Task 12 brief）。
// 抽成 pure function 供單元測試直接打，不必經過真的 DB / span。
export function summarizeStatement(sql: string): string {
  const normalized = sql.trim().replace(/\s+/g, ' ')
  const keywordMatch = normalized.match(/^([A-Za-z]+)/)
  const keyword = (keywordMatch?.[1] ?? 'UNKNOWN').toUpperCase()
  // 涵蓋 SELECT...FROM / INSERT INTO / UPDATE ... / DELETE FROM：抓第一個 FROM/INTO/UPDATE/JOIN
  // 後面接的識別字即可，query 語句慣例上這就是第一個表名。
  const tableMatch = normalized.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+"?([A-Za-z0-9_]+)"?/i)
  const table = tableMatch?.[1]
  return table ? `${keyword} ${table}` : keyword
}

export type RawQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>

// 把任一 raw query 函式包一層 `db.query` span：attrs = statement_summary（不含參數值）+
// row_count；duration 由 span 起訖時間免費附帶（不額外計時）。PgDb 與測試共用同一份——測試藉此
// 不必連真的 Postgres 就能驗證 span 真的產生、屬性正確、且 $1 佔位符不會洩漏 params 明文。
export function wrapQueryWithSpan(tracer: Tracer, query: RawQuery): RawQuery {
  return (sql, params) =>
    tracer.startActiveSpan('db.query', async span => {
      try {
        const result = await query(sql, params)
        span.setAttribute('db.statement_summary', summarizeStatement(sql))
        span.setAttribute('db.row_count', result.rowCount)
        return result
      } catch (e) {
        span.recordException(e as Error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw e
      } finally {
        span.end()
      }
    })
}
