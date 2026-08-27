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

  it('guards db.close itself: if db.close throws, shutdown() still resolves and exit still runs', async () => {
    const server = { close: (cb: () => void) => cb() }
    const db = { close: vi.fn(() => { throw new Error('db already closed') }) }
    const exit = vi.fn()
    const shutdown = makeShutdown({ server: server as any, db: db as any, shutdownOtel: async () => {}, graceMs: 25_000, exit })
    await expect(shutdown()).resolves.toBeUndefined()
    expect(db.close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('continues the sequence when server.close callback is invoked with an error', async () => {
    const order: string[] = []
    const server = { close: (cb: (err?: Error) => void) => { order.push('server.close'); cb(new Error('close failed')) } }
    const db = { close: () => { order.push('db.close') } }
    const shutdownOtel = vi.fn(async () => { order.push('shutdownOtel') })
    const exit = vi.fn((_: number) => { order.push('exit') })
    const shutdown = makeShutdown({ server: server as any, db: db as any, shutdownOtel, graceMs: 25_000, exit })
    await expect(shutdown()).resolves.toBeUndefined()
    expect(order).toEqual(['server.close', 'shutdownOtel', 'db.close', 'exit'])
  })

  it('proactively closes idle connections before waiting on server.close', async () => {
    const order: string[] = []
    const server = {
      closeIdleConnections: vi.fn(() => { order.push('closeIdleConnections') }),
      closeAllConnections: vi.fn(),
      close: (cb: () => void) => { order.push('server.close'); cb() },
    }
    const db = { close: vi.fn() }
    const exit = vi.fn()
    const shutdown = makeShutdown({ server: server as any, db: db as any, shutdownOtel: async () => {}, graceMs: 25_000, exit })
    await shutdown()
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['closeIdleConnections', 'server.close'])
  })

  it('force-closes lingering connections after forceCloseMs so shutdown does not stall to the hard timeout', async () => {
    // 模擬一個逗留的 long-lived 連線：server.close 的 callback 卡住，直到
    // closeAllConnections() 被呼叫才觸發（如真實 http.Server 對持有 keep-alive socket 的行為）。
    let closeCb: (() => void) | undefined
    const server = {
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(() => { closeCb?.() }),
      close: (cb: () => void) => { closeCb = cb },
    }
    const db = { close: vi.fn() }
    const exit = vi.fn()
    const shutdown = makeShutdown({
      server: server as any, db: db as any, shutdownOtel: async () => {},
      graceMs: 25_000, forceCloseMs: 5, exit,
    })
    await shutdown()   // 若沒有 force-close 機制，這裡會一路卡到 25s 的硬逾時 timer
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(db.close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits with code 1 when the hard timeout fires (stalled/forced shutdown, distinct from clean exit(0))', async () => {
    vi.useFakeTimers()
    try {
      const server = { close: () => { /* never calls back — simulate a fully stuck shutdown */ } }
      const db = { close: vi.fn() }
      const exit = vi.fn()
      const shutdown = makeShutdown({ server: server as any, db: db as any, shutdownOtel: async () => {}, graceMs: 1_000, exit })
      void shutdown()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
