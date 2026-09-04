import { describe, it, expect } from 'vitest'
import { buildTestApp } from './support/testApp.js'

describe('/mcp 401 gate audit (G3)', () => {
  it('unknown bearer => 401 AND one authn.unauthorized_attempt row with hash prefix (no token plaintext)', async () => {
    const { base, audit, close } = await buildTestApp()
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'authorization': 'Bearer totally-bogus', 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
      expect(res.status).toBe(401)
      await new Promise(r => setTimeout(r, 20))   // fire-and-forget 落地
      const row = (await audit.recent()).find(r => r.eventType === 'authn.unauthorized_attempt')
      expect(row).toBeDefined()
      expect(row!.severity).toBe('WARN')
      expect(row!.userLabel).toBe('unknown')
      expect(JSON.stringify(row!.params)).not.toContain('totally-bogus')   // 只有 hash 前 8 碼
    } finally {
      await close()
    }
  })

  it('same IP hammering => only the first attempt lands in the window', async () => {
    const { base, audit, close } = await buildTestApp()
    try {
      for (let i = 0; i < 5; i++) {
        await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'authorization': 'Bearer bogus', 'content-type': 'application/json' },
          body: JSON.stringify({})
        })
      }
      await new Promise(r => setTimeout(r, 20))
      const rows = (await audit.recent()).filter(r => r.eventType === 'authn.unauthorized_attempt')
      expect(rows).toHaveLength(1)
    } finally {
      await close()
    }
  })
})
