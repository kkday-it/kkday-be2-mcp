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
