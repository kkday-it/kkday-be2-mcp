import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Shared helpers for the manual probe scripts (probe-sit*, probe-sit-bluemountain).
// These NEVER print or write token values; saveFixture refuses to write anything
// that looks like a JWT. Kept in one place so the four probes don't drift.

// A serialized bearer/JWT: base64url header segment always starts with `eyJ`.
const JWT_RE = /eyJ[A-Za-z0-9_-]{20,}/

/**
 * Serialize `body` to `tests/fixtures/<relPath>`, refusing to write if it smells
 * of a JWT. `relPath` carries its own subdir + extension so each probe keeps its
 * own convention (committed `.json`, `write/…`, or gitignored `.local.json`).
 */
export function saveFixture(relPath: string, body: unknown): void {
  const full = `tests/fixtures/${relPath}`
  mkdirSync(dirname(full), { recursive: true })
  const json = JSON.stringify(body, null, 2)
  if (JWT_RE.test(json)) throw new Error(`fixture ${relPath} appears to contain a JWT — refusing to write`)
  writeFileSync(full, json)
  console.log(`fixture written: ${full}`)
}

/** Collapse a value to its structural shape (keys + leaf types), truncating arrays and depth. */
export function shape(v: unknown, depth = 0, maxDepth = 4): unknown {
  if (depth > maxDepth) return '...'
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1, maxDepth), `(+${v.length - 1} more)`] : []
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1, maxDepth)]))
  }
  return typeof v
}

/** Decode a JWT's claims (payload segment) without verifying the signature. */
export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
}

/**
 * Gateway request with the be2 Bearer + `x-auth-id: be2` headers, returning the
 * unwrapped `body.data ?? body`. Shared by the write/inventory probes, which used
 * byte-identical copies. `gatewayUrl` is passed in (probes close over their own cfg).
 */
export async function gw(
  gatewayUrl: string,
  at: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${gatewayUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${at}`,
      accept: 'application/json',
      'x-auth-id': 'be2',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  console.log(`${method} ${path} -> ${res.status}`)
  return { status: res.status, body: (j as { data?: unknown }).data ?? j }
}
