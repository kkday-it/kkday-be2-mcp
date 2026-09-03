import { describe, it, expect, vi } from 'vitest'
import { openTestDb } from './support/testDb.js'
import { WebSessionStore } from '../src/server/webSessionStore.js'

// 註：Task 5 前這裡有一條「openDb 對 legacy web_sessions（無 identity_id 欄）重建表」測試——
// 那條測的是 src/store/db.ts（better-sqlite3 on-disk 開檔）在偵測到舊 schema 時的
// runtime 重建行為，屬 SQLite-only 概念（PG 沒有「開檔時發現欄位對不上就重建」這回事，
// schema 一律由 forward-only migrations 定義，見 db/migrations/）。db.ts 本身排定於
// Task 7 隨 app.ts 改線刪除，故此測試在 Db 抽象下沒有對應語意，隨本次轉換移除，
// 不搬進 openTestDb 版本。

describe('WebSessionStore', () => {
  it('creates and reads a session', async () => {
    const db = await openTestDb()
    const s = new WebSessionStore(db, { now: () => 1000 })
    await s.create('sid1', 'ident-user')
    expect(await s.get('sid1')).toMatchObject({ sessionId: 'sid1', identityId: 'ident-user', createdAt: 1000, lastSeenAt: 1000 })
    expect(await s.get('nope')).toBeUndefined()
    await db.close()
  })
  it('newSessionId is 64 hex chars and unique', () => {
    const a = WebSessionStore.newSessionId()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(WebSessionStore.newSessionId()).not.toBe(a)
  })
  it('expires a session idle past ttl and deletes it', async () => {
    let t = 1000
    const db = await openTestDb()
    const s = new WebSessionStore(db, { now: () => t, idleTtlMs: 100 })
    await s.create('sid1', 'u')
    t = 1000 + 200
    expect(await s.get('sid1')).toBeUndefined()
    // second get also undefined (row was deleted, not just filtered)
    t = 1000 + 300
    expect(await s.get('sid1')).toBeUndefined()
    await db.close()
  })
  it('touch extends idle expiry', async () => {
    let t = 1000
    const db = await openTestDb()
    const s = new WebSessionStore(db, { now: () => t, idleTtlMs: 100 })
    await s.create('sid1', 'u')
    t = 1050; await s.touch('sid1')
    t = 1120                                   // 120 since create, but only 70 since touch
    expect(await s.get('sid1')).toMatchObject({ identityId: 'u', lastSeenAt: 1050 })
    await db.close()
  })
  it('delete removes the session', async () => {
    const db = await openTestDb()
    const s = new WebSessionStore(db, { now: () => 1000 })
    await s.create('sid1', 'u'); await s.delete('sid1')
    expect(await s.get('sid1')).toBeUndefined()
    await db.close()
  })

  it('onDelete fires with the sessionId on explicit delete()', async () => {
    const db = await openTestDb()
    const onDelete = vi.fn()
    const s = new WebSessionStore(db, { now: () => 1000, onDelete })
    await s.create('sid1', 'u')
    await s.delete('sid1')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('sid1')
    await db.close()
  })

  it('onDelete fires when get() lazily reaps an idle-expired session', async () => {
    let t = 1000
    const db = await openTestDb()
    const onDelete = vi.fn()
    const s = new WebSessionStore(db, { now: () => t, idleTtlMs: 100, onDelete })
    await s.create('sid1', 'u')
    t = 1000 + 200
    expect(await s.get('sid1')).toBeUndefined()
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('sid1')
    await db.close()
  })

  it('onDelete is optional — no callback provided does not throw', async () => {
    const db = await openTestDb()
    const s = new WebSessionStore(db, { now: () => 1000 })
    await s.create('sid1', 'u')
    await s.delete('sid1')
    await db.close()
  })

  // brief 要求 onDelete 型別放寬為 `(sessionId: string) => void | Promise<void>`，delete() 內 await
  // 它——回歸測試釘住「delete() 真的等 async onDelete 完成才 resolve」，不是 fire-and-forget。
  it('onDelete may be async — delete() awaits it before returning', async () => {
    const db = await openTestDb()
    let settled = false
    const s = new WebSessionStore(db, {
      now: () => 1000,
      onDelete: async () => { await new Promise(resolve => setTimeout(resolve, 5)); settled = true },
    })
    await s.create('sid1', 'u')
    await s.delete('sid1')
    expect(settled).toBe(true)
    await db.close()
  })
})
