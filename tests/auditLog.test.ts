import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { AuditLog } from '../src/audit/auditLog.js'

describe('AuditLog', () => {
  it('records and reads back an entry', () => {
    const log = new AuditLog(openDb(':memory:'), () => 123)
    log.record({ userLabel: 'p@kkday.com', sessionId: 's1', clientInfo: 'claude-code', tool: 'be2_find_products',
      params: { prod_oids: ['p1'] }, status: 'ok', traceId: 'tr1', durationMs: 42 })
    const rows = log.recent()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ts: 123, tool: 'be2_find_products', status: 'ok', traceId: 'tr1' })
    expect(rows[0].params).toEqual({ prod_oids: ['p1'] })
  })
  it('redacts JWT-looking strings in params', () => {
    const log = new AuditLog(openDb(':memory:'))
    const jwt = `eyJ${'a'.repeat(30)}.eyJ${'b'.repeat(30)}.sig`
    log.record({ userLabel: 'u', sessionId: 's', clientInfo: 'c', tool: 't',
      params: { sneaky: jwt }, status: 'ok', traceId: 'tr', durationMs: 1 })
    expect(JSON.stringify(log.recent()[0].params)).not.toContain('eyJa')
  })
})
