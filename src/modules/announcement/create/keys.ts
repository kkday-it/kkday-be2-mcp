import type { AnnouncementCreateItem } from '../../../core/changeset/types.js'

// isomorphic（UI 與 server 共用）。用 [...].sort() 複製後排序，不 mutate 原 prod_oids。
export function itemKey(item: AnnouncementCreateItem): string {
  return `announce:${item.name}:${[...item.prod_oids].sort().join(',')}:${item.start_time}`
}
