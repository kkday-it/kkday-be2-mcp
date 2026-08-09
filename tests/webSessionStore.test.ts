import { describe, it, expect } from 'vitest'
import { openDb } from '../src/store/db.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'

describe('WebSessionStore', () => {
  it('creates and reads a session', () => {
    const s = new WebSessionStore(openDb(':memory:'), { now: () => 1000 })
    s.create('sid1', 'user@kkday.com')
    expect(s.get('sid1')).toMatchObject({ sessionId: 'sid1', userLabel: 'user@kkday.com', createdAt: 1000, lastSeenAt: 1000 })
    expect(s.get('nope')).toBeUndefined()
  })
  it('newSessionId is 64 hex chars and unique', () => {
    const a = WebSessionStore.newSessionId()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(WebSessionStore.newSessionId()).not.toBe(a)
  })
  it('expires a session idle past ttl and deletes it', () => {
    let t = 1000
    const s = new WebSessionStore(openDb(':memory:'), { now: () => t, idleTtlMs: 100 })
    s.create('sid1', 'u')
    t = 1000 + 200
    expect(s.get('sid1')).toBeUndefined()
    // second get also undefined (row was deleted, not just filtered)
    t = 1000 + 300
    expect(s.get('sid1')).toBeUndefined()
  })
  it('touch extends idle expiry', () => {
    let t = 1000
    const s = new WebSessionStore(openDb(':memory:'), { now: () => t, idleTtlMs: 100 })
    s.create('sid1', 'u')
    t = 1050; s.touch('sid1')
    t = 1120                                   // 120 since create, but only 70 since touch
    expect(s.get('sid1')).toMatchObject({ userLabel: 'u', lastSeenAt: 1050 })
  })
  it('delete removes the session', () => {
    const s = new WebSessionStore(openDb(':memory:'), { now: () => 1000 })
    s.create('sid1', 'u'); s.delete('sid1')
    expect(s.get('sid1')).toBeUndefined()
  })
})
