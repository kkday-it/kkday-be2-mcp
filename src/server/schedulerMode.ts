import type { Config } from '../config.js'

// Task 10：SCHEDULER_MODE=poller（預設）-> index.ts 啟動 in-process 輪詢（app.locals.startScheduler）；
// =http -> 改由外部 cron 打 /api/jobs/scheduler-tick，process 內完全不跑 setTimeout 迴圈
// （cloud-ready 約束：排程走 HTTP endpoint 非 in-process timer）。
// 純函式抽出：index.ts 本身在 import 時就會跑 loadConfig()/app.listen() 等 side effect、
// 無法直接單元測試該分支，這裡把「該不該啟動 poller」的判斷單獨拉出來測。
export function shouldStartPoller(config: Pick<Config, 'schedulerMode'>): boolean {
  return config.schedulerMode === 'poller'
}
