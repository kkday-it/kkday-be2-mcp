import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  AUTHSVC_URL: 'https://auth-220.sit.kkday.com',
  GATEWAY_URL: 'https://api-gateway-220.sit.kkday.com',
  SIT_AUTHSVC_SERVICE_KEY: 'k',
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
  })
  it('throws a message naming the missing var, without echoing values', () => {
    expect(() => loadConfig({ ...base, SIT_AUTHSVC_SERVICE_KEY: '' } as NodeJS.ProcessEnv))
      .toThrowError(/SIT_AUTHSVC_SERVICE_KEY/)
  })
})
