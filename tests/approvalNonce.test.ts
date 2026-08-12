import { describe, it, expect } from 'vitest'
import { ApprovalNonceStore } from '../src/changeset/approvalNonce.js'

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
})
