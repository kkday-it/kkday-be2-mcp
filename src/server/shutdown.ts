import type { Server } from 'node:http'

export interface ShutdownDeps {
  server: Pick<Server, 'close'>
  db: { close: () => void }
  stopScheduler?: () => Promise<void>
  shutdownOtel: () => Promise<void>
  graceMs: number
  exit?: (code: number) => void
}

// 單一關機協調者：SIGTERM/SIGINT → 停排程(等 in-flight tick) → 排空 HTTP → flush trace → 關 db → exit。
// db.close 一定在 stopScheduler settle 之後，避免 in-flight tick 對已關閉 db 寫入（"database is closed"）。
// 全序 await 到底：`await shutdown()` 真的等到 drain+flush+close 完成才 exit（非丟一個 async callback）。
export function makeShutdown(deps: ShutdownDeps): () => Promise<void> {
  const exit = deps.exit ?? ((c: number) => process.exit(c))
  let shuttingDown = false
  return async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    // 硬逾時保險：只在收到訊號後 arm（絕不放模組頂層——頂層會開機即計時，且 HTTP server 讓
    // event loop 活著、.unref() 無效 → 開機 graceMs 後保證 hard-exit）。
    const timer = setTimeout(() => exit(0), deps.graceMs); timer.unref()
    await deps.stopScheduler?.()
    // server.close 的 callback 必須同步（Node 會丟棄回傳的 promise）——用 Promise 包起來自己 await drain。
    await new Promise<void>(resolve => deps.server.close(() => resolve()))
    await deps.shutdownOtel()
    deps.db.close()
    clearTimeout(timer)
    exit(0)
  }
}
