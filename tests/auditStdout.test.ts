import { describe, it, expect, vi, afterEach } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { AuditLog } from '../src/audit/auditLog.js'

const ENTRY = { userLabel: 'u@kkday.com', sessionId: 's1', clientInfo: 'c', tool: 'be2_find_products',
  params: { q: 'x' }, status: 'ok' as const, traceId: 'tr123', durationMs: 5 }

describe('AuditLog stdout sink (G9)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('emits one ECS-mapped JSON line when stdout is on', async () => {
    const db = await openTestDb()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s) })
    const log = new AuditLog(db, () => 1725400000000, { stdout: true, env: 'sit' })
    await log.record({ ...ENTRY, eventType: 'approval', severity: 'INFO' })
    expect(lines).toHaveLength(1)
    const j = JSON.parse(lines[0])
    expect(j).toMatchObject({
      'system.service_name': 'be2-mcp', env: 'sit',
      'user.name': 'u@kkday.com', 'event.type': 'approval', 'log.level': 'INFO',
      'trace.id': 'tr123', 'mcp.tool': 'be2_find_products', 'mcp.status': 'ok',
    })
    expect(j['@timestamp']).toBe(new Date(1725400000000).toISOString())
    await db.close()
  })

  it('redacts JWTs in the stdout line too', async () => {
    const db = await openTestDb()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s) })
    const log = new AuditLog(db, Date.now, { stdout: true })
    const jwt = `eyJ${'a'.repeat(30)}.eyJ${'b'.repeat(30)}.sig`
    await log.record({ ...ENTRY, params: { sneaky: jwt } })
    expect(lines[0]).not.toContain('eyJa')
    await db.close()
  })

  it('stdout throw does not affect the DB write', async () => {
    const db = await openTestDb()
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('stdout dead') })
    const log = new AuditLog(db, Date.now, { stdout: true })
    await log.record(ENTRY)                          // 不得 throw
    expect(await log.recent()).toHaveLength(1)       // DB 軌完好
    await db.close()
  })

  it('emits stdout BEFORE the DB write (DB throw must not erase the SIEM trail)', async () => {
    const db = await openTestDb()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s) })
    const brokenDb = { ...db, query: () => { throw new Error('db down') } }
    const log = new AuditLog(brokenDb as never, Date.now, { stdout: true })
    await expect(log.record(ENTRY)).rejects.toThrow('db down')  // DB 例外照拋
    expect(lines).toHaveLength(1)                               // stdout 已先落
    await db.close()
  })

  it('flag off => zero stdout output', async () => {
    const db = await openTestDb()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s) })
    const log = new AuditLog(db)
    await log.record(ENTRY)
    expect(lines).toHaveLength(0)
    await db.close()
  })
})
