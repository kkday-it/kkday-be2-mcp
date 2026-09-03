import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import express from 'express'
import { buildApp } from '../src/server/app.js'
import { buildJobRoutes } from '../src/server/jobRoutes.js'
import { openTestDb } from './support/testDb.js'
import type { Config } from '../src/config.js'
import type { Db } from '../src/store/dbTypes.js'

// Task 10：cron HTTP endpoints（/api/jobs/oauth-purge、/api/jobs/scheduler-tick）+ SCHEDULER_MODE。
// jobRoutes 自帶 bearer 驗證（CRON_SECRET，常數時間比對），故掛在 hostGuard 之後、MCP bearer
// auth 之前也不會漏防護。這裡分兩層驗證：
// (a) 透過 buildApp 的整合測試——驗證 app.ts 真的把 deps（cronSecret/runPurge/runTick）接對，
//     runPurge 打的是 Task 9 的 runOAuthPurge、runTick 打的是 scheduler 真正的 tick。
// (b) 直接對 buildJobRoutes 的單元測試——用假 deps 驗證 jobRoutes.ts 本身的分支邏輯
//     （缺 header、格式錯誤的 header、業務邏輯拋錯 -> 500），不必牽動整個 app/db/scheduler。

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
    serviceKey: 'sk', port: 0, db: { host: 'localhost', ssl: false },
    schedulerMode: 'poller', otelMode: 'off', scheduleTz: 'Asia/Taipei',
    bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
    ...overrides,
  }
}

async function startApp(config: Config, db: Db): Promise<{ base: string; http: Server }> {
  const app = buildApp({ config, db })
  const http = createServer(app)
  await new Promise<void>(r => http.listen(0, () => r()))
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  return { base, http }
}

describe('job routes — integration (via buildApp)', () => {
  let noSecretBase: string, noSecretHttp: Server
  let securedBase: string, securedHttp: Server
  const SECRET = 'test-cron-secret-value-not-real'

  beforeAll(async () => {
    const dbA = await openTestDb()
    ;({ base: noSecretBase, http: noSecretHttp } = await startApp(baseConfig(), dbA))

    const dbB = await openTestDb()
    ;({ base: securedBase, http: securedHttp } = await startApp(baseConfig({ cronSecret: SECRET }), dbB))
  })

  afterAll(async () => {
    await new Promise<void>(r => noSecretHttp.close(() => r()))
    await new Promise<void>(r => securedHttp.close(() => r()))
  })

  it('case 1: 無 CRON_SECRET 設定 -> 503（fail-closed）', async () => {
    const res = await fetch(`${noSecretBase}/api/jobs/oauth-purge`, { method: 'POST' })
    expect(res.status).toBe(503)
  })

  it('case 2: 錯 bearer -> 401', async () => {
    const res = await fetch(`${securedBase}/api/jobs/oauth-purge`, {
      method: 'POST', headers: { authorization: 'Bearer totally-wrong-secret' },
    })
    expect(res.status).toBe(401)
  })

  it('case 3: 對 bearer -> 200 + JSON 摘要 {expiredAuthCodes, expiredRefresh, ghostIdentities}（真打 runOAuthPurge）', async () => {
    const res = await fetch(`${securedBase}/api/jobs/oauth-purge`, {
      method: 'POST', headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      expiredAuthCodes: expect.any(Number),
      expiredRefresh: expect.any(Number),
      ghostIdentities: expect.any(Number),
    })
  })

  it('case 4: POST /api/jobs/scheduler-tick 對 bearer -> 200 {ok:true}；重複打不炸（冪等靠 CAS）', async () => {
    const call = () => fetch(`${securedBase}/api/jobs/scheduler-tick`, {
      method: 'POST', headers: { authorization: `Bearer ${SECRET}` },
    })
    const first = await call()
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true })

    const second = await call()
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true })
  })

  it('未知 job 名稱 -> 404', async () => {
    const res = await fetch(`${securedBase}/api/jobs/not-a-real-job`, {
      method: 'POST', headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(res.status).toBe(404)
  })
})

describe('job routes — unit (buildJobRoutes with fake deps)', () => {
  function mount(deps: Parameters<typeof buildJobRoutes>[0]) {
    const app = express()
    app.use(express.json())
    app.use(buildJobRoutes(deps))
    return app
  }

  it('沒有 authorization header -> 401（非 503，因為 cronSecret 有設）', async () => {
    const app = mount({ cronSecret: 'abc', runPurge: async () => ({}), runTick: async () => {} })
    const http = createServer(app)
    await new Promise<void>(r => http.listen(0, () => r()))
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
    try {
      const res = await fetch(`${base}/api/jobs/oauth-purge`, { method: 'POST' })
      expect(res.status).toBe(401)
    } finally {
      await new Promise<void>(r => http.close(() => r()))
    }
  })

  it('runPurge 拋錯 -> 500 + 錯誤訊息', async () => {
    const app = mount({
      cronSecret: 'abc',
      runPurge: async () => { throw new Error('boom') },
      runTick: async () => {},
    })
    const http = createServer(app)
    await new Promise<void>(r => http.listen(0, () => r()))
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
    try {
      const res = await fetch(`${base}/api/jobs/oauth-purge`, {
        method: 'POST', headers: { authorization: 'Bearer abc' },
      })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'boom' })
    } finally {
      await new Promise<void>(r => http.close(() => r()))
    }
  })

  it('runTick 拋錯 -> 500', async () => {
    const app = mount({
      cronSecret: 'abc',
      runPurge: async () => ({}),
      runTick: async () => { throw new Error('tick failed') },
    })
    const http = createServer(app)
    await new Promise<void>(r => http.listen(0, () => r()))
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
    try {
      const res = await fetch(`${base}/api/jobs/scheduler-tick`, {
        method: 'POST', headers: { authorization: 'Bearer abc' },
      })
      expect(res.status).toBe(500)
    } finally {
      await new Promise<void>(r => http.close(() => r()))
    }
  })
})
