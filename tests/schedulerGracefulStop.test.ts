import { describe, it, expect } from 'vitest'
import { makeScheduler } from '../src/core/schedule/scheduler.js'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('scheduler graceful stop', () => {
  it('stop() awaits the in-flight tick before resolving', async () => {
    const gate = deferred<{ accessToken: string }>()
    const rec = { schedule: { executeAtUtc: 0 }, executorRef: { identityId: 'i', userLabel: 'u', modifyUser: 'm', sessionId: 's' } }
    const changeSets = {
      listStrandedApproved: () => [],
      listDueScheduled: () => ['c1'],
      listScheduledIdentityIds: () => [],
      get: () => rec,
      claimScheduled: () => true,
      casStatus: () => true,
      releaseClaim: () => true,
      listExecutingScheduled: () => [],
    }
    const deps: any = {
      changeSets, gateway: {}, audit: { record() {} }, now: () => 0,
      tokenManager: { getFreshByIdentityId: () => gate.promise, keepAlive: async () => ({ refreshed: [], failed: [] }) },
    }
    const scheduler = makeScheduler(deps, { tickMs: 60_000, graceMs: 1_000_000 })
    const stop = scheduler.start()
    await new Promise(r => setTimeout(r, 10))         // 讓 tick 跑到卡在 gate
    let stopped = false
    const stopP = stop().then(() => { stopped = true })
    await new Promise(r => setTimeout(r, 10))
    expect(stopped).toBe(false)                        // gate 未放行前 stop 不 settle
    gate.resolve({ accessToken: 'a' })                 // 放行 → tick 完成
    await stopP
    expect(stopped).toBe(true)
  })
})
