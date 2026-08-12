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
  })
})
