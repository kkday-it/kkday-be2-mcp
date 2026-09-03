import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveAnnounceApiKey } from '../../src/modules/announcement/create/svcB2cClient.js'

afterEach(() => vi.unstubAllEnvs())

describe('resolveAnnounceApiKey (single per-environment key, config-manager style)', () => {
  it('returns API_ANNOUNCE_KEY when set', () => {
    vi.stubEnv('API_ANNOUNCE_KEY', 'the-key')
    expect(resolveAnnounceApiKey()).toBe('the-key')
  })
  it('throws GatewayError naming the missing var, without echoing values', () => {
    vi.stubEnv('API_ANNOUNCE_KEY', '')
    expect(() => resolveAnnounceApiKey()).toThrow(/API_ANNOUNCE_KEY/)
  })
})
