import { describe, it, expect } from 'vitest'
import { initOtel, shutdownOtel } from '../src/otel.js'

describe('otel shutdown', () => {
  it('shutdownOtel resolves without error in off mode (no SDK started)', async () => {
    initOtel('off')
    await expect(shutdownOtel()).resolves.toBeUndefined()
  })
  it('shutdownOtel resolves after starting the SDK in console mode', async () => {
    initOtel('console')
    await expect(shutdownOtel()).resolves.toBeUndefined()
  })
})
