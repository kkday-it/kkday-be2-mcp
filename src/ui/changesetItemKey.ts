import { itemKey as invKey } from '../modules/product/inventorySetting/keys.js'
import { itemKey as announceKey } from '../modules/announcement/create/keys.js'
import { itemKey as announceUpdateKey } from '../modules/announcement/update/keys.js'
import { itemKey as shelfKey } from '../modules/product/shelfToggle/keys.js'

// itemKey 規則須與 server 端完全一致，否則 confirmed_keys 永遠對不上、approve 一律
// CONFIRMED_KEYS_MISMATCH：
//   - announcement_update：src/modules/announcement/update/keys.ts#itemKey → announce_update:announcementOid:name:prod_oids:start_time
//   - announcement（create）：src/modules/announcement/create/keys.ts#itemKey → announce:name:prod_oids:start_time
//   - shelf：src/modules/product/shelfToggle/keys.ts#itemKey → pkg_oid ? `${prod_oid}:${pkg_oid}` : prod_oid
//   - inventory：src/modules/product/inventorySetting/keys.ts#itemKey → `${item_oid}:${supplier_oid}`
// 用 diff item 的形狀分辨：announcement_update 帶 announcementOid（PK）——必須「在 create 判斷前」攔截，
// 否則它 prod_oids[]/無 item_oid 的形狀會被誤算成 create 的 key（漏 announcementOid）；create 只有
// prod_oids[]（無 item_oid、無 announcementOid）；inventory 帶 item_oid；其餘走 shelf。
// 抽成獨立、無 DOM 依賴的模組（changeset-panel.ts 在 import 時會觸碰 document，非 import-safe），
// 讓 itemKeyOf 可被單元測試直接 import（tests/ui/changesetPanelAnnouncement.test.ts）。
export function itemKeyOf(d: any): string {
  if (d && typeof d === 'object' && 'announcementOid' in d) return announceUpdateKey(d)
  if (d && typeof d === 'object' && 'prod_oids' in d && !('item_oid' in d)) return announceKey(d)
  if (d && typeof d === 'object' && 'item_oid' in d) return invKey(d)
  return shelfKey(d)
}
