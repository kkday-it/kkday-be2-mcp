import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import type { AnnouncementCreateItem, AnnouncementDiffItem } from '../../../core/changeset/types.js'
import { itemKey } from './keys.js'
import { validateAnnouncementItems } from './validate.js'
import { computeAnnouncementDiff } from './diff.js'
import { executeAnnouncement } from './executor.js'
import { renderConfirm } from './renderer.js'
import { makeAnnouncementClient } from './svcB2cClient.js'

const langContentShape = z.object({ lang: z.string().min(1), content: z.string() })
// .strict()：announcement_update 的 itemSchema 是 create 的超集（多一個必填 announcementOid，
// module-onboarding §3/9b）。core/changeset/tools.ts 的 itemShape 是 z.union(所有 module schema)——
// 若 create 這份非 strict，update item（含 announcementOid）會被 create 的寬鬆 schema「命中」並把
// announcementOid 剝除（zod 預設 strip 模式），union 短路成 create 的形狀，PK 遺失。strict 讓多餘鍵
// 的 update item 無法命中 create schema，跟 shelf_toggle 的 product/plan 是同一個既有修法（見該檔案）。
const announcementItemShape = z.object({
  prod_oids: z.array(z.string().min(1)).min(1),
  name: z.string().min(1).max(254),
  is_enabled: z.boolean(),
  start_time: z.string().min(1),
  end_time: z.string().nullable().optional(),
  langs: z.array(z.string().min(1)).min(1),
  contents: z.array(langContentShape),
}).strict()

function isAnnouncementItem(i: unknown): i is AnnouncementCreateItem {
  const a = i as AnnouncementCreateItem
  return Array.isArray(a?.prod_oids) && typeof a?.name === 'string' && Array.isArray(a?.langs) && Array.isArray(a?.contents)
}

export const ANNOUNCEMENT_ACTION_CODES = ['product.announcement.update']

export const announcementCreateModule: ActionModule<AnnouncementCreateItem, AnnouncementDiffItem> = {
  actionType: 'announcement',
  itemSchema: announcementItemShape,
  // live 寫入卡 svc-b2c S2S 403（契約已知、live 待授權）；沿用其他 module 的 warn degrade，
  // 讓 draft-only 開發不被 businessList 缺碼擋住（真正授權在 svc-b2c /verify 於執行時把關）。
  authz: { codes: ANNOUNCEMENT_ACTION_CODES, onMissing: 'warn' },
  invalidItemsMessage: 'announcement items need {prod_oids, name, is_enabled, start_time, langs, contents}.',
  scopeNotReadMessage: 'These prod_oids were not looked up in this session; open the announcement wizard (be2_open_announcement_wizard) to load them first.',
  isItem: isAnnouncementItem,
  scopeOids: (item) => item.prod_oids,
  scopeErrorKey: (item) => item.prod_oids.join(','),
  validate: (items) => validateAnnouncementItems(items),
  computeDiff: (ctx: DiffCtx, items) => {
    // 安全建構：dev/test 無 SIT_ANNOUNCE_API_KEY 時 makeAnnouncementClient() 會 throw；若在此同步拋出
    // 會擋掉整個 change-set 建立（staging）。改為 try/catch → 傳 undefined，computeAnnouncementDiff 內
    // existing_count 降級為未知，draft-only 開發不被金鑰/授權擋住。
    let client: ReturnType<typeof makeAnnouncementClient> | undefined
    try { client = makeAnnouncementClient() } catch { client = undefined }
    return computeAnnouncementDiff(items, ctx, client)
  },
  diffVersion: (diff) => {
    // create = target-only（無 live current 需綁）。hash 目標 payload（含 contents，內文改動要使批准 stale）；
    // existing_count 是 context、不納入。contents 依 lang 排序後序列化，順序無關。
    const canon = diff.map(d => {
      const contents = [...d.contents].sort((a, b) => a.lang.localeCompare(b.lang)).map(c => `${c.lang}=${c.content}`).join('§')
      return `announce:${d.name}:${[...d.prod_oids].sort().join(',')}:${d.start_time}:${d.end_time ?? ''}:${d.is_enabled}:${[...d.langs].sort().join(',')}:${contents}`
    }).sort().join('|')
    return createHash('sha256').update(canon).digest('hex')
  },
  itemKey: itemKey as ActionModule<AnnouncementCreateItem, AnnouncementDiffItem>['itemKey'],
  execute: executeAnnouncement,
  renderConfirm,
}
