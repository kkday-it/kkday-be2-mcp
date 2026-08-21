// tests/core/scheduleTz.test.ts
import { describe, it, expect } from 'vitest'
import { wallToUtcEpoch } from '../../src/core/schedule/tz.js'

describe('wallToUtcEpoch', () => {
  it('converts Asia/Taipei wall clock to UTC epoch (fixed +08:00, no DST)', () => {
    // 2026-09-01 09:00 Asia/Taipei == 2026-09-01T01:00:00Z
    expect(wallToUtcEpoch('2026-09-01T09:00', 'Asia/Taipei')).toBe(Date.UTC(2026, 8, 1, 1, 0))
  })
  it('handles day-boundary wall times (00:00 / 23:59)', () => {
    expect(wallToUtcEpoch('2026-09-01T00:00', 'Asia/Taipei')).toBe(Date.UTC(2026, 7, 31, 16, 0))
    expect(wallToUtcEpoch('2026-09-30T23:59', 'Asia/Taipei')).toBe(Date.UTC(2026, 8, 30, 15, 59))
  })
  it('is DST-safe: America/New_York across the spring-forward boundary', () => {
    // 2026-03-08 01:30 EST (UTC-5) exists → 06:30Z
    expect(wallToUtcEpoch('2026-03-08T01:30', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 6, 30))
    // 03:30 EDT (UTC-4) exists → 07:30Z
    expect(wallToUtcEpoch('2026-03-08T03:30', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7, 30))
  })
  it('rejects nonexistent DST wall time (02:30 during spring-forward)', () => {
    expect(() => wallToUtcEpoch('2026-03-08T02:30', 'America/New_York')).toThrow(/NONEXISTENT|does not exist/)
  })
  it('rejects malformed / impossible calendar input', () => {
    expect(() => wallToUtcEpoch('2026-9-1 09:00', 'Asia/Taipei')).toThrow()
    expect(() => wallToUtcEpoch('2026-02-30T10:00', 'Asia/Taipei')).toThrow()
    expect(() => wallToUtcEpoch('2026-09-01T24:00', 'Asia/Taipei')).toThrow()
  })
})
