import type { AnnouncementCreateItem } from '../../../core/changeset/types.js'

const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

// schema-外語義：名稱長度、時間格式與先後、每 lang 必有 content。zod 已擋型別/必填（module.ts itemSchema）。
export function validateAnnouncementItems(items: AnnouncementCreateItem[]): { key: string; message: string } | null {
  for (const it of items) {
    const key = it.name || (it.prod_oids[0] ?? 'announcement')
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
