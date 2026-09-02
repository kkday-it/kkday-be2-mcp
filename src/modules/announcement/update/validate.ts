import type { AnnouncementUpdateItem } from '../../../core/changeset/types.js'

const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

// schema-外語義：mirrors create/validate.ts (name length, time format/order, per-lang content
// coverage) + announcementOid presence (zod already requires a positive int in module.ts's
// itemSchema; this is a defense-in-depth re-check, same spirit as create's post-zod checks).
export function validateAnnouncementUpdateItems(items: AnnouncementUpdateItem[]): { key: string; message: string } | null {
  for (const it of items) {
    const key = it.name || String(it.announcementOid ?? '') || (it.prod_oids[0] ?? 'announcement_update')
    if (!it.announcementOid || it.announcementOid <= 0) return { key, message: 'announcementOid is required' }
    if (!it.name.trim()) return { key, message: 'name is required' }
    if (it.name.length > 254) return { key, message: 'name must be <= 254 chars' }
    if (it.prod_oids.length === 0) return { key, message: 'prod_oids must be non-empty' }
    if (it.langs.length === 0) return { key, message: 'langs must be non-empty' }
    if (!DT.test(it.start_time)) return { key, message: 'start_time must be "YYYY-MM-DD HH:mm:ss"' }
    if (it.end_time != null) {
      if (!DT.test(it.end_time)) return { key, message: 'end_time must be "YYYY-MM-DD HH:mm:ss"' }
      if (it.end_time <= it.start_time) return { key, message: 'end_time must be after start_time' }
    }
    const haveContent = new Set(it.contents.map(c => c.lang))
    for (const lang of it.langs) {
      if (!haveContent.has(lang)) return { key, message: `content missing for lang ${lang}` }
    }
  }
  return null
}
