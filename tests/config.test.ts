import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  AUTHSVC_URL: 'https://auth-220.sit.kkday.com',
  GATEWAY_URL: 'https://api-gateway-220.sit.kkday.com',
  API_AUTH_SERVICE_KEY: 'k',
  DATABASE_URL: 'postgres://u:p@h:5432/d',
}

describe('loadConfig', () => {
  it('loads required vars and applies defaults', () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv)
    expect(cfg.authsvcUrl).toBe(base.AUTHSVC_URL)
    expect(cfg.gatewayUrl).toBe(base.GATEWAY_URL)
    expect(cfg.serviceKey).toBe('k')
    expect(cfg.port).toBe(8787)
    expect(cfg.otelMode).toBe('off')
    expect(cfg.bindHost).toBe('127.0.0.1')
  })

  it('throws a message naming the missing var, without echoing values', () => {
    expect(() => loadConfig({ ...base, API_AUTH_SERVICE_KEY: '' } as NodeJS.ProcessEnv))
      .toThrowError(/API_AUTH_SERVICE_KEY/)

    const noUrl = { ...base }
    delete (noUrl as any).AUTHSVC_URL
    expect(() => loadConfig(noUrl as NodeJS.ProcessEnv))
      .toThrowError(/AUTHSVC_URL/)
  })

  it('host is driven directly by AUTHSVC_URL / GATEWAY_URL (no preset)', () => {
    const cfg = loadConfig({
      AUTHSVC_URL: 'https://auth.stage.kkday.com',
      GATEWAY_URL: 'https://api-gateway.stage.kkday.com',
      API_AUTH_SERVICE_KEY: 'x',
      DATABASE_URL: 'postgres://u:p@h:5432/d',
    } as NodeJS.ProcessEnv)
    expect(cfg.authsvcUrl).toBe('https://auth.stage.kkday.com')
    expect(cfg.gatewayUrl).toBe('https://api-gateway.stage.kkday.com')
    expect(cfg.serviceKey).toBe('x')
  })

  it('defaults bindHost to 127.0.0.1 and allows override', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).bindHost).toBe('127.0.0.1')
    expect(loadConfig({ ...base, APP_BIND_HOST: '0.0.0.0' } as NodeJS.ProcessEnv).bindHost).toBe('0.0.0.0')
  })

  it('publicBaseUrl falls back to loopback when unset, honours override and strips trailing slash', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).publicBaseUrl).toBe('http://127.0.0.1:8787')
    expect(loadConfig({ ...base, APP_PORT: '9000' } as NodeJS.ProcessEnv).publicBaseUrl).toBe('http://127.0.0.1:9000')
    expect(loadConfig({ ...base, APP_BASE_URL: 'https://mcp.stage.kkday.com/' } as NodeJS.ProcessEnv).publicBaseUrl)
      .toBe('https://mcp.stage.kkday.com')
  })

  it('rejects a non-URL APP_BASE_URL without echoing its value', () => {
    expect(() => loadConfig({ ...base, APP_BASE_URL: 'not-a-url' } as NodeJS.ProcessEnv))
      .toThrowError(/APP_BASE_URL/)
  })
})

describe('DB config', () => {
  const base = { AUTHSVC_URL: 'https://a.example', GATEWAY_URL: 'https://g.example', API_AUTH_SERVICE_KEY: 'k' }

  it('DATABASE_URL 短路', () => {
    const cfg = loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@h:5432/d' } as NodeJS.ProcessEnv)
    expect(cfg.db.connectionString).toBe('postgres://u:p@h:5432/d')
  })
  it('DB_* 分開注入', () => {
    const cfg = loadConfig({ ...base, DB_HOST: 'h', DB_PORT: '5432', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'd' } as NodeJS.ProcessEnv)
    expect(cfg.db.host).toBe('h'); expect(cfg.db.database).toBe('d')
  })
  it('缺 DB env → fail fast 且錯誤訊息只含變數名', () => {
    expect(() => loadConfig({ ...base } as NodeJS.ProcessEnv)).toThrow(/DB_HOST|DATABASE_URL/)
    try { loadConfig({ ...base, DB_HOST: 'h' } as NodeJS.ProcessEnv) } catch (e) {
      expect((e as Error).message).not.toContain('p@')  // 不回顯值
    }
  })
  it('APP_DB_PATH 不再被接受為必要條件（已移除）', () => {
    const cfg = loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@h/d' } as NodeJS.ProcessEnv)
    expect((cfg as unknown as Record<string, unknown>).dbPath).toBeUndefined()
  })
  it('SCHEDULER_MODE 預設 poller、可設 http；CRON_SECRET 選填', () => {
    const a = loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@h/d' } as NodeJS.ProcessEnv)
    expect(a.schedulerMode).toBe('poller')
    const b = loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@h/d', SCHEDULER_MODE: 'http', CRON_SECRET: 's' } as NodeJS.ProcessEnv)
    expect(b.schedulerMode).toBe('http'); expect(b.cronSecret).toBe('s')
  })
})
