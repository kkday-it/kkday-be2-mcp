import { executeChangeSet, type ExecutorDeps } from '../changeset/executor.js'
import type { TokenManager } from '../../auth/tokenManager.js'
import { SCHEDULE_POLICY } from './policy.js'
import { AuthError } from '../../errors.js'

export interface SchedulerDeps extends ExecutorDeps { tokenManager: TokenManager }

// F5 修復：scheduler-tick job endpoint 須依 spec（pg-migration §10、vibe-cloud-ready §2.7）
// 回 JSON 摘要（本輪處理件數/失敗數），而非空 void。這裡把 tick() 內既有的每個階段
// （stranded 回收／到期認領+執行／missed／keep-alive）各自的計數帶出來，不發明新階段。
export interface TickSummary {
  strandedRecovered: number   // (4) 回收 stranded-approved 的件數
  missed: number               // (1)(2)(3) 超過 grace 判定 missed 的件數
  claimed: number               // 到期且贏得 claimScheduled 的件數（進入 runOne）
  executed: number             // claimed 之中，executeChangeSet 成功跑完（done/partial）的件數
  failed: number                // 本輪轉為 failed 的 change-set 總數：claimed 之中 terminal auth
                                 // 失敗／executeChangeSet 回傳 failed，加上 (5) keep-alive terminal
                                 // 失敗連帶 fail 掉的名下排程件（兩個來源都是「這輪失敗掉的件」）
  keepaliveRefreshed: number   // (5) keep-alive 成功續命的 identity 數
  keepaliveFailed: number       // (5) keep-alive 失敗（transient 或 terminal）的 identity 數
}

// 塊 B(spec §7):in-process poller。到期認領/放回/回收全走 ChangeSetStore 的單 statement
// 條件式 UPDATE(CAS)——多實例同時輪詢天然 at-most-once,無 Redis/leader 依賴。
export function makeScheduler(deps: SchedulerDeps, opts: Partial<typeof SCHEDULE_POLICY> = {}) {
  const p = { ...SCHEDULE_POLICY, ...opts }

  // 回傳這一件的處理結果，供 tick() 彙總計數；'skipped' = 輸掉某次 CAS 競態或防禦性
  // early-return（欄位缺損），不計入 executed/failed，下一 tick 視情況重試或已被別的實例處理。
  async function runOne(id: string): Promise<'executed' | 'failed' | 'skipped'> {
    const rec = await deps.changeSets.get(id)
    if (!rec?.schedule || !rec.executorRef) return 'skipped'   // 防禦:欄位缺損不執行
    let who
    try {
      const u = await deps.tokenManager.getFreshByIdentityId(rec.executorRef.identityId)
      // F4：帶出批准當下存進快照的 traceId，讓執行 trace 接上批准 trace（spec §3.5 三方 join）。
      // 舊資料（migration 前排程件）無此值 → undefined → executor 端 fallback randomTraceId()。
      who = { accessToken: u.accessToken, userLabel: rec.executorRef.userLabel,
        modifyUser: rec.executorRef.modifyUser, sessionId: rec.executorRef.sessionId,
        traceId: rec.executorRef.traceId, channel: 'scheduler' as const }
    } catch (e) {
      // spec §7 步驟 3:refresh 失敗分流。terminal(4xx 撤權/identity 消失)→ failed;
      // transient(5xx/網路)→ 放回 scheduled 下 tick 重試(來不來得及由 grace 判準決定)。
      const terminal = e instanceof AuthError
      if (terminal) {
        // CAS 而非 setStatus:若本實例網路卡頓期間,別的實例已透過 stranded 回收把這件放回、
        // 重新認領甚至執行完,無條件寫 failed 會覆寫 executing/done——exactly-once 破功。
        // 只有 claim 仍屬於我(仍在 approved)才允許標 failed。
        if (await deps.changeSets.casStatus(id, 'approved', 'failed', deps.now())) {
          // F2（spec 98 行）：CAS 已把件標 failed，audit 失敗不得外拋——否則整輪 tick 被打斷、
          // 其餘到期件延到下一輪。狀態已定，吞掉即可。
          try {
            await deps.audit.record({ userLabel: rec.executorRef.userLabel, sessionId: rec.executorRef.sessionId,
              clientInfo: 'scheduler', tool: 'schedule.execute',
              params: { changeset_id: id }, status: 'error',
              eventType: 'governance.scheduler', severity: 'ERROR',
              errorMessage: `AUTH_EXPIRED: ${(e as Error).message}`, traceId: 'n/a', durationMs: 0 })
          } catch (err) { console.error('schedule.execute (auth-expired) audit failed:', err) }
          return 'failed'
        }
        return 'skipped'
      } else {
        await deps.changeSets.releaseClaim(id)
      }
      return 'skipped'
    }
    const result = await executeChangeSet(deps, id, who)   // null(輸 CAS)= 別的實例在跑,靜默讓行
    if (result === null) return 'skipped'
    return result.status === 'failed' ? 'failed' : 'executed'
  }

  async function tick(): Promise<TickSummary> {
    const summary: TickSummary = {
      strandedRecovered: 0, missed: 0, claimed: 0, executed: 0, failed: 0,
      keepaliveRefreshed: 0, keepaliveFailed: 0,
    }
    const now = deps.now()
    // (4) stranded-approved 回收(先於認領,放回的件同 tick 即可重拾)
    for (const id of await deps.changeSets.listStrandedApproved(now, p.staleClaimMs)) {
      // 只有真的贏了 releaseClaim 的 CAS 才記 audit——多實例/重疊處理同一件時,輸方不得留下
      // 假的 reclaim 紀錄。
      if (await deps.changeSets.releaseClaim(id)) {
        summary.strandedRecovered++
        // F2（spec 98 行）：releaseClaim 已提交，audit 失敗不得打斷 tick。
        try {
          await deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
            tool: 'schedule.reclaim', params: { changeset_id: id }, status: 'ok',
            eventType: 'governance.scheduler', severity: 'INFO', traceId: 'n/a', durationMs: 0 })
        } catch (err) { console.error('schedule.reclaim audit failed:', err) }
      }
    }
    // (1)(2)(3) 到期處理
    for (const id of await deps.changeSets.listDueScheduled(now)) {
      const dueRec = await deps.changeSets.get(id)
      if (now - (dueRec?.schedule?.executeAtUtc ?? 0) > p.graceMs) {
        // 不帶 decidedAt——missed 是機器事件,保留人工批准時刻(agy plan-review advisory)。
        if (await deps.changeSets.casStatus(id, 'scheduled', 'missed')) {
          summary.missed++
          // F2（spec 98 行）：件已標 missed，audit 失敗不得打斷 tick。
          try {
            await deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
              tool: 'schedule.missed', params: { changeset_id: id }, status: 'error',
              eventType: 'governance.scheduler', severity: 'ERROR',
              errorMessage: 'missed: server was down past the grace window; re-create the schedule',
              traceId: 'n/a', durationMs: 0 })
          } catch (err) { console.error('schedule.missed audit failed:', err) }
        }
        continue
      }
      if (!(await deps.changeSets.claimScheduled(id, now))) continue   // 別的實例贏了
      summary.claimed++
      const outcome = await runOne(id)
      if (outcome === 'executed') summary.executed++
      else if (outcome === 'failed') summary.failed++
    }
    // (5) keep-alive(spec §6)
    const ids = await deps.changeSets.listScheduledIdentityIds()
    if (ids.length) {
      const out = await deps.tokenManager.keepAlive(ids, { windowMs: p.keepAliveWindowMs, claimTtlMs: p.tickMs })
      summary.keepaliveRefreshed += out.refreshed.length
      summary.keepaliveFailed += out.failed.length
      for (const iid of out.refreshed) {
        // F2（spec 98 行）：keep-alive 已續命，audit 失敗不得打斷 tick。
        try {
          await deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
            tool: 'schedule.keepalive', params: { identity: iid }, status: 'ok',
            eventType: 'governance.scheduler', severity: 'INFO', traceId: 'n/a', durationMs: 0 })
        } catch (err) { console.error('schedule.keepalive audit failed:', err) }
      }
      for (const f of out.failed) {
        // F2（spec 98 行）：keep-alive 失敗紀錄，audit 自身失敗不得打斷 tick 的 fail-closed 處理。
        try {
          await deps.audit.record({ userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
            tool: 'schedule.keepalive', params: { identity: f.identityId }, status: 'error',
            eventType: 'governance.scheduler', severity: 'ERROR',
            errorMessage: f.code, traceId: 'n/a', durationMs: 0 })
        } catch (err) { console.error('schedule.keepalive (failed) audit failed:', err) }
        // terminal(撤權/identity 消失):identity 已死,到 T 也必失敗——立即 fail 其名下所有
        // 排程件(fail-closed 提早浮現)。否則 claim TTL 一過,每 tick 重打 auth-service 直到 T
        // (error 洗版 + hammering,agy plan-review round 1)。transient 不動,下 tick 重試。
        if (f.terminal) {
          for (const cid of await deps.changeSets.listScheduledIdsByIdentity(f.identityId)) {
            if (await deps.changeSets.casStatus(cid, 'scheduled', 'failed', now)) {
              // M-1(spec §11):AUTH_EXPIRED audit 歸屬批准者,不是 'scheduler' 這個系統標籤。
              const rec = await deps.changeSets.get(cid)
              summary.failed++
              // F2（spec 98 行）：件已 CAS 標 failed，audit 失敗不得打斷後續件的 fail-closed。
              try {
                await deps.audit.record({
                  userLabel: rec?.executorRef?.userLabel ?? 'scheduler',
                  sessionId: rec?.executorRef?.sessionId ?? 'scheduler',
                  clientInfo: 'scheduler',
                  tool: 'schedule.execute', params: { changeset_id: cid }, status: 'error',
                  eventType: 'governance.scheduler', severity: 'ERROR',
                  errorMessage: `AUTH_EXPIRED (keep-alive): ${f.code}`, traceId: 'n/a', durationMs: 0 })
              } catch (err) { console.error('schedule.execute (keep-alive auth-expired) audit failed:', err) }
            }
          }
        }
      }
    }
    return summary
  }

  // I-2(spec §7):啟動時對 stranded executing 記 audit 警示。`executing` + execute_at_utc 非 null
  // 代表上次 process 掛掉時這件排程件正在寫入途中——可能已部分寫入,不可自動復原,只記 audit
  // 交給人工複核,絕不轉狀態(轉 failed 可能覆寫其實已成功的寫入;轉 done 可能虛報未完成的寫入)。
  async function auditStranded(): Promise<void> {
    for (const id of await deps.changeSets.listExecutingScheduled()) {
      await deps.audit.record({
        userLabel: 'scheduler', sessionId: 'scheduler', clientInfo: 'scheduler',
        tool: 'schedule.stranded_executing', params: { changeset_id: id }, status: 'error',
        eventType: 'governance.scheduler', severity: 'ERROR',
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
    // tick() 現在回 TickSummary（F5 修復），但這裡只用 current 當 stop() 的 await 掛鉤，
    // 不關心 resolve 值——放寬成 unknown 而非硬綁 Promise<void>。
    let current: Promise<unknown> | undefined
    const loop = () => {
      current = tick().catch(err => console.error('scheduler tick error:', (err as Error).message))
        .finally(() => { if (!stopped) timer = setTimeout(loop, p.tickMs) })
    }
    loop()
    return async () => { stopped = true; if (timer) clearTimeout(timer); await current }
  }

  return { tick, start, auditStranded }
}
