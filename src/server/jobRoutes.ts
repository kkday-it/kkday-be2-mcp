import { Router } from 'express'
import { timingSafeEqual } from 'node:crypto'

// Task 10：cron HTTP endpoints——vibe-cloud-ready-spec 的硬約束之一是「排程走 HTTP endpoint
// 非 in-process timer」（見 CLAUDE.md 上雲硬約束）。SCHEDULER_MODE=http 時，外部 cron
// （k8s CronJob）改打這裡的 /api/jobs/scheduler-tick 驅動 tick，而非 process 內的
// setTimeout 迴圈；/api/jobs/oauth-purge 同理取代/補充 `npm run oauth-purge` 手動執行。
//
// 這兩個 job 端點自帶 bearer 驗證（CRON_SECRET），不掛在 /mcp 的 be2 credential 驗證體系上
// ——呼叫方是叢集內的 cron controller，不是 MCP client。deps 全部注入（runPurge/runTick），
// 本檔不知道、也不需要知道背後接的是 Task 9 的 runOAuthPurge 還是 scheduler 的 tick。
export function buildJobRoutes(deps: {
  cronSecret?: string
  runPurge: () => Promise<Record<string, number>>
  runTick: () => Promise<void>
}): Router {
  const r = Router()
  const authed = (header: string | undefined): boolean => {
    if (!deps.cronSecret || !header?.startsWith('Bearer ')) return false
    const got = Buffer.from(header.slice(7)); const want = Buffer.from(deps.cronSecret)
    // 長度檢查本身非常數時間，但 CRON_SECRET 是高熵隨機值、長度不含資訊——可接受（審視紀錄）
    return got.length === want.length && timingSafeEqual(got, want)
  }
  r.post('/api/jobs/:name', async (req, res) => {
    // fail-closed：未設定 CRON_SECRET 時整條路一律拒絕（含格式正確的 header 也一樣），
    // 而非以「沒人能猜對 undefined」這種隱含假設放行。
    if (!deps.cronSecret) { res.status(503).json({ error: 'CRON_SECRET not configured' }); return }
    if (!authed(req.headers.authorization)) { res.status(401).json({ error: 'unauthorized' }); return }
    try {
      if (req.params.name === 'oauth-purge') { res.json(await deps.runPurge()); return }
      // 冪等由 runTick 底層的 CAS（claimScheduled/casStatus）保證，本路由本身不做額外去重
      // ——重複打只是讓 tick 多跑一次「這輪沒有可認領的到期件」，不會產生副作用。
      if (req.params.name === 'scheduler-tick') { await deps.runTick(); res.json({ ok: true }); return }
      res.status(404).json({ error: 'unknown job' })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
  return r
}
