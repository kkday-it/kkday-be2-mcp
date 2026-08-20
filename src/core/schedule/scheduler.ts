import { executeChangeSet, type ExecutorDeps } from '../changeset/executor.js'
import type { TokenManager } from '../../auth/tokenManager.js'
import { SCHEDULE_POLICY } from './policy.js'
import { AuthError } from '../../errors.js'

export interface SchedulerDeps extends ExecutorDeps { tokenManager: TokenManager }

// 塊 B(spec §7):in-process poller。到期認領/放回/回收全走 ChangeSetStore 的單 statement
// 條件式 UPDATE(CAS)——多實例同時輪詢天然 at-most-once,無 Redis/leader 依賴。
export function makeScheduler(deps: SchedulerDeps, opts: Partial<typeof SCHEDULE_POLICY> = {}) {
  const p = { ...SCHEDULE_POLICY, ...opts }

  async function runOne(id: string): Promise<void> {
    const rec = deps.changeSets.get(id)
    if (!rec?.schedule || !rec.executorRef) return   // 防禦:欄位缺損不執行
    let who
    try {
      const u = await deps.tokenManager.getFreshByIdentityId(rec.executorRef.identityId)
      who = { accessToken: u.accessToken, userLabel: rec.executorRef.userLabel,
        modifyUser: rec.executorRef.modifyUser, sessionId: rec.executorRef.sessionId, channel: 'scheduler' as const }
    } catch (e) {
      // spec §7 步驟 3:refresh 失敗分流。terminal(4xx 撤權/identity 消失)→ failed;
      // transient(5xx/網路)→ 放回 scheduled 下 tick 重試(來不來得及由 grace 判準決定)。
      const terminal = e instanceof AuthError
      if (terminal) {
        // CAS 而非 setStatus:若本實例網路卡頓期間,別的實例已透過 stranded 回收把這件放回、
        // 重新認領甚至執行完,無條件寫 failed 會覆寫 executing/done——exactly-once 破功。
        // 只有 claim 仍屬於我(仍在 approved)才允許標 failed。
        if (deps.changeSets.casStatus(id, 'approved', 'failed', deps.now())) {
          deps.audit.record({ userLabel: rec.executorRef.userLabel, sessionId: rec.executorRef.sessionId,
            clientInfo: 'scheduler', tool: 'schedule.execute',
            params: { changeset_id: id }, status: 'error',
            errorMessage: `AUTH_EXPIRED: ${(e as Error).message}`, traceId: 'n/a', durationMs: 0 })
        }
      } else {
        deps.changeSets.releaseClaim(id)
      }
      return
    }
    await executeChangeSet(deps, id, who)   // null(輸 CAS)= 別的實例在跑,靜默讓行
  }

  async function tick(): Promise<void> {
    const now = deps.now()
    // (4) stranded-approved 回收(先於認領,放回的件同 tick 即可重拾)
    for (const id of deps.changeSets.listStrandedApproved(now, p.staleClaimMs)) {
      // 只有真的贏了 releaseClaim 的 CAS 才記 audit——多實例/重疊處理同一件時,輸方不得留下
      // 假的 reclaim 紀錄。
      if (deps.changeSets.releaseClaim(id)) {
        deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
          tool: 'schedule.reclaim', params: { changeset_id: id }, status: 'ok', traceId: 'n/a', durationMs: 0 })
      }
    }
    // (1)(2)(3) 到期處理
    for (const id of deps.changeSets.listDueScheduled(now)) {
      if (now - (deps.changeSets.get(id)?.schedule?.executeAtUtc ?? 0) > p.graceMs) {
        // 不帶 decidedAt——missed 是機器事件,保留人工批准時刻(agy plan-review advisory)。
        if (deps.changeSets.casStatus(id, 'scheduled', 'missed')) {
          deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
            tool: 'schedule.missed', params: { changeset_id: id }, status: 'error',
            errorMessage: 'missed: server was down past the grace window; re-create the schedule',
            traceId: 'n/a', durationMs: 0 })
        }
        continue
      }
      if (!deps.changeSets.claimScheduled(id, now)) continue   // 別的實例贏了
      await runOne(id)
    }
    // (5) keep-alive(spec §6)
    const ids = deps.changeSets.listScheduledIdentityIds()
    if (ids.length) {
      const out = await deps.tokenManager.keepAlive(ids, { windowMs: p.keepAliveWindowMs, claimTtlMs: p.tickMs })
      for (const iid of out.refreshed) {
        deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
          tool: 'schedule.keepalive', params: { identity: iid }, status: 'ok', traceId: 'n/a', durationMs: 0 })
      }
      for (const f of out.failed) {
        deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
          tool: 'schedule.keepalive', params: { identity: f.identityId }, status: 'error',
          errorMessage: f.code, traceId: 'n/a', durationMs: 0 })
        // terminal(撤權/identity 消失):identity 已死,到 T 也必失敗——立即 fail 其名下所有
        // 排程件(fail-closed 提早浮現)。否則 claim TTL 一過,每 tick 重打 auth-service 直到 T
        // (error 洗版 + hammering,agy plan-review round 1)。transient 不動,下 tick 重試。
        if (f.terminal) {
          for (const cid of deps.changeSets.listScheduledIdsByIdentity(f.identityId)) {
            if (deps.changeSets.casStatus(cid, 'scheduled', 'failed', now)) {
              deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
                tool: 'schedule.execute', params: { changeset_id: cid }, status: 'error',
                errorMessage: `AUTH_EXPIRED (keep-alive): ${f.code}`, traceId: 'n/a', durationMs: 0 })
            }
          }
        }
      }
    }
  }

  function start(): () => void {
    // 啟動即補跑一次(吸收停機期間到點者,spec §7)。遞迴 setTimeout 而非 setInterval——
    // tick 是 async(逐件 await 執行),積壓時單輪可能超過 tickMs;setInterval 會疊加併發 tick
    // (同 process 內重入:連線耗盡、keep-alive 交錯)。下一輪一律在上一輪 settle 後才排。
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = () => {
      void tick().catch(err => console.error('scheduler tick error:', (err as Error).message))
        .finally(() => { if (!stopped) timer = setTimeout(loop, p.tickMs) })
    }
    loop()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }

  return { tick, start }
}
