import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/store/db.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'

describe('WebSessionStore', () => {
  // Phase 2b 之前的 on-disk db：web_sessions 是 user_label 版 schema（無 identity_id）。
  // CREATE TABLE IF NOT EXISTS 不會補欄位 → /oauth/authorize/complete 500（live 2026-08-14）。
  // web session 是短命 idle-TTL 資料，正確 migration = 偵測舊 schema 直接重建（等同全員登出）。
  it('openDb 對 legacy web_sessions（無 identity_id 欄）重建表，create 不再炸', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'be2mcp-db-')), 'legacy.sqlite')
    const legacy = new Database(path)
    legacy.exec(`CREATE TABLE web_sessions (
      session_id   TEXT PRIMARY KEY,
      user_label   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );`)
    legacy.prepare('INSERT INTO web_sessions VALUES (?,?,?,?)').run('old-sid', 'someone@kkday.com', 1, 1)
    legacy.close()

    const s = new WebSessionStore(openDb(path), { now: () => 1000 })
    s.create('sid1', 'ident-user')
    expect(s.get('sid1')).toMatchObject({ sessionId: 'sid1', identityId: 'ident-user' })
    expect(s.get('old-sid')).toBeUndefined() // 舊 session 隨重建消失（重新登入即可）
  })
  it('creates and reads a session', () => {
    const s = new WebSessionStore(openDb(':memory:'), { now: () => 1000 })
    s.create('sid1', 'ident-user')
    expect(s.get('sid1')).toMatchObject({ sessionId: 'sid1', identityId: 'ident-user', createdAt: 1000, lastSeenAt: 1000 })
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
    expect(s.get('sid1')).toMatchObject({ identityId: 'u', lastSeenAt: 1050 })
  })
  it('delete removes the session', () => {
    const s = new WebSessionStore(openDb(':memory:'), { now: () => 1000 })
    s.create('sid1', 'u'); s.delete('sid1')
    expect(s.get('sid1')).toBeUndefined()
  })

  it('onDelete fires with the sessionId on explicit delete()', () => {
    const onDelete = vi.fn()
    const s = new WebSessionStore(openDb(':memory:'), { now: () => 1000, onDelete })
    s.create('sid1', 'u')
    s.delete('sid1')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('sid1')
  })

  it('onDelete fires when get() lazily reaps an idle-expired session', () => {
    let t = 1000
    const onDelete = vi.fn()
    const s = new WebSessionStore(openDb(':memory:'), { now: () => t, idleTtlMs: 100, onDelete })
    s.create('sid1', 'u')
    t = 1000 + 200
    expect(s.get('sid1')).toBeUndefined()
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('sid1')
  })

  it('onDelete is optional — no callback provided does not throw', () => {
    const s = new WebSessionStore(openDb(':memory:'), { now: () => 1000 })
    s.create('sid1', 'u')
    expect(() => s.delete('sid1')).not.toThrow()
  })
})
