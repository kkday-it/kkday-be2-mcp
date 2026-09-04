import { createServer, type Server } from 'node:http'
import { buildApp } from '../../src/server/app.js'
import { openTestDb } from './testDb.js'
import { AuditLog } from '../../src/audit/auditLog.js'
import type { Config } from '../../src/config.js'
import type { Db } from '../../src/store/dbTypes.js'
import type express from 'express'

export async function buildTestApp(configOverrides: Partial<Config> = {}): Promise<{
  app: express.Express; audit: AuditLog; db: Db; server: Server; base: string; close: () => Promise<void>
}> {
  const db = await openTestDb()
  const config: Config = {
    authsvcUrl: 'https://auth.invalid', gatewayUrl: 'https://gw.invalid',
    serviceKey: 'sk', port: 0, db: { host: 'localhost', ssl: false }, schedulerMode: 'poller',
    auditStdout: false, otelMode: 'off', scheduleTz: 'Asia/Taipei',
    bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0', ...configOverrides,
  }
  const app = buildApp({ config, db })
  const server = createServer(app)
  await new Promise<void>(r => server.listen(0, () => r()))
  const address = server.address() as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  
  return { 
    app, 
    audit: new AuditLog(db), 
    db, 
    server,
    base,
    close: async () => {
      server.close()
      await db.close()
    } 
  }
}
