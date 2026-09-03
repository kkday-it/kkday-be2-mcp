import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wrapTool } from '../src/server/toolPipeline.js'
import { requestContext } from '../src/server/requestContext.js'
import { openTestDb } from './support/testDb.js'
import { AuditLog } from '../src/audit/auditLog.js'
import { RateBudget } from '../src/limits/rateBudget.js'
import { ReadOidStore } from '../src/store/readOidStore.js'
import { AuthError } from '../src/errors.js'
import { makeEnvelope } from '../src/tools/envelope.js'
import { z } from 'zod'
import type { Db } from '../src/store/dbTypes.js'

const tool = {
  name: 't_echo', description: 'echo', inputShape: { v: z.string() },
  handler: vi.fn(async (args: { v: string }) => makeEnvelope([{ v: args.v }], [], ['oid-read-1'])),
}

async function makeDeps(db?: Db) {
  db ??= await openTestDb()
  const readOids = new ReadOidStore(db)
  return {
    db, readOids,
    deps: {
      tokenManager: { getFreshAccessToken: vi.fn(async () => ({ accessToken: 'fake-jwt', userLabel: 'p@kkday.com', businessList: [] })) },
      rateBudget: new RateBudget(db, { perSession: 2, perUserDay: 100 }),
      audit: new AuditLog(db),
      gateway: {} as never,
      readOids,
    } as never,
  }
}

const ctx = { bearer: 'be2mcp_x', sessionId: 'sess1', clientInfo: 'vitest' }

describe('wrapTool pipeline', () => {
  beforeEach(() => { tool.handler.mockClear() })

  it('happy path: returns envelope JSON, audits ok with traceId, persists read_oids', async () => {
    const { db, deps, readOids } = await makeDeps()
    const out = await requestContext.run(ctx, () => wrapTool(tool as never, deps)({ v: 'hi' }))
    expect(out.isError).toBeUndefined()
    const env = JSON.parse(out.content[0].text)
    expect(env.items).toEqual([{ v: 'hi' }])
    const row = (await new AuditLog(db).recent())[0]
    expect(row).toMatchObject({ tool: 't_echo', status: 'ok', sessionId: 'sess1', userLabel: 'p@kkday.com' })
    expect(row.traceId.length).toBeGreaterThan(0)
    expect(await readOids.has('sess1', 'oid-read-1')).toBe(true) // spec §6.2 substrate
  })
  it('no request context -> denied_auth error result, handler not called', async () => {
    const { deps } = await makeDeps()
    const out = await wrapTool(tool as never, deps)({ v: 'hi' })
    expect(out.isError).toBe(true)
    expect(tool.handler).not.toHaveBeenCalled()
  })
  it('unknown bearer -> isError with UNKNOWN_BEARER code, audited denied_auth', async () => {
    const { db, deps } = await makeDeps()
    ;(deps as never as { tokenManager: { getFreshAccessToken: ReturnType<typeof vi.fn> } })
      .tokenManager.getFreshAccessToken.mockRejectedValueOnce(new AuthError('UNKNOWN_BEARER', 'unknown bearer', 401))
    const out = await requestContext.run(ctx, () => wrapTool(tool as never, deps)({ v: 'x' }))
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('UNKNOWN_BEARER')
    expect((await new AuditLog(db).recent())[0].status).toBe('denied_auth')
  })
  it('over session budget -> denied_rate audited, actionable message', async () => {
    const { db, deps } = await makeDeps()
    const wrapped = wrapTool(tool as never, deps)
    await requestContext.run(ctx, async () => { await wrapped({ v: '1' }); await wrapped({ v: '2' }) })
    const out = await requestContext.run(ctx, () => wrapped({ v: '3' }))
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/budget/i)
    expect((await new AuditLog(db).recent())[0].status).toBe('denied_rate')
  })
  it('handler throw -> isError, audited error, no stack leaked, logged to stderr', async () => {
    const { db, deps } = await makeDeps()
    tool.handler.mockRejectedValueOnce(new Error('boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await requestContext.run(ctx, () => wrapTool(tool as never, deps)({ v: 'x' }))
    expect(out.isError).toBe(true)
    expect(out.content[0].text).not.toContain('at ') // no stack frames
    expect((await new AuditLog(db).recent())[0].status).toBe('error')
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0].join(' ')).toContain('t_echo')
    errSpy.mockRestore()
  })
  it('AuthError/RateError path does NOT trigger the generic internal-error console.error', async () => {
    const { deps } = await makeDeps()
    ;(deps as never as { tokenManager: { getFreshAccessToken: ReturnType<typeof vi.fn> } })
      .tokenManager.getFreshAccessToken.mockRejectedValueOnce(new AuthError('UNKNOWN_BEARER', 'unknown bearer', 401))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await requestContext.run(ctx, () => wrapTool(tool as never, deps)({ v: 'x' }))
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
  // Spec §4.3 degrade: a warn-and-proceed envelope (items present + warning entry in errors)
  // must leave an audit trace via the EXISTING audit channel — status stays ok, but the
  // warning lands in error_message so the append-only audit_log shows the degraded gate.
  it('ok-with-warning envelope (items + errors) audits status ok WITH the warning message recorded', async () => {
    const { db, deps } = await makeDeps()
    tool.handler.mockResolvedValueOnce(
      makeEnvelope([{ ok: 1 }], [{ key: 'inventory_platform', code: 'ACTION_CODE_UNVERIFIED', message: 'not in businessList; /verify remains authoritative' }]))
    const out = await requestContext.run(ctx, () => wrapTool(tool as never, deps)({ v: 'x' }))
    expect(out.isError).toBeUndefined()
    const row = (await new AuditLog(db).recent())[0]
    expect(row.status).toBe('ok')
    expect(row.errorMessage).toContain('ACTION_CODE_UNVERIFIED')
  })
  it('fully-failed read (empty items, non-empty errors) is audited as error, not ok', async () => {
    const { db, deps } = await makeDeps()
    tool.handler.mockResolvedValueOnce(
      makeEnvelope([], [{ key: 'x', message: 'boom', code: 'FORBIDDEN', status: 403 }]))
    const out = await requestContext.run(ctx, () => wrapTool(tool as never, deps)({ v: 'x' }))
    expect(out.isError).toBeUndefined()
    const env = JSON.parse(out.content[0].text)
    expect(env.errors[0]).toMatchObject({ code: 'FORBIDDEN' })
    const row = (await new AuditLog(db).recent())[0]
    expect(row.status).toBe('error')
    expect(row.errorMessage).toBeTruthy()
    expect(row.errorMessage).toContain('boom')
  })
})
