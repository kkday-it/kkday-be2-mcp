import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Server } from 'node:http'
import { openTestDb } from './support/testDb.js'
import { IdentityStore } from '../src/store/identityStore.js'
import { buildApp } from '../src/server/app.js'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../src/config.js'
import type { Db } from '../src/store/dbTypes.js'

let backupHtml: string | null = null
describe('Dev Panel Harness (APP_DEV_PANEL flag)', () => {
  let server: Server, base: string, db: Db
  const originalEnv = process.env.APP_DEV_PANEL

  beforeEach(async () => {
    db = await openTestDb()
    await new IdentityStore(db).upsert({
      identityId: 'id-1', userLabel: 'dev@kkday.com', accessToken: 'a', refreshToken: 'r',
      businessList: [], accessExpiresAt: Date.now() + 3600000, updatedAt: Date.now()
    })
    const uiDir = join(process.cwd(), 'dist', 'ui')
    mkdirSync(uiDir, { recursive: true })
    // 不可清掉真建置產物（panel.smoke.test 依賴它；先前 rmSync 造成跨檔順序 flaky）——
    // 先備份真檔，afterAll 還原。
    const real = join(uiDir, 'batch-wizard.html')
    if (existsSync(real)) backupHtml = readFileSync(real, 'utf8')
    writeFileSync(real, '<head></head><body><h1>Panel</h1></body>')
  })

  afterEach(async () => {
    if (server) server.close()
    await db.close()
    const real = join(process.cwd(), 'dist', 'ui', 'batch-wizard.html')
    if (backupHtml != null) writeFileSync(real, backupHtml)
    else rmSync(real, { force: true })
    process.env.APP_DEV_PANEL = originalEnv
  })

  async function startApp() {
    const config: Config = { authsvcUrl: 'http://a', gatewayUrl: 'http://g', serviceKey: 'sk', port: 0, db: { host: 'localhost', ssl: false }, schedulerMode: 'poller', auditStdout: false, otelMode: 'off', scheduleTz: 'Asia/Taipei', bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0' }
    const app = buildApp({ config, db })
    server = app.listen(0)
    await new Promise(r => server.on('listening', r as () => void))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }

  it('flag off → 404 for dev routes', async () => {
    delete process.env.APP_DEV_PANEL
    await startApp()
    const res = await fetch(`${base}/dev/panel/batch-wizard`)
    expect(res.status).toBe(404)
  })

  it('flag on → serves dev panel and executes tool', async () => {
    process.env.APP_DEV_PANEL = '1'
    await startApp()

    // Test GET /dev/panel/batch-wizard
    const res = await fetch(`${base}/dev/panel/batch-wizard`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('__DEV_APP_SHIM__')
    expect(html).toContain('<h1>Panel</h1>')

    // Test GET /dev/panel/unknown
    const unknownRes = await fetch(`${base}/dev/panel/unknown-panel`)
    expect(unknownRes.status).toBe(404)

    // Test POST /dev/panel-tool
    const toolRes = await fetch(`${base}/dev/panel-tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'app_get_changeset_view', arguments: { changeset_id: 'cs1' } })
    })
    expect(toolRes.status).toBe(200)
    const data = await toolRes.json()
    // 不同錯誤路徑 isError 旗標不一：只釘「工具真的執行了且回報 NOT_FOUND」這個行為
    expect(JSON.stringify(data)).toContain('NOT_FOUND')

    // Test POST /dev/panel-tool unknown tool
    const badTool = await fetch(`${base}/dev/panel-tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'be2_find_products', arguments: {} })
    })
    expect(badTool.status).toBe(404)
  })
})
