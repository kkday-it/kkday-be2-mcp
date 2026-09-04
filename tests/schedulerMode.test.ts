import { describe, it, expect } from 'vitest'
import { shouldStartPoller } from '../src/server/schedulerMode.js'

// Task 10：SCHEDULER_MODE=http 時 index.ts 不啟動 in-process poller（改由外部 cron 打
// /api/jobs/scheduler-tick）。index.ts 本身在 import 時就會跑 loadConfig()/app.listen() 等
// side effect、不可直接單元測試，故把「該不該啟動 poller」這個純判斷抽成獨立函式。
describe('shouldStartPoller', () => {
  it('schedulerMode=poller（預設）-> true', () => {
    expect(shouldStartPoller({ schedulerMode: 'poller' })).toBe(true)
  })

  it('schedulerMode=http -> false（排程走 HTTP endpoint，非 in-process timer）', () => {
    expect(shouldStartPoller({ schedulerMode: 'http' })).toBe(false)
  })
})
