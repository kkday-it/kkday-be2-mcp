import { describe, it, expect } from 'vitest'
import { ApprovalNonceStore } from '../src/core/changeset/approvalNonce.js'

const bind = { changesetId: 'cs1', diffVersion: 'v1', sessionId: 's1' }

describe('ApprovalNonceStore', () => {
  it('發放的 nonce 用正確 bind 驗證通過（且單次）', () => {
    const s = new ApprovalNonceStore()
    const n = s.issue(bind)
    expect(s.verifyAndConsume(n, bind)).toBe(true)
    expect(s.verifyAndConsume(n, bind)).toBe(false)   // 已消耗
  })
  it('三元組任一不符即拒', () => {
    const s = new ApprovalNonceStore()
    const n = s.issue(bind)
    expect(s.verifyAndConsume(n, { ...bind, sessionId: 's2' })).toBe(false)
  })
  it('過期即拒', () => {
    let t = 0; const s = new ApprovalNonceStore({ ttlMs: 1000, now: () => t })
    const n = s.issue(bind); t = 2000
    expect(s.verifyAndConsume(n, bind)).toBe(false)
  })
  it('未知 nonce 直接拒', () => {
    const s = new ApprovalNonceStore()
    expect(s.verifyAndConsume('bogus', bind)).toBe(false)
  })
  it('issue() 惰性掃描會驅逐已過期項目（非只是 verify 判過期）', () => {
    let t = 0
    const s = new ApprovalNonceStore({ ttlMs: 1000, now: () => t })
    const expired = [s.issue(bind), s.issue(bind), s.issue(bind)]
    expect(s.size()).toBe(3)
    t = 2000                                          // 三顆都已過期，但尚未被任何動作觸碰
    s.issue(bind)                                      // 面板下一輪輪詢 issue 的新 nonce
    // 驅逐真的發生：map 大小回落到只剩剛發的這顆，而非持續累積成 4
    expect(s.size()).toBe(1)
    // 且過期項目本來就該驗證失敗（驅逐前後行為一致，未破壞既有語意）
    for (const n of expired) expect(s.verifyAndConsume(n, bind)).toBe(false)
  })
})
