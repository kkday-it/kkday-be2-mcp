import { z } from 'zod'
import 'dotenv/config'

// 平台 config-manager 對齊：一環境一份 config，無多環境 preset、key 不帶環境前綴。
// host 直接由 AUTHSVC_URL / GATEWAY_URL 給；環境差異由平台各自注入一份，不在 code 內分岔。
// APP_ENV 只當標籤（log），不再選 host / key。
const EnvSchema = z.object({
  APP_ENV: z.enum(['sit', 'stage', 'prod']).optional(),
  AUTHSVC_URL: z.string().url(),
  GATEWAY_URL: z.string().url(),
  API_AUTH_SERVICE_KEY: z.string().min(1),
  APP_PORT: z.coerce.number().int().positive().default(8787),
  OTEL_MODE: z.enum(['console', 'otlp', 'off']).default('off'),
  APP_TZ: z.string().default('Asia/Taipei'),
  APP_BIND_HOST: z.string().default('127.0.0.1'),
  APP_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_NAME: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  SCHEDULER_MODE: z.enum(['poller', 'http']).default('poller'),
})

export interface DbConnection {
  connectionString?: string
  host?: string; port?: number; user?: string; password?: string; database?: string
  ssl: false | { rejectUnauthorized: false }
}

// TLS：本機/測試（localhost 或 PGlite）不需要；RDS 一律 no-verify（cloud spec §2.5）。
// 規則：DATABASE_URL 含 sslmode=disable 或 host 為 localhost/127.0.0.1 → ssl:false，否則 no-verify。
export function resolveDbConnection(env: NodeJS.ProcessEnv): DbConnection {
  if (env.DATABASE_URL) {
    const noSsl = env.DATABASE_URL.includes('sslmode=disable') || /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL)
    return { connectionString: env.DATABASE_URL, ssl: noSsl ? false : { rejectUnauthorized: false } }
  }
  const missing = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter(k => !env[k])
  if (missing.length > 0) throw new Error(`Invalid or missing env vars: DATABASE_URL or ${missing.join(', ')}`)
  const local = env.DB_HOST === 'localhost' || env.DB_HOST === '127.0.0.1'
  return { host: env.DB_HOST, port: Number(env.DB_PORT ?? 5432), user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, ssl: local ? false : { rejectUnauthorized: false } }
}

export interface Config {
  authsvcUrl: string
  gatewayUrl: string
  serviceKey: string
  port: number
  db: DbConnection
  cronSecret?: string
  schedulerMode: 'poller' | 'http'
  otelMode: 'console' | 'otlp' | 'off'
  scheduleTz: string
  bindHost: string
  publicBaseUrl: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map(i => i.path.join('.')).join(', ')
    // Name the vars only — never echo values (they may be secrets).
    throw new Error(`Invalid or missing env vars: ${missing}`)
  }
  const e = parsed.data

  // Fail fast: SCHEDULER_MODE=http requires CRON_SECRET for external cron authentication
  if (e.SCHEDULER_MODE === 'http' && !e.CRON_SECRET) {
    throw new Error('SCHEDULER_MODE=http requires CRON_SECRET (external cron must authenticate)')
  }

  const db = resolveDbConnection(env)

  const publicBaseUrl = (e.APP_BASE_URL ?? `http://127.0.0.1:${e.APP_PORT}`).replace(/\/$/, '')

  return {
    authsvcUrl: e.AUTHSVC_URL.replace(/\/$/, ''),
    gatewayUrl: e.GATEWAY_URL.replace(/\/$/, ''),
    serviceKey: e.API_AUTH_SERVICE_KEY,
    port: e.APP_PORT,
    db,
    cronSecret: e.CRON_SECRET,
    schedulerMode: e.SCHEDULER_MODE,
    otelMode: e.OTEL_MODE,
    scheduleTz: e.APP_TZ,
    bindHost: e.APP_BIND_HOST,
    publicBaseUrl,
  }
}
