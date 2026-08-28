import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  AUTHSVC_URL: 'https://auth-220.sit.kkday.com',
  GATEWAY_URL: 'https://api-gateway-220.sit.kkday.com',
  SIT_AUTHSVC_SERVICE_KEY: 'k',
}

describe('loadConfig', () => {
  it('loads required vars and applies defaults (legacy behavior)', () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv)
    expect(cfg.authsvcUrl).toBe(base.AUTHSVC_URL)
    expect(cfg.gatewayUrl).toBe(base.GATEWAY_URL)
    expect(cfg.serviceKey).toBe('k')
    expect(cfg.port).toBe(8787)
    expect(cfg.dbPath).toBe('./data/be2-mcp.sqlite')
    expect(cfg.otelMode).toBe('off')
  })

  it('throws a message naming the missing var, without echoing values (legacy behavior)', () => {
    expect(() => loadConfig({ ...base, SIT_AUTHSVC_SERVICE_KEY: '' } as NodeJS.ProcessEnv))
      .toThrowError(/SIT_AUTHSVC_SERVICE_KEY/)
    
    // Testing missing AUTHSVC_URL explicitly
    const noUrl = { ...base }
    delete (noUrl as any).AUTHSVC_URL
    expect(() => loadConfig(noUrl as NodeJS.ProcessEnv))
      .toThrowError(/AUTHSVC_URL/)
  })

  it('uses stage preset with BE2_ENV=stage', () => {
    const env = {
      BE2_ENV: 'stage',
      STAGE_AUTHSVC_SERVICE_KEY: 'x'
    } as NodeJS.ProcessEnv
    const cfg = loadConfig(env)
    expect(cfg.authsvcUrl).toBe('https://auth.stage.kkday.com')
    expect(cfg.gatewayUrl).toBe('https://api-gateway.stage.kkday.com')
    expect(cfg.serviceKey).toBe('x')
    expect(cfg.dbPath).toBe('./data/be2-mcp-stage.sqlite')
  })

  it('uses prod preset with BE2_ENV=prod', () => {
    const env = {
      BE2_ENV: 'prod',
      PRODUCTION_AUTHSVC_SERVICE_KEY: 'y'
    } as NodeJS.ProcessEnv
    const cfg = loadConfig(env)
    expect(cfg.authsvcUrl).toBe('https://auth.kkday.com')
    expect(cfg.gatewayUrl).toBe('https://api-gateway.kkday.com')
    expect(cfg.serviceKey).toBe('y')
    expect(cfg.dbPath).toBe('./data/be2-mcp-prod.sqlite')
  })

  it('throws if BE2_ENV=stage but missing STAGE_AUTHSVC_SERVICE_KEY', () => {
    const env = {
      BE2_ENV: 'stage'
    } as NodeJS.ProcessEnv
    expect(() => loadConfig(env))
      .toThrowError(/STAGE_AUTHSVC_SERVICE_KEY/)
  })

  it('explicit BE2_MCP_DB_PATH overrides BE2_ENV default dbPath', () => {
    const env = {
      BE2_ENV: 'stage',
      STAGE_AUTHSVC_SERVICE_KEY: 'x',
      BE2_MCP_DB_PATH: './custom/path.sqlite'
    } as NodeJS.ProcessEnv
    const cfg = loadConfig(env)
    expect(cfg.dbPath).toBe('./custom/path.sqlite')
  })

  it('defaults bindHost to 127.0.0.1 and allows override', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).bindHost).toBe('127.0.0.1')
    expect(loadConfig({ ...base, BE2_MCP_BIND_HOST: '0.0.0.0' } as NodeJS.ProcessEnv).bindHost).toBe('0.0.0.0')
  })

  it('publicBaseUrl falls back to loopback when unset, honours override and strips trailing slash', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).publicBaseUrl).toBe('http://127.0.0.1:8787')
    expect(loadConfig({ ...base, BE2_MCP_PORT: '9000' } as NodeJS.ProcessEnv).publicBaseUrl).toBe('http://127.0.0.1:9000')
    expect(loadConfig({ ...base, BE2_MCP_PUBLIC_BASE_URL: 'https://mcp.stage.kkday.com/' } as NodeJS.ProcessEnv).publicBaseUrl)
      .toBe('https://mcp.stage.kkday.com')
  })

  it('rejects a non-URL publicBaseUrl without echoing its value', () => {
    expect(() => loadConfig({ ...base, BE2_MCP_PUBLIC_BASE_URL: 'not-a-url' } as NodeJS.ProcessEnv))
      .toThrowError(/BE2_MCP_PUBLIC_BASE_URL/)
  })
})
