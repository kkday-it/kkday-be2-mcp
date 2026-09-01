import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveAnnounceApiKey } from '../../src/modules/announcement/create/svcB2cClient.js'
import { announceKeyVarFor } from '../../src/config.js'

afterEach(() => vi.unstubAllEnvs())

describe('announceKeyVarFor (mapping centralized in config presets)', () => {
  it('maps each BE2_ENV to its announce key var name', () => {
    expect(announceKeyVarFor('stage')).toBe('STAGE_ANNOUNCE_API_KEY')
    expect(announceKeyVarFor('prod')).toBe('PROD_ANNOUNCE_API_KEY')
    expect(announceKeyVarFor('sit')).toBe('SIT_ANNOUNCE_API_KEY')
    expect(announceKeyVarFor('sit-220')).toBe('SIT_ANNOUNCE_API_KEY')
  })
})

describe('resolveAnnounceApiKey (env-aware, consumes config mapping)', () => {
  it('picks the STAGE key when BE2_ENV=stage', () => {
    vi.stubEnv('BE2_ENV', 'stage'); vi.stubEnv('STAGE_ANNOUNCE_API_KEY', 'stage-key')
    expect(resolveAnnounceApiKey()).toBe('stage-key')
  })
  it('picks the SIT key when BE2_ENV=sit (or unset default)', () => {
    vi.stubEnv('BE2_ENV', 'sit'); vi.stubEnv('SIT_ANNOUNCE_API_KEY', 'sit-key')
    expect(resolveAnnounceApiKey()).toBe('sit-key')
  })
  it('throws GatewayError naming the missing env-specific var', () => {
    vi.stubEnv('BE2_ENV', 'stage')
    expect(() => resolveAnnounceApiKey()).toThrow(/STAGE_ANNOUNCE_API_KEY/)
  })
})
