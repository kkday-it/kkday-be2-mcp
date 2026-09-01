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

  const stubs: Array<{ method: string; urlPattern: string; status: number; body: unknown }> = []

  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (mode === 'replay') {
      const stub = stubs.find(s => s.method === method && url.includes(s.urlPattern))
      if (stub) return new Response(JSON.stringify(stub.body), { status: stub.status, headers: { 'content-type': 'application/json' } })
      const q = index.get(matchKey(method, url, bodyToJson(init)))
      if (!q || q.length === 0) throw new Error(`no cassette match for ${method} ${url}`)
      // 多筆 → 依序 shift（不同回應的序列）；單筆 → sticky 可重複回放（idempotent 輪詢）
      const hit = q.length > 1 ? q.shift()! : q[0]
      return new Response(JSON.stringify(hit.resBody), { status: hit.status, headers: { 'content-type': 'application/json' } })
    }
    // record 模式：透過可注入的 real fetch 打真實請求，擷取 interaction 後原樣回傳
    const realRes = await self._realFetch(input, init)
    const clone = realRes.clone()
    let resBody: unknown
    const text = await clone.text()
    try { resBody = JSON.parse(text) } catch { resBody = text }
    cassette.interactions.push({ method, url, reqBody: bodyToJson(init), status: realRes.status, resBody })
    return realRes
  }) as CassetteFetch

  // 可注入的 real fetch（測試用；正式預設 globalThis.fetch）
  const self = f as unknown as { _realFetch: typeof fetch }
  self._realFetch = fetch

  f.stubError = (method, urlPattern, status, envelopeBody) => {
    stubs.push({ method: method.toUpperCase(), urlPattern, status, body: envelopeBody })
  }
  f.save = () => {
    const json = JSON.stringify(cassette)
    if (/eyJ[A-Za-z0-9_-]{20,}/.test(json)) throw new Error('cassette appears to contain a JWT — refusing to write')
    // headers 不存入 Interaction（method/url/reqBody/status/resBody 而已）
    // → Authorization / x-api-key 天然不落盤；上面的 JWT 偵測是 body 內夾 token 的最後防線
    writeFileSync(cassettePath, JSON.stringify(cassette, null, 2))
  }
  return f
}
