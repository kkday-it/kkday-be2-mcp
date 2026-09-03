import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildApp } from '../src/server/app.js'
import { openTestDb } from './support/testDb.js'
import type { Config } from '../src/config.js'
import type { Db } from '../src/store/dbTypes.js'

const config: Config = {
  authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
  serviceKey: 'sk', port: 0, db: { host: 'localhost', ssl: false }, schedulerMode: 'poller', otelMode: 'off', scheduleTz: 'Asia/Taipei',
  bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
}
let http: Server, base: string, db: Db
beforeAll(async () => {
  db = await openTestDb()
  http = createServer(buildApp({ config, db }))
  await new Promise<void>(r => http.listen(0, () => r()))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterAll(() => { http.close() })   // db 由 503 測試關掉

describe('GET /readyz', () => {
  it('returns 200 ready when the DB is open', async () => {
    const r = await fetch(`${base}/readyz`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ status: 'ready' })
  })
  it('is exempt from the Host guard (arbitrary Host still 200)', async () => {
    const r = await fetch(`${base}/readyz`, { headers: { Host: 'evil.example' } })
    expect(r.status).toBe(200)
  })
  it('returns 503 not-ready when the DB is closed', async () => {
    await db.close()
    const r = await fetch(`${base}/readyz`)
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ status: 'not-ready' })
  })
})
