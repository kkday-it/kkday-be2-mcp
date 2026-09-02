import type { AnnouncementUpdateItem } from '../../../core/changeset/types.js'

// isomorphic（UI 與 server 共用，no zod/gateway/node imports）。announcementOid 是 PK，納入 key 維度
// ——同名同商品但不同 oid（例如同一批公告改了兩筆）仍需能分辨；用 [...].sort() 複製後排序，不 mutate 原 prod_oids。
export function itemKey(item: AnnouncementUpdateItem): string {
  return `announce_update:${item.announcementOid}:${item.name}:${[...item.prod_oids].sort().join(',')}:${item.start_time}`
}
