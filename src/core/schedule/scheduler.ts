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
    const rec = await deps.changeSets.get(id)
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
        if (await deps.changeSets.casStatus(id, 'approved', 'failed', deps.now())) {
          await deps.audit.record({ userLabel: rec.executorRef.userLabel, sessionId: rec.executorRef.sessionId,
            clientInfo: 'scheduler', tool: 'schedule.execute',
            params: { changeset_id: id }, status: 'error',
            errorMessage: `AUTH_EXPIRED: ${(e as Error).message}`, traceId: 'n/a', durationMs: 0 })
        }
      } else {
        await deps.changeSets.releaseClaim(id)
      }
      return
    }
    await executeChangeSet(deps, id, who)   // null(輸 CAS)= 別的實例在跑,靜默讓行
  }

  async function tick(): Promise<void> {
    const now = deps.now()
    // (4) stranded-approved 回收(先於認領,放回的件同 tick 即可重拾)
    for (const id of await deps.changeSets.listStrandedApproved(now, p.staleClaimMs)) {
      // 只有真的贏了 releaseClaim 的 CAS 才記 audit——多實例/重疊處理同一件時,輸方不得留下
      // 假的 reclaim 紀錄。
      if (await deps.changeSets.releaseClaim(id)) {
        await deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
          tool: 'schedule.reclaim', params: { changeset_id: id }, status: 'ok', traceId: 'n/a', durationMs: 0 })
      }
    }
    // (1)(2)(3) 到期處理
    for (const id of await deps.changeSets.listDueScheduled(now)) {
      const dueRec = await deps.changeSets.get(id)
      if (now - (dueRec?.schedule?.executeAtUtc ?? 0) > p.graceMs) {
        // 不帶 decidedAt——missed 是機器事件,保留人工批准時刻(agy plan-review advisory)。
        if (await deps.changeSets.casStatus(id, 'scheduled', 'missed')) {
          await deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
            tool: 'schedule.missed', params: { changeset_id: id }, status: 'error',
            errorMessage: 'missed: server was down past the grace window; re-create the schedule',
            traceId: 'n/a', durationMs: 0 })
        }
        continue
      }
      if (!(await deps.changeSets.claimScheduled(id, now))) continue   // 別的實例贏了
      await runOne(id)
    }
    // (5) keep-alive(spec §6)
    const ids = await deps.changeSets.listScheduledIdentityIds()
    if (ids.length) {
      const out = await deps.tokenManager.keepAlive(ids, { windowMs: p.keepAliveWindowMs, claimTtlMs: p.tickMs })
      for (const iid of out.refreshed) {
        await deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
          tool: 'schedule.keepalive', params: { identity: iid }, status: 'ok', traceId: 'n/a', durationMs: 0 })
      }
      for (const f of out.failed) {
        await deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
          tool: 'schedule.keepalive', params: { identity: f.identityId }, status: 'error',
          errorMessage: f.code, traceId: 'n/a', durationMs: 0 })
        // terminal(撤權/identity 消失):identity 已死,到 T 也必失敗——立即 fail 其名下所有
        // 排程件(fail-closed 提早浮現)。否則 claim TTL 一過,每 tick 重打 auth-service 直到 T
        // (error 洗版 + hammering,agy plan-review round 1)。transient 不動,下 tick 重試。
        if (f.terminal) {
          for (const cid of await deps.changeSets.listScheduledIdsByIdentity(f.identityId)) {
            if (await deps.changeSets.casStatus(cid, 'scheduled', 'failed', now)) {
              // M-1(spec §11):AUTH_EXPIRED audit 歸屬批准者,不是 'scheduler' 這個系統標籤。
              const rec = await deps.changeSets.get(cid)
              await deps.audit.record({
                userLabel: rec?.executorRef?.userLabel ?? 'scheduler',
                sessionId: rec?.executorRef?.sessionId ?? 'scheduler',
                clientInfo: 'scheduler',
                tool: 'schedule.execute', params: { changeset_id: cid }, status: 'error',
                errorMessage: `AUTH_EXPIRED (keep-alive): ${f.code}`, traceId: 'n/a', durationMs: 0 })
            }
          }
        }
      }
    }
  }

  // I-2(spec §7):啟動時對 stranded executing 記 audit 警示。`executing` + execute_at_utc 非 null
  // 代表上次 process 掛掉時這件排程件正在寫入途中——可能已部分寫入,不可自動復原,只記 audit
  // 交給人工複核,絕不轉狀態(轉 failed 可能覆寫其實已成功的寫入;轉 done 可能虛報未完成的寫入)。
  async function auditStranded(): Promise<void> {
    for (const id of await deps.changeSets.listExecutingScheduled()) {
      await deps.audit.record({
        userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
        tool: 'schedule.stranded_executing', params: { changeset_id: id }, status: 'error',
        errorMessage: 'stranded in executing (process crash mid-execution?); manual review required',
        traceId: 'n/a', durationMs: 0,
      })
    }
  }

  function start(): () => Promise<void> {
    // 啟動即補跑一次(吸收停機期間到點者,spec §7)。遞迴 setTimeout 而非 setInterval——
    // tick 是 async(逐件 await 執行),積壓時單輪可能超過 tickMs;setInterval 會疊加併發 tick
    // (同 process 內重入:連線耗盡、keep-alive 交錯)。下一輪一律在上一輪 settle 後才排。
    // 只在 start() 首次執行時跑一次,不進 tick 迴圈；start() 本身維持同步簽章（呼叫端把它當
    // 同步函式立即取回 stop callback），故此處不 await——刻意 fire-and-forget，用 void +
    // .catch 明確標記、避免 unhandled rejection（Task 7 await 化的既有慣例）。
    void auditStranded().catch(err => console.error('scheduler auditStranded error:', (err as Error).message))
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: Promise<void> | undefined
    const loop = () => {
      current = tick().catch(err => console.error('scheduler tick error:', (err as Error).message))
        .finally(() => { if (!stopped) timer = setTimeout(loop, p.tickMs) })
    }
    loop()
    return async () => { stopped = true; if (timer) clearTimeout(timer); await current }
  }

  return { tick, start, auditStranded }
}
