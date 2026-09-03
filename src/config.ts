import { z } from 'zod'
import 'dotenv/config'

// 平台 config-manager 對齊：一環境一份 config，無多環境 preset、key 不帶環境前綴。
// host 直接由 AUTHSVC_URL / GATEWAY_URL 給；環境差異由平台各自注入一份，不在 code 內分岔。
// APP_ENV 只當標籤（log / dbPath 後綴），不再選 host / key。
const EnvSchema = z.object({
  APP_ENV: z.enum(['sit', 'stage', 'prod']).optional(),
  AUTHSVC_URL: z.string().url(),
  GATEWAY_URL: z.string().url(),
  API_AUTH_SERVICE_KEY: z.string().min(1),
  APP_PORT: z.coerce.number().int().positive().default(8787),
  APP_DB_PATH: z.string().optional(),
  OTEL_MODE: z.enum(['console', 'otlp', 'off']).default('off'),
  APP_TZ: z.string().default('Asia/Taipei'),
  APP_BIND_HOST: z.string().default('127.0.0.1'),
  APP_BASE_URL: z.string().url().optional(),
})

export interface Config {
  authsvcUrl: string
  gatewayUrl: string
  serviceKey: string
  port: number
  dbPath: string
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

  let dbPath = e.APP_DB_PATH
  if (!dbPath) {
    dbPath = e.APP_ENV ? `./data/be2-mcp-${e.APP_ENV}.sqlite` : './data/be2-mcp.sqlite'
  }

  const publicBaseUrl = (e.APP_BASE_URL ?? `http://127.0.0.1:${e.APP_PORT}`).replace(/\/$/, '')

  return {
    authsvcUrl: e.AUTHSVC_URL.replace(/\/$/, ''),
    gatewayUrl: e.GATEWAY_URL.replace(/\/$/, ''),
    serviceKey: e.API_AUTH_SERVICE_KEY,
    port: e.APP_PORT,
    dbPath,
    otelMode: e.OTEL_MODE,
    scheduleTz: e.APP_TZ,
    bindHost: e.APP_BIND_HOST,
    publicBaseUrl,
  }
}
