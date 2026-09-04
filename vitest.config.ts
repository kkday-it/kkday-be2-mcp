import { defineConfig } from 'vitest/config'

// testTimeout/hookTimeout 20s（非預設 5s/10s）：多個測試檔平行起 PGlite（WASM）在高併發下
// 冷啟動偶爾超時，屬 WASM 初始化開銷、非邏輯變慢。openTestDb 多在 beforeAll/beforeEach
// 裡呼叫，hookTimeout 不放寬時同一 flake 只是換個報錯位置。優先保留平行度（不砍
// maxWorkers），只放寬時限——見 Task 8 report。
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, hookTimeout: 20000 },
})
