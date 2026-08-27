import type { Server } from 'node:http'

export interface ShutdownDeps {
  server: Pick<Server, 'close'> & {
    closeIdleConnections?: () => void
    closeAllConnections?: () => void
  }
  db: { close: () => void }
  stopScheduler?: () => Promise<void>
  shutdownOtel: () => Promise<void>
  graceMs: number
  exit?: (code: number) => void
  // 強制關閉逗留連線前的等待上限（ms）。MCP `/mcp` 是 Streamable HTTP/SSE、client 持長連線，
  // 光等 server.close 的 callback 自然觸發會卡到 graceMs 硬逾時（見下）。預設 5s，測試可覆寫成極小值。
  forceCloseMs?: number
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
    // 這條路徑代表正常關機序列卡住／逾時，exit(1) 以便監控區分於正常路徑的 exit(0)。
    const timer = setTimeout(() => exit(1), deps.graceMs); timer.unref()
    // 全序包 try/finally：任一步 reject（如 OTLP exporter 關機 flush 逾時）都不能讓
    // shutdown() 本身 reject——它由 process.on('SIGTERM', shutdown) 直接呼叫、無 .catch()，
    // 若外洩會變 unhandled rejection 讓 Node crash，可能搶在硬逾時 fallback之前發生，
    // 導致 db.close 沒跑、非受控退出。錯誤在此吞下記 log，db.close + exit 一定在 finally 跑。
    try {
      await deps.stopScheduler?.()
      // MCP `/mcp` 是 Streamable HTTP/SSE/keep-alive，client 持長連線 socket——只 await
      // server.close 的 callback 會卡到那些連線自然關閉，實務上常直接拖到硬逾時（見上），
      // 導致 finally 的 db.close 沒機會跑。主動排空：先關 idle 連線，短暫等待後強制關剩下的。
      deps.server.closeIdleConnections?.()
      const forceMs = deps.forceCloseMs ?? 5_000
      const forceTimer = setTimeout(() => deps.server.closeAllConnections?.(), forceMs); forceTimer.unref()
      // server.close 的 callback 必須同步（Node 會丟棄回傳的 promise）——用 Promise 包起來自己 await drain。
      await new Promise<void>(resolve => deps.server.close(err => {
        if (err) console.error('[be2-mcp] server.close error during shutdown:', err.message)
        resolve()
      }))
      clearTimeout(forceTimer)
      await deps.shutdownOtel()
    } catch (e) {
      console.error('[be2-mcp] shutdown sequence error:', (e as Error).message)
    } finally {
      try { deps.db.close() } catch (e) { console.error('[be2-mcp] db.close error during shutdown:', (e as Error).message) }
      clearTimeout(timer)
      exit(0)
    }
  }
}
