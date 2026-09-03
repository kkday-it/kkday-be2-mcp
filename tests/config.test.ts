import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  AUTHSVC_URL: 'https://auth-220.sit.kkday.com',
  GATEWAY_URL: 'https://api-gateway-220.sit.kkday.com',
  API_AUTH_SERVICE_KEY: 'k',
}

describe('loadConfig', () => {
  it('loads required vars and applies defaults', () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv)
    expect(cfg.authsvcUrl).toBe(base.AUTHSVC_URL)
    expect(cfg.gatewayUrl).toBe(base.GATEWAY_URL)
    expect(cfg.serviceKey).toBe('k')
    expect(cfg.port).toBe(8787)
    expect(cfg.dbPath).toBe('./data/be2-mcp.sqlite')
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
    } as NodeJS.ProcessEnv)
    expect(cfg.authsvcUrl).toBe('https://auth.stage.kkday.com')
    expect(cfg.gatewayUrl).toBe('https://api-gateway.stage.kkday.com')
    expect(cfg.serviceKey).toBe('x')
  })

  it('APP_ENV suffixes the default dbPath (label only)', () => {
    expect(loadConfig({ ...base, APP_ENV: 'stage' } as NodeJS.ProcessEnv).dbPath)
      .toBe('./data/be2-mcp-stage.sqlite')
  })

  it('explicit APP_DB_PATH overrides the APP_ENV default dbPath', () => {
    const cfg = loadConfig({ ...base, APP_ENV: 'stage', APP_DB_PATH: './custom/path.sqlite' } as NodeJS.ProcessEnv)
    expect(cfg.dbPath).toBe('./custom/path.sqlite')
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
