import { z } from 'zod'
import 'dotenv/config'

const PRESETS = {
  // SIT 有多台機器（be2-220/221…）；用機器別名而非籠統 'sit'，避免打錯機器。'sit' 保留為向後相容別名。
  'sit-220': {
    authsvcUrl: 'https://auth-220.sit.kkday.com',
    gatewayUrl: 'https://api-gateway-220.sit.kkday.com',
    keyVar: 'SIT_AUTHSVC_SERVICE_KEY',
    announceKeyVar: 'SIT_ANNOUNCE_API_KEY',
  },
  sit: {
    authsvcUrl: 'https://auth-220.sit.kkday.com',
    gatewayUrl: 'https://api-gateway-220.sit.kkday.com',
    keyVar: 'SIT_AUTHSVC_SERVICE_KEY',
    announceKeyVar: 'SIT_ANNOUNCE_API_KEY',
  },
  stage: {
    authsvcUrl: 'https://auth.stage.kkday.com',
    gatewayUrl: 'https://api-gateway.stage.kkday.com',
    keyVar: 'STAGE_AUTHSVC_SERVICE_KEY',
    announceKeyVar: 'STAGE_ANNOUNCE_API_KEY',
  },
  prod: {
    authsvcUrl: 'https://auth.kkday.com',
    gatewayUrl: 'https://api-gateway.kkday.com',
    keyVar: 'PRODUCTION_AUTHSVC_SERVICE_KEY', // 待正式確認
    announceKeyVar: 'PROD_ANNOUNCE_API_KEY',
  },
} as const

// env→announce x-api-key 變數名的單一事實來源（對齊上方 keyVar 慣例）。
// svcB2cClient.ts 的 resolveAnnounceApiKey() 只消費此映射，不自行硬編。
export function announceKeyVarFor(env: string): string {
  return (PRESETS as Record<string, { announceKeyVar?: string }>)[env]?.announceKeyVar ?? 'SIT_ANNOUNCE_API_KEY'
}

const EnvSchema = z.object({
  BE2_ENV: z.enum(['sit-220', 'sit', 'stage', 'prod']).optional(),
  AUTHSVC_URL: z.string().url(),
  GATEWAY_URL: z.string().url(),
  SIT_AUTHSVC_SERVICE_KEY: z.string().min(1).optional(),
  BE2_MCP_PORT: z.coerce.number().int().positive().default(8787),
  BE2_MCP_DB_PATH: z.string().default('./data/be2-mcp.sqlite'),
  OTEL_MODE: z.enum(['console', 'otlp', 'off']).default('off'),
  BE2_TZ: z.string().default('Asia/Taipei'),
  BE2_MCP_BIND_HOST: z.string().default('127.0.0.1'),
  BE2_MCP_PUBLIC_BASE_URL: z.string().url().optional(),
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
  const be2Env = env.BE2_ENV as 'sit-220' | 'sit' | 'stage' | 'prod' | undefined
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

  const publicBaseUrl = (e.BE2_MCP_PUBLIC_BASE_URL ?? `http://127.0.0.1:${e.BE2_MCP_PORT}`).replace(/\/$/, '')

  return {
    authsvcUrl: e.AUTHSVC_URL.replace(/\/$/, ''),
    gatewayUrl: e.GATEWAY_URL.replace(/\/$/, ''),
    serviceKey,
    port: e.BE2_MCP_PORT,
    dbPath,
    otelMode: e.OTEL_MODE,
    scheduleTz: e.BE2_TZ,
    bindHost: e.BE2_MCP_BIND_HOST,
    publicBaseUrl,
  }
}
