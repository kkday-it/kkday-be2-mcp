import { describe, it, expect } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { AuditLog } from '../src/audit/auditLog.js'

describe('AuditLog', () => {
  it('records and reads back an entry', async () => {
    const db = await openTestDb()
    const log = new AuditLog(db, () => 123)
    await log.record({ userLabel: 'p@kkday.com', sessionId: 's1', clientInfo: 'claude-code', tool: 'be2_find_products',
      params: { prod_oids: ['p1'] }, status: 'ok', traceId: 'tr1', durationMs: 42 })
    const rows = await log.recent()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ts: 123, tool: 'be2_find_products', status: 'ok', traceId: 'tr1' })
    expect(rows[0].params).toEqual({ prod_oids: ['p1'] })
    await db.close()
  })
  it('redacts JWT-looking strings in params', async () => {
    const db = await openTestDb()
    const log = new AuditLog(db)
    const jwt = `eyJ${'a'.repeat(30)}.eyJ${'b'.repeat(30)}.sig`
    await log.record({ userLabel: 'u', sessionId: 's', clientInfo: 'c', tool: 't',
      params: { sneaky: jwt }, status: 'ok', traceId: 'tr', durationMs: 1 })
    const rows = await log.recent()
    expect(JSON.stringify(rows[0].params)).not.toContain('eyJa')
    await db.close()
  })
})
