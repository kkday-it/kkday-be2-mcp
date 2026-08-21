export function parseOidInput(text: string): string[] {
  const seen = new Set<string>(); const out: string[] = []
  for (const tok of (text ?? '').split(/[\s,]+/)) { const t = tok.trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t) } }
  return out
}

export function splitBatches<T extends { action_type: string }>(items: T[], cap = 20): Array<{ action_type: string; items: T[] }> {
  const order: string[] = []; const byType = new Map<string, T[]>()
  for (const it of items) { if (!byType.has(it.action_type)) { byType.set(it.action_type, []); order.push(it.action_type) } byType.get(it.action_type)!.push(it) }
  const out: Array<{ action_type: string; items: T[] }> = []
  for (const at of order) { const arr = byType.get(at)!; for (let i = 0; i < arr.length; i += cap) out.push({ action_type: at, items: arr.slice(i, i + cap) }) }
  return out
}

export function ingestAnnouncement(rawReply: string): { langs: Array<{ langCode: string; content: string }> } | null {
  try {
    const m = (rawReply ?? '').match(/```json([\s\S]*?)```/)
    const o = JSON.parse((m ? m[1] : rawReply).trim())
    if (o?.type !== 'be2-announcement-content' || !Array.isArray(o.langs)) return null
    return { langs: o.langs.map((l: { lang_code: string; content: string }) => ({ langCode: l.lang_code, content: l.content })) }
  } catch { return null }
}
