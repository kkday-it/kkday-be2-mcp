import { z } from 'zod'
import 'dotenv/config'

const EnvSchema = z.object({
  AUTHSVC_URL: z.string().url(),
  GATEWAY_URL: z.string().url(),
  SIT_AUTHSVC_SERVICE_KEY: z.string().min(1),
  BE2_MCP_PORT: z.coerce.number().int().positive().default(8787),
  BE2_MCP_DB_PATH: z.string().default('./data/be2-mcp.sqlite'),
  OTEL_MODE: z.enum(['console', 'otlp', 'off']).default('off'),
})

export interface Config {
  authsvcUrl: string
  gatewayUrl: string
  serviceKey: string
  port: number
  dbPath: string
  otelMode: 'console' | 'otlp' | 'off'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map(i => i.path.join('.')).join(', ')
    // Name the vars only — never echo values (they may be secrets).
    throw new Error(`Invalid or missing env vars: ${missing}`)
  }
  const e = parsed.data
  return {
    authsvcUrl: e.AUTHSVC_URL.replace(/\/$/, ''),
    gatewayUrl: e.GATEWAY_URL.replace(/\/$/, ''),
    serviceKey: e.SIT_AUTHSVC_SERVICE_KEY,
    port: e.BE2_MCP_PORT,
    dbPath: e.BE2_MCP_DB_PATH,
    otelMode: e.OTEL_MODE,
  }
}
