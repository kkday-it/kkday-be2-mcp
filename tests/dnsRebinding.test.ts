import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server, request as httpRequest } from 'node:http'
import { openDb } from '../src/store/db.js'
import { buildApp } from '../src/server/app.js'
import type { Config } from '../src/config.js'

function sendRawRequest(
  port: number,
  path: string,
  options: {
    method?: string
    hostHeader?: string
    headers?: Record<string, string>
    body?: string
  } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
    }
    if (options.hostHeader !== undefined) {
      headers['Host'] = options.hostHeader
    }
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers,
      },
      res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          })
        })
      },
    )
    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

describe('DNS-Rebinding and Host Header Guard', () => {
  let http: Server
  let port: number

  beforeAll(async () => {
    const db = openDb(':memory:')
    const config: Config = {
      authsvcUrl: 'https://auth.invalid',
      gatewayUrl: 'https://gw.invalid',
      serviceKey: 'sk',
      port: 0,
      dbPath: ':memory:',
      otelMode: 'off', scheduleTz: 'Asia/Taipei',
      bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
    }
    const app = buildApp({ config, db })
    http = createServer(app)
    await new Promise<void>(r => http.listen(0, () => r()))
    port = (http.address() as { port: number }).port
  })

  afterAll(() => new Promise<void>(r => http.close(() => r())))

  it('/healthz is accessible regardless of Host header', async () => {
    // Standard request
    const r1 = await sendRawRequest(port, '/healthz')
    expect(r1.status).toBe(200)
    expect(r1.body).toBe('ok')

    // With malicious Host header
    const r2 = await sendRawRequest(port, '/healthz', {
      hostHeader: 'attacker.com',
    })
    expect(r2.status).toBe(200)
    expect(r2.body).toBe('ok')
  })

  it('allows valid local loopback Host headers on protected routes', async () => {
    const validHosts = [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      '127.0.0.1',
      'localhost',
      `[::1]:${port}`,
    ]

    for (const hostHeader of validHosts) {
      const res = await sendRawRequest(port, '/confirm/login', { hostHeader })
      // /confirm/login should return 200 (or redirect), but definitely NOT 403 Host rejection
      expect(res.status, `Host '${hostHeader}' should not be blocked with 403`).not.toBe(403)
    }
  })

  it('rejects malicious Host headers on /confirm routes with 403', async () => {
    const maliciousHosts = [
      'attacker.com',
      `attacker.com:${port}`,
      'evil.org',
      '192.168.1.100',
      'rebinding.attacker.io:8787',
      'subdomain.localhost.attacker.com',
    ]

    for (const hostHeader of maliciousHosts) {
      const res = await sendRawRequest(port, '/confirm/login', { hostHeader })
      expect(res.status, `Malicious Host '${hostHeader}' should be rejected with 403`).toBe(403)
      const body = JSON.parse(res.body) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('FORBIDDEN')
    }
  })

  it('rejects malicious Host headers on /mcp route with 403', async () => {
    const res = await sendRawRequest(port, '/mcp', {
      method: 'POST',
      hostHeader: 'attacker.com',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'initialize' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects malicious Host headers on OAuth endpoints with 403', async () => {
    const res = await sendRawRequest(port, '/.well-known/oauth-authorization-server', {
      hostHeader: 'attacker.com',
    })
    expect(res.status).toBe(403)
  })

  it('supports custom allowed hosts via BE2_MCP_ALLOWED_HOSTS env', async () => {
    const db = openDb(':memory:')
    const config: Config = {
      authsvcUrl: 'https://auth.invalid',
      gatewayUrl: 'https://gw.invalid',
      serviceKey: 'sk',
      port: 0,
      dbPath: ':memory:',
      otelMode: 'off', scheduleTz: 'Asia/Taipei',
      bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:0',
    }

    const prevEnv = process.env.BE2_MCP_ALLOWED_HOSTS
    try {
      process.env.BE2_MCP_ALLOWED_HOSTS = 'custom.corp.internal, another-host:9999'
      const app = buildApp({ config, db })
      const server = createServer(app)
      await new Promise<void>(r => server.listen(0, () => r()))
      const testPort = (server.address() as { port: number }).port

      try {
        const allowedRes = await sendRawRequest(testPort, '/confirm/login', {
          hostHeader: 'custom.corp.internal',
        })
        expect(allowedRes.status).not.toBe(403)

        const deniedRes = await sendRawRequest(testPort, '/confirm/login', {
          hostHeader: 'not-in-allowlist.com',
        })
        expect(deniedRes.status).toBe(403)
      } finally {
        await new Promise<void>(r => server.close(() => r()))
      }
    } finally {
      if (prevEnv === undefined) {
        delete process.env.BE2_MCP_ALLOWED_HOSTS
      } else {
        process.env.BE2_MCP_ALLOWED_HOSTS = prevEnv
      }
    }
  })
})
