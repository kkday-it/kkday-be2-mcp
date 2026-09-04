import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// G6 conformance：src/ 下每個 audit.record({...}) 呼叫點都必須明確標 eventType——
// fallback 'tool_call' 只保留給 migration 前的歷史資料列，不給任何存活程式碼路徑（spec §3.1）。
// 檢查窗以「下一個 audit.record( 出現處」為界（上限 900 字）：固定寬度窗會被緊鄰呼叫點
// （scheduler.ts 兩點僅隔 ~326 字）的 eventType 誤滿足，漏標就靜默放行。
describe('audit eventType conformance', () => {
  it('every audit.record call site declares an explicit eventType', () => {
    // vitest cwd = repo root；一律相對路徑，worktree/CI 皆可跑。
    const files = execSync("grep -rl 'audit\\.record(' src/ --include='*.ts'", { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    const offenders: string[] = []
    for (const f of files) {
      if (f.endsWith('src/audit/auditLog.ts')) continue // 定義處本身
      const src = readFileSync(f, 'utf8')
      const marker = 'audit.record('
      let idx = 0
      while ((idx = src.indexOf(marker, idx)) !== -1) {
        const next = src.indexOf(marker, idx + marker.length)
        const end = Math.min(next === -1 ? src.length : next, idx + 900)
        const window = src.slice(idx, end)
        if (!window.includes('eventType:')) offenders.push(`${f}@${idx}`)
        idx += marker.length
      }
    }
    expect(offenders).toEqual([])
  })

  it('the window logic actually catches a stripped eventType (self-mutation check)', () => {
    // 反例自證：把 scheduler 某呼叫點的 eventType 拿掉後，同一套邏輯必須抓得到——
    // 防止未來有人把窗界改回固定寬度而讓鄰近呼叫點互相掩護。
    const src = readFileSync('src/core/schedule/scheduler.ts', 'utf8')
    const marker = 'audit.record('
    const first = src.indexOf(marker)
    expect(first).toBeGreaterThan(-1)
    const next = src.indexOf(marker, first + marker.length)
    const end = Math.min(next === -1 ? src.length : next, first + 900)
    const original = src.slice(first, end)
    expect(original).toContain('eventType:')
    const mutated = original.replace(/eventType: '[^']+',?\s*/, '')
    expect(mutated).not.toContain('eventType:')   // 窗內移除後，本窗必須驗不過
  })
})
