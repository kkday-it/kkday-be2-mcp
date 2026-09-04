import { describe, it, expect } from 'vitest'
import { GatewayClient } from '../src/gateway/client.js'
import { ensureTraceId, randomTraceId } from '../src/otel.js'

function captureFetch(): { headers: Record<string, string>[]; fetchImpl: typeof fetch } {
  const headers: Record<string, string>[] = []
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    headers.push({ ...(init?.headers as Record<string, string>) })
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { headers, fetchImpl }
}

describe('request-uuid 貫穿 (#3)', () => {
  it('ensureTraceId replaces the all-zero no-op traceId', () => {
    expect(ensureTraceId('0'.repeat(32))).toMatch(/^[0-9a-f]{32}$/)
    expect(ensureTraceId('0'.repeat(32))).not.toBe('0'.repeat(32))
    expect(ensureTraceId('abc123' + '0'.repeat(26))).toBe('abc123' + '0'.repeat(26))  // 有效值原樣
    expect(randomTraceId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('withTrace-bound client sends request-uuid on get/put/post; unbound sends none', async () => {
    const { headers, fetchImpl } = captureFetch()
    const gw = new GatewayClient({ baseUrl: 'http://gw.test', fetchImpl })
    await gw.get('/x', 'tok')
    expect(headers[0]['request-uuid']).toBeUndefined()          // 未綁定：不帶（probe 相容）
    const bound = gw.withTrace('t'.repeat(32))
    await bound.get('/x', 'tok')
    await bound.put('/x', 'tok', {})
    await bound.post('/x', 'tok', {})
    for (const h of headers.slice(1)) expect(h['request-uuid']).toBe('t'.repeat(32))
    expect(headers[1].authorization).toBe('Bearer tok')          // 既有 header 不受影響
  })
})
