import { defineConfig } from 'vitest/config'

// 真 PG 併發測試獨立 config（Task 11）：只收 tests-pg/**，與 tests/**（PGlite）分開跑。
// fileParallelism:false——單一共用 DB schema 供整檔案的多個 case 用，case 間用各自獨立的
// row id 避免互踩，但仍固定單一 worker 執行，避免多檔並行時對同一個 docker PG 實例搶連線數
// （pgDb pool max=5，且此 suite 目前只有一個測試檔，關掉平行度沒有速度代價）。
export default defineConfig({
  test: { include: ['tests-pg/**/*.test.ts'], testTimeout: 20000, fileParallelism: false },
})
