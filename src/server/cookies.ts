export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}
export function serializeSetCookie(name: string, value: string,
  opts: { httpOnly?: boolean; sameSite?: 'Lax' | 'Strict'; path?: string; maxAgeSec?: number } = {}): string {
  let c = `${name}=${encodeURIComponent(value)}`
  if (opts.path) c += `; Path=${opts.path}`
  if (opts.sameSite) c += `; SameSite=${opts.sameSite}`
  if (opts.httpOnly) c += '; HttpOnly'
  if (opts.maxAgeSec !== undefined) c += `; Max-Age=${opts.maxAgeSec}`
  return c
}
