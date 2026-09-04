import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openTestDb } from '../support/testDb.js'
import { ChangeSetStore } from '../../src/core/changeset/store.js'
import { IdentityStore } from '../../src/store/identityStore.js'
import { CredentialStore } from '../../src/store/credentialStore.js'
import { TokenManager } from '../../src/auth/tokenManager.js'
import { AuditLog } from '../../src/audit/auditLog.js'
import { makeScheduler, type SchedulerDeps } from '../../src/core/schedule/scheduler.js'
import { AuthError, AppError } from '../../src/errors.js'
import type { Db } from '../../src/store/dbTypes.js'

describe('scheduler', () => {
  let db: Db
  let changeSets: ChangeSetStore
  let identities: IdentityStore
  let credentials: CredentialStore
  let audit: AuditLog
  let fakeAuth: any
  let gateway: any
  let nowFn: () => number
  let currentTime = 1000
  let deps: SchedulerDeps
  let putCount = 0

  beforeEach(async () => {
    db = await openTestDb()
    currentTime = 1000
    nowFn = () => currentTime
    changeSets = new ChangeSetStore(db, { now: nowFn })
    identities = new IdentityStore(db)
    credentials = new CredentialStore(db)
    audit = new AuditLog(db, nowFn)

    putCount = 0
    gateway = {
      withTrace() { return this },
      get: async (p: string) => {
        if (p.endsWith('/inventories/status')) return { is_processing: false }
        return {}
      },
      post: async () => ({ i1: { fullday: 10 } }),
      put: async () => { putCount++; return { ok: true } }
    }

    fakeAuth = {
      refresh: vi.fn(async (id: string, ref: string) => {
        return { accessToken: 'header.eyJleHAiOjk5OTk5OTl9.sig', refreshToken: 'new-ref', businessList: [] }
      })
    }

    const tokenManager = new TokenManager({ identities, credentials }, fakeAuth, { now: nowFn })
    deps = { changeSets, gateway, audit, now: nowFn, tokenManager }
  })

  async function seed(id: string, executeAtUtc: number, accessExpiresAt: number = 9999999) {
    await identities.upsert({ identityId: 'id-1', userLabel: 'u', accessToken: 'acc', refreshToken: 'ref', businessList: [], accessExpiresAt, updatedAt: currentTime })
    await changeSets.create({
      id, creatorLabel: 'u', creatorBearerHash: 'bh', sessionId: 'sess', actionType: 'inventory_setting',
      items: [{ item_oid: 'i1', supplier_oid: '0', quantity: 5 }], diff: [], diffVersion: 'v',
      status: 'pending_approval', createdAt: currentTime,
      schedule: { executeAtUtc, wall: '2026-08-20T12:00:00', tz: 'Asia/Taipei' }
    })
    await changeSets.setScheduled(id, { identityId: 'id-1', userLabel: 'u', modifyUser: 'mu', sessionId: 'sess' }, currentTime)
  }

  async function auditRow(tool: string, status?: string): Promise<any> {
    const sql = status
      ? 'SELECT * FROM audit_log WHERE tool=$1 AND status=$2'
      : 'SELECT * FROM audit_log WHERE tool=$1'
    const params = status ? [tool, status] : [tool]
    const res = await db.query(sql, params)
    return res.rows[0]
  }

  const p = { tickMs: 30_000, graceMs: 1_800_000, staleClaimMs: 600_000, keepAliveWindowMs: 60_000 }

  it('1. 到點執行:建 scheduled(executeAtUtc=T)、identity access 未過期 → tick(now=T) 後 status ∈ done 且 gateway PUT 被呼叫', async () => {
    await seed('c1', 2000)
    const s = makeScheduler(deps, p)
    currentTime = 2000
    await s.tick()
    expect((await changeSets.get('c1'))?.status).toBe('done')
    expect(putCount).toBe(1)
  })

  it('2. 未到點:tick(now=T-1) → 仍 scheduled、PUT 未被呼叫', async () => {
    await seed('c2', 2000)
    const s = makeScheduler(deps, p)
    currentTime = 1999
    await s.tick()
    expect((await changeSets.get('c2'))?.status).toBe('scheduled')
    expect(putCount).toBe(0)
  })

  it('3. grace 超窗:tick(now=T+graceMs+1) → status=missed、PUT 未被呼叫、audit 有 schedule.missed', async () => {
    await seed('c3', 2000)
    const s = makeScheduler(deps, p)
    currentTime = 2000 + p.graceMs + 1
    await s.tick()
    expect((await changeSets.get('c3'))?.status).toBe('missed')
    expect(putCount).toBe(0)
    const row = await auditRow('schedule.missed')
    expect(row).toBeDefined()
  })

  it('4. terminal refresh 失敗:identity access 已過期 + fake auth refresh 丟 AuthError 401 → status=failed, audit 記 AUTH_EXPIRED; PUT 未被呼叫', async () => {
    await seed('c4', 2000, 1000) // already expired
    fakeAuth.refresh.mockRejectedValue(new AuthError('REVOKED', 'revoked', 401))
    const s = makeScheduler(deps, p)
    currentTime = 2000
    await s.tick()
    expect((await changeSets.get('c4'))?.status).toBe('failed')
    expect(putCount).toBe(0)
    const row = await auditRow('schedule.execute', 'error')
    expect(row.error_message).toContain('AUTH_EXPIRED')
  })

  it('5. transient refresh 失敗:fake auth refresh 丟 AppError 503 → 放回 scheduled; 下一 tick 成功執行', async () => {
    await seed('c5', 2000, 1000)
    fakeAuth.refresh.mockRejectedValueOnce(new AppError('API_ERROR', '503', 503))
    const s = makeScheduler(deps, p)
    currentTime = 2000
    await s.tick()
    expect((await changeSets.get('c5'))?.status).toBe('scheduled') // 放回
    expect(putCount).toBe(0)

    // next tick recovers
    fakeAuth.refresh.mockResolvedValueOnce({ accessToken: 'header.eyJleHAiOjk5OTk5OTl9.sig', refreshToken: 'new-ref', businessList: [] })
    await s.tick()
    expect((await changeSets.get('c5'))?.status).toBe('done')
    expect(putCount).toBe(1)
  })

  it('6. stranded 回收:手動 claimScheduled 後不執行 → tick(now=claim+staleClaimMs+1) 放回並重新認領執行', async () => {
    await seed('c6', 2000)
    currentTime = 2000
    await changeSets.claimScheduled('c6', currentTime)
    expect((await changeSets.get('c6'))?.status).toBe('approved') // executing state internally

    const s = makeScheduler(deps, p)
    currentTime = 2000 + p.staleClaimMs + 1
    await s.tick()
    expect((await changeSets.get('c6'))?.status).toBe('done')
    expect(putCount).toBe(1)
    const row = await auditRow('schedule.reclaim')
    expect(row).toBeDefined()
  })

  it('7. 併發認領:兩個 makeScheduler 共用同一 db,同 tick 併發 → PUT 僅一次(CAS 去重)', async () => {
    await seed('c7', 2000)
    const s1 = makeScheduler(deps, p)
    const s2 = makeScheduler(deps, p)
    currentTime = 2000
    await Promise.all([s1.tick(), s2.tick()])
    expect((await changeSets.get('c7'))?.status).toBe('done')
    expect(putCount).toBe(1)
  })

  it('8. keep-alive:scheduled 未到點 + identity 將於 window 內到期 → tick 觸發 refresh 且 audit 記 schedule.keepalive; 第二 tick 不重複', async () => {
    await seed('c8', 9_000_000, 1000 + 30_000) // windowMs is 60_000, so expires within window
    const s = makeScheduler(deps, p)
    currentTime = 1000
    await s.tick()
    expect(fakeAuth.refresh).toHaveBeenCalledTimes(1)
    expect((await changeSets.get('c8'))?.status).toBe('scheduled') // not executed yet

    const row = await auditRow('schedule.keepalive')
    expect(row.status).toBe('ok')

    // next tick within TTL doesn't call refresh again
    currentTime = 1000 + 10_000 // 10s passed, still < 30_000 TTL of keepAlive
    await s.tick()
    expect(fakeAuth.refresh).toHaveBeenCalledTimes(1) // unchanged
  })

  it('10. keep-alive 反覆 transient 失敗:claim TTL 節流,TTL 內不重打 auth-service', async () => {
    // transient(5xx)不延壽也不終結 → identity 一直落在 window 內;若無 claim TTL,每 tick 都會
    // hammering auth-service。此測試隔離驗 claimKeepalive 的 TTL 閘門(window 檢查兩輪都會過)。
    await seed('c10', 9_000_000, 1000 + 30_000)
    fakeAuth.refresh.mockRejectedValue(new AppError('API_ERROR', '503', 503))
    const s = makeScheduler(deps, p)
    currentTime = 1000
    await s.tick()
    expect(fakeAuth.refresh).toHaveBeenCalledTimes(1)
    currentTime = 1000 + 10_000   // < claimTtl(=tickMs 30s):window 仍過,但 claim 輸 → 不重打
    await s.tick()
    expect(fakeAuth.refresh).toHaveBeenCalledTimes(1)
    currentTime = 1000 + 41_000   // > claimTtl:重新可認領 → 再試一次
    await s.tick()
    expect(fakeAuth.refresh).toHaveBeenCalledTimes(2)
    expect((await changeSets.get('c10'))?.status).toBe('scheduled')   // transient 永不 fail 排程件
  })

  it('9. keep-alive terminal 失敗:fake auth refresh 丟 AuthError 401 → 該 identity 名下排程件 fail + audit AUTH_EXPIRED,歸屬批准者(M-1)', async () => {
    await seed('c9', 9_000_000, 1000 + 30_000)
    fakeAuth.refresh.mockRejectedValue(new AuthError('REVOKED', 'revoked', 401))
    const s = makeScheduler(deps, p)
    currentTime = 1000
    await s.tick()
    expect((await changeSets.get('c9'))?.status).toBe('failed')

    const errKeepAlive = await auditRow('schedule.keepalive', 'error')
    expect(errKeepAlive).toBeDefined()

    const errExec = await auditRow('schedule.execute', 'error')
    expect(errExec.error_message).toContain('AUTH_EXPIRED (keep-alive)')
    // M-1(spec §11):歸屬批准者(seed() 的 executor userLabel='u'),不是系統標籤 'scheduler'。
    expect(errExec.user_label).toBe('u')
  })

  it('11. I-2:啟動時對 stranded executing 記 audit 警示(schedule.stranded_executing),且不轉狀態', async () => {
    await seed('c11', 2000)
    // 模擬 process 在寫入途中崩潰:排程件卡在 executing(可能已部分寫入,不可自動復原)
    await changeSets.setStatus('c11', 'executing')
    const s = makeScheduler(deps, p)
    await s.auditStranded()
    expect((await changeSets.get('c11'))?.status).toBe('executing') // 只記 audit,不轉狀態
    const row = await auditRow('schedule.stranded_executing')
    expect(row).toBeDefined()
    expect(row.status).toBe('error')
    expect(row.error_message).toContain('manual review required')
  })
})
