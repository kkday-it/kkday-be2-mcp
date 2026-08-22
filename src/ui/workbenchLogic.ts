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

// 把單一 action_type 的 items 拆成多個 change-set 批次（每批 ≤cap），供工作台逐批 create→view→confirm。
// 借 splitBatches 分組（工作台一個次模式只有單一 action_type，故此處為單組再依 cap 切）；tag action_type
// 供 splitBatches 分組，回傳前剝除——server 端 itemSchema 是 strict zod，不接受多餘的 action_type 鍵。
export function buildActionChunks(
  items: Array<Record<string, unknown>>, actionType: string, cap = 20,
): Array<{ action_type: string; items: Array<Record<string, unknown>> }> {
  const tagged = items.map(it => ({ ...it, action_type: actionType }))
  return splitBatches(tagged, cap).map(g => ({
    action_type: actionType,
    items: g.items.map(it => { const { action_type: _drop, ...rest } = it; return rest }),
  }))
}

export function ingestAnnouncement(rawReply: string): { langs: Array<{ langCode: string; content: string }> } | null {
  try {
    const m = (rawReply ?? '').match(/```json([\s\S]*?)```/)
    const o = JSON.parse((m ? m[1] : rawReply).trim())
    if (o?.type !== 'be2-announcement-content' || !Array.isArray(o.langs)) return null
    return { langs: o.langs.map((l: { lang_code: string; content: string }) => ({ langCode: l.lang_code, content: l.content })) }
  } catch { return null }
}
