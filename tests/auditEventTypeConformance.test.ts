import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// G6 conformance：src/ 下每個 audit.record({...}) 呼叫點都必須明確標 eventType——
// fallback 'tool_call' 只保留給 migration 前的歷史資料列，不給任何存活程式碼路徑（spec §3.1）。
describe('audit eventType conformance', () => {
  it('every audit.record call site declares an explicit eventType', () => {
    const files = execSync("grep -rl 'audit\\.record(' src/ --include='*.ts'", { encoding: 'utf8', cwd: '/Users/lance.chien/Documents/Projects/kkday-be2-mcp' })
      .trim().split('\n').filter(Boolean)
    const offenders: string[] = []
    for (const f of files) {
      if (f.endsWith('src/audit/auditLog.ts')) continue // 定義處本身
      const src = readFileSync('/Users/lance.chien/Documents/Projects/kkday-be2-mcp/' + f, 'utf8')
      let idx = 0
      while ((idx = src.indexOf('audit.record(', idx)) !== -1) {
        const window = src.slice(idx, idx + 900) // 呼叫點物件字面值都在 900 字內
        if (!window.includes('eventType:')) offenders.push(`${f}@${idx}`)
        idx += 1
      }
    }
    expect(offenders).toEqual([])
  })
})
