import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const built = join(process.cwd(), 'dist', 'ui', 'products-panel.html')
const builtChangeset = join(process.cwd(), 'dist', 'ui', 'changeset-panel.html')
describe.skipIf(process.env.CI)('panel smoke', () => {
  it('build 產物存在且內嵌 JS（無 __PANEL_JS__ 佔位殘留）', () => {
    expect(existsSync(built)).toBe(true)
    const html = readFileSync(built, 'utf8')
    expect(html).not.toContain('__PANEL_JS__')
    expect(html).toContain('<script>')
  })

  it('change-set 面板產物內嵌 app tool 呼叫與 openLink 輪詢邏輯', () => {
    expect(existsSync(builtChangeset)).toBe(true)
    const html = readFileSync(builtChangeset, 'utf8')
    expect(html).not.toContain('__PANEL_JS__')
    expect(html).toContain('app_get_changeset_view')
    expect(html).toContain('app_get_confirm_link')
    expect(html).toContain('openLink')
    expect(html).toContain('expired') // TERMINAL_STATUSES 常數需含 'expired'，否則 expired 的 change-set 會被無限輪詢
  })

  it('change-set 面板內嵌批准 UI：勾選 + app_confirm_changeset 呼叫 + 高風險二次確認', () => {
    expect(existsSync(builtChangeset)).toBe(true)
    const html = readFileSync(builtChangeset, 'utf8')
    // Task 12（T6 PASS 分支）：nonce+diff_version 通道、逐筆勾選、確認/拒絕、高風險 banner。
    // 中文按鈕文字在 esbuild 輸出中會被轉成 \uXXXX 逸出序列，故以下只斷言 ASCII 識別字/常數，
    // 不斷言中文字面（那些已由 tests/ui/panelApproval.test.ts 之類的行為測試涵蓋，見 CI 全綠）。
    expect(html).toContain('app_confirm_changeset')
    expect(html).toContain('confirmed_keys')
    expect(html).toContain('diff_version')
    expect(html).toContain('checkbox')
    expect(html).toContain('DIFF_STALE')
    expect(html).toContain('doConfirm')
    expect(html).toContain('renderApprovalControls')
    expect(html).toContain('showHighRiskConfirm')
    expect(html).toContain('HIGH_RISK_ACTIONS')
    expect(html).toContain('inventory_setting') // 高風險 action_type 白名單
  })
})
