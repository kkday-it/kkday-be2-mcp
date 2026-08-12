import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const built = join(process.cwd(), 'dist', 'ui', 'products-panel.html')
describe.skipIf(process.env.CI)('panel smoke', () => {
  it('build 產物存在且內嵌 JS（無 __PANEL_JS__ 佔位殘留）', () => {
    expect(existsSync(built)).toBe(true)
    const html = readFileSync(built, 'utf8')
    expect(html).not.toContain('__PANEL_JS__')
    expect(html).toContain('<script>')
  })
})
