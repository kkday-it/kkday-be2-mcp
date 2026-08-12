import { describe, it, expect } from 'vitest'
import { AppRateBudget } from '../src/limits/appRateBudget.js'
import { RateError } from '../src/errors.js'

describe('AppRateBudget', () => {
  it('同一 session 超過 perMinute 丟 RateError', () => {
    let t = 0
    const b = new AppRateBudget({ perMinute: 3, now: () => t })
    b.consume('s1'); b.consume('s1'); b.consume('s1')
    expect(() => b.consume('s1')).toThrow(RateError)
  })
  it('滑動窗：60s 後舊呼叫過期，可再消耗', () => {
    let t = 0
    const b = new AppRateBudget({ perMinute: 2, now: () => t })
    b.consume('s1'); b.consume('s1')
    t = 61_000
    expect(() => b.consume('s1')).not.toThrow()
  })
  it('不同 session 各自計數', () => {
    let t = 0
    const b = new AppRateBudget({ perMinute: 1, now: () => t })
    b.consume('s1')
    expect(() => b.consume('s2')).not.toThrow()
  })
  it('release 清掉該 session 計數，之後可視為全新起算', () => {
    let t = 0
    const b = new AppRateBudget({ perMinute: 1, now: () => t })
    b.consume('s1')
    expect(() => b.consume('s1')).toThrow(RateError)
    b.release('s1')
    expect(() => b.consume('s1')).not.toThrow()
  })
})
