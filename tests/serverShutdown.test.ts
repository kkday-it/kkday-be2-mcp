import { describe, it, expect, vi } from 'vitest'
import { makeShutdown } from '../src/server/shutdown.js'

describe('makeShutdown', () => {
  it('runs stopScheduler → server.close → shutdownOtel → db.close → exit, in order', async () => {
    const order: string[] = []
    const server = { close: (cb: () => void) => { order.push('server.close'); cb() } }
    const db = { close: () => { order.push('db.close') } }
    const stopScheduler = vi.fn(async () => { order.push('stopScheduler') })
    const shutdownOtel = vi.fn(async () => { order.push('shutdownOtel') })
    const exit = vi.fn((_: number) => { order.push('exit') })
    const shutdown = makeShutdown({ server: server as any, db: db as any, stopScheduler, shutdownOtel, graceMs: 25_000, exit })
    await shutdown()          // promisified：await 回來時全序已跑完
    expect(order).toEqual(['stopScheduler', 'server.close', 'shutdownOtel', 'db.close', 'exit'])
  })

  it('is idempotent (second call is a no-op)', async () => {
    const server = { close: (cb: () => void) => cb() }
    const db = { close: vi.fn() }
    const exit = vi.fn()
    const shutdown = makeShutdown({ server: server as any, db: db as any, shutdownOtel: async () => {}, graceMs: 25_000, exit })
    await shutdown()
    await shutdown()
    expect(db.close).toHaveBeenCalledTimes(1)
  })

  it('closes db AFTER stopScheduler settles (no write-after-close race)', async () => {
    const order: string[] = []
    let schedulerDone = false
    const stopScheduler = async () => { await new Promise(r => setTimeout(r, 20)); schedulerDone = true; order.push('stopScheduler') }
    const server = { close: (cb: () => void) => cb() }
    const db = { close: () => { expect(schedulerDone).toBe(true); order.push('db.close') } }
    const shutdown = makeShutdown({ server: server as any, db: db as any, stopScheduler, shutdownOtel: async () => {}, graceMs: 25_000, exit: () => {} })
    await shutdown()
    expect(order).toEqual(['stopScheduler', 'db.close'])
  })

  it('contains errors from the shutdown sequence: shutdown() never rejects, db.close + exit still run', async () => {
    const server = { close: (cb: () => void) => cb() }
    const db = { close: vi.fn() }
    const exit = vi.fn()
    const shutdownOtel = vi.fn(async () => { throw new Error('OTLP flush timeout') })
    const shutdown = makeShutdown({ server: server as any, db: db as any, shutdownOtel, graceMs: 25_000, exit })
    await expect(shutdown()).resolves.toBeUndefined()
    expect(db.close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
