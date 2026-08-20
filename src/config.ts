import { z } from 'zod'
import 'dotenv/config'

const PRESETS = {
  sit: {
    authsvcUrl: 'https://auth-220.sit.kkday.com',
    gatewayUrl: 'https://api-gateway-220.sit.kkday.com',
    keyVar: 'SIT_AUTHSVC_SERVICE_KEY',
  },
  stage: {
    authsvcUrl: 'https://auth.stage.kkday.com',
    gatewayUrl: 'https://api-gateway.stage.kkday.com',
    keyVar: 'STAGE_AUTHSVC_SERVICE_KEY',
  },
  prod: {
    authsvcUrl: 'https://auth.kkday.com',
    gatewayUrl: 'https://api-gateway.kkday.com',
    keyVar: 'PRODUCTION_AUTHSVC_SERVICE_KEY', // 待正式確認
  },
} as const

const EnvSchema = z.object({
  BE2_ENV: z.enum(['sit', 'stage', 'prod']).optional(),
  AUTHSVC_URL: z.string().url(),
  GATEWAY_URL: z.string().url(),
  SIT_AUTHSVC_SERVICE_KEY: z.string().min(1).optional(),
  BE2_MCP_PORT: z.coerce.number().int().positive().default(8787),
  BE2_MCP_DB_PATH: z.string().default('./data/be2-mcp.sqlite'),
  OTEL_MODE: z.enum(['console', 'otlp', 'off']).default('off'),
  BE2_TZ: z.string().default('Asia/Taipei'),
})

export interface Config {
  authsvcUrl: string
  gatewayUrl: string
  serviceKey: string
  port: number
  dbPath: string
  otelMode: 'console' | 'otlp' | 'off'
  scheduleTz: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const be2Env = env.BE2_ENV as 'sit' | 'stage' | 'prod' | undefined
  const preset = be2Env ? PRESETS[be2Env] : undefined

  const patchedEnv = { ...env }
  if (preset) {
    if (!patchedEnv.AUTHSVC_URL) patchedEnv.AUTHSVC_URL = preset.authsvcUrl
    if (!patchedEnv.GATEWAY_URL) patchedEnv.GATEWAY_URL = preset.gatewayUrl
  }

  const parsed = EnvSchema.safeParse(patchedEnv)
  if (!parsed.success) {
    const missing = parsed.error.issues.map(i => i.path.join('.')).join(', ')
    // Name the vars only — never echo values (they may be secrets).
    throw new Error(`Invalid or missing env vars: ${missing}`)
  }
  const e = parsed.data

  const serviceKey = be2Env ? env[preset!.keyVar] : e.SIT_AUTHSVC_SERVICE_KEY
  if (!serviceKey) {
    const keyName = be2Env ? preset!.keyVar : 'SIT_AUTHSVC_SERVICE_KEY'
    throw new Error(`Invalid or missing env vars: ${keyName}`)
  }

  let dbPath = e.BE2_MCP_DB_PATH
  if (be2Env && !env.BE2_MCP_DB_PATH) {
    dbPath = `./data/be2-mcp-${be2Env}.sqlite`
  }

  return {
    authsvcUrl: e.AUTHSVC_URL.replace(/\/$/, ''),
    gatewayUrl: e.GATEWAY_URL.replace(/\/$/, ''),
    serviceKey,
    port: e.BE2_MCP_PORT,
    dbPath,
    otelMode: e.OTEL_MODE,
    scheduleTz: e.BE2_TZ,
  }
}
