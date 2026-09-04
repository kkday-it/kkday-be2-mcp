import { describe, it, expect } from 'vitest'
import { UnauthThrottle } from '../src/server/unauthThrottle.js'

describe('UnauthThrottle (G3 雙層防灌爆)', () => {
  it('L1: same IP admits once per 60s window, then suppresses and reports count', () => {
    let now = 0
    const t = new UnauthThrottle({ now: () => now })
    expect(t.admit('1.1.1.1').admit).toBe(true)
    expect(t.admit('1.1.1.1').admit).toBe(false)
    expect(t.admit('1.1.1.1').admit).toBe(false)
    now = 61_000
    const v = t.admit('1.1.1.1')
    expect(v.admit).toBe(true)
    expect(v.note).toContain('suppressed=2')   // 前一窗被抑制 2 次
  })

  it('L1: map full => new IPs stop getting entries but still pass through to L2', () => {
    let now = 0
    const t = new UnauthThrottle({ maxIps: 2, globalPerMinute: 100, now: () => now })
    t.admit('a'); t.admit('b')                  // 填滿 map
    expect(t.admit('c').admit).toBe(true)       // 新 IP 直走 L2（未超天花板 → 放行）
    expect(t.admit('c').admit).toBe(true)       // 不建立 entry，也不被 L1 抑制
    expect(t.admit('a').admit).toBe(false)      // 既有 entry 照常 L1 抑制
  })

  it('L2: global ceiling bounds writes per minute regardless of IPs', () => {
    let now = 0
    const t = new UnauthThrottle({ globalPerMinute: 3, now: () => now })
    // 全部用不同 IP（模擬偽造 XFF 掃描器）
    expect(t.admit('10.0.0.1').admit).toBe(true)
    expect(t.admit('10.0.0.2').admit).toBe(true)
    expect(t.admit('10.0.0.3').admit).toBe(true)
    expect(t.admit('10.0.0.4').admit).toBe(false)   // 天花板
    expect(t.admit('10.0.0.5').admit).toBe(false)
    now = 61_000
    const v = t.admit('10.0.0.6')
    expect(v.admit).toBe(true)
    expect(v.note).toContain('global_suppressed=2')
  })
})
