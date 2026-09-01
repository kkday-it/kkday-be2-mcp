import { readFileSync, writeFileSync } from 'node:fs'

export type Interaction = { method: string; url: string; reqBody: unknown; status: number; resBody: unknown }
export type Cassette = { interactions: Interaction[] }

export const VOLATILE_KEYS = ['modify_user', 'modifyUser', 'timestamp', 'request-uuid', 'requestUuid']

export function normalizeUrl(url: string): string {
  const u = new URL(url)
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
  u.search = new URLSearchParams(params).toString()
  return u.toString()
}

export function normalizeBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(normalizeBody)
  if (body && typeof body === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(body as Record<string, unknown>).sort()) {
      if (VOLATILE_KEYS.includes(k)) continue
      out[k] = normalizeBody((body as Record<string, unknown>)[k])
    }
    return out
  }
  return body
}

export function matchKey(method: string, url: string, body: unknown): string {
  return `${method.toUpperCase()} ${normalizeUrl(url)} ${JSON.stringify(normalizeBody(body))}`
}

export type CassetteFetch = typeof fetch & {
  stubError: (method: string, urlPattern: string, status: number, envelopeBody: unknown) => void
  save: () => void
}

function bodyToJson(init?: RequestInit): unknown {
  const b = init?.body
  if (typeof b === 'string' && b.length) { try { return JSON.parse(b) } catch { return b } }
  return undefined
}

export function makeCassetteFetch(mode: 'record' | 'replay', cassettePath: string): CassetteFetch {
  const cassette: Cassette = mode === 'replay'
    ? JSON.parse(readFileSync(cassettePath, 'utf8'))
    : { interactions: [] }
  // queue-per-key：同 matchKey 的多筆按錄製順序排隊，避免 Map.set 覆蓋（stateful GET 前/後）
  const index = new Map<string, Interaction[]>()
  if (mode === 'replay') for (const it of cassette.interactions) {
    const k = matchKey(it.method, it.url, it.reqBody)
    const q = index.get(k) ?? (index.set(k, []), index.get(k)!)
    q.push(it)
  }

  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (mode === 'replay') {
      const q = index.get(matchKey(method, url, bodyToJson(init)))
      if (!q || q.length === 0) throw new Error(`no cassette match for ${method} ${url}`)
      // 多筆 → 依序 shift（不同回應的序列）；單筆 → sticky 可重複回放（idempotent 輪詢）
      const hit = q.length > 1 ? q.shift()! : q[0]
      return new Response(JSON.stringify(hit.resBody), { status: hit.status, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('record mode not yet implemented') // Task 3
  }) as CassetteFetch

  f.stubError = () => { throw new Error('stubError not yet implemented') } // Task 4
  f.save = () => { throw new Error('save not yet implemented') } // Task 3
  return f
}
