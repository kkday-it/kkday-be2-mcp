import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ActionModule, DiffCtx } from '../../../core/changeset/module.js'
import type { AnnouncementUpdateItem, AnnouncementUpdateDiffItem } from '../../../core/changeset/types.js'
import { itemKey } from './keys.js'
import { validateAnnouncementUpdateItems } from './validate.js'
import { computeAnnouncementUpdateDiff } from './diff.js'
import { executeAnnouncementUpdate } from './executor.js'
import { renderConfirm } from './renderer.js'
import { makeAnnouncementClient } from '../create/svcB2cClient.js'

const langContentShape = z.object({ lang: z.string().min(1), content: z.string() })
const announcementUpdateItemShape = z.object({
  announcementOid: z.number().int().positive(),
  prod_oids: z.array(z.string().min(1)).min(1),
  name: z.string().min(1).max(254),
  is_enabled: z.boolean(),
  start_time: z.string().min(1),
  end_time: z.string().nullable().optional(),
  langs: z.array(z.string().min(1)).min(1),
  contents: z.array(langContentShape),
})

function isAnnouncementUpdateItem(i: unknown): i is AnnouncementUpdateItem {
  const a = i as AnnouncementUpdateItem
  return typeof a?.announcementOid === 'number' && Array.isArray(a?.prod_oids) && typeof a?.name === 'string'
    && Array.isArray(a?.langs) && Array.isArray(a?.contents)
}

// 同 create：product.announcement.update 這個 businessList 碼名字本來就是 update，create/edit 共用（契約 §4）。
export const ANNOUNCEMENT_UPDATE_ACTION_CODES = ['product.announcement.update']

export const announcementUpdateModule: ActionModule<AnnouncementUpdateItem, AnnouncementUpdateDiffItem> = {
  actionType: 'announcement_update',
  itemSchema: announcementUpdateItemShape,
  // live 寫入卡 svc-b2c S2S 403（契約已知、live 待授權）；沿用 create 與其他 module 的 warn degrade，
  // 讓 draft-only 開發不被 businessList 缺碼擋住（真正授權在 svc-b2c /verify 於執行時把關）。
  authz: { codes: ANNOUNCEMENT_UPDATE_ACTION_CODES, onMissing: 'warn' },
  invalidItemsMessage: 'announcement_update items need {announcementOid, prod_oids, name, is_enabled, start_time, langs, contents}.',
  scopeNotReadMessage: 'These prod_oids were not looked up in this session; open the announcement wizard (be2_open_announcement_wizard) to load them first.',
  isItem: isAnnouncementUpdateItem,
  scopeOids: (item) => item.prod_oids,
  scopeErrorKey: (item) => item.prod_oids.join(','),
  validate: (items) => validateAnnouncementUpdateItems(items),
  computeDiff: (ctx: DiffCtx, items) => {
    // 安全建構：dev/test 無 SIT_ANNOUNCE_API_KEY 時 makeAnnouncementClient() 會 throw；若在此同步拋出
    // 會擋掉整個 change-set 建立（staging）。改為 try/catch → 傳 undefined，computeAnnouncementUpdateDiff
    // 內 current 降級為 null（未知），draft-only 開發不被金鑰/授權擋住。
    let client: ReturnType<typeof makeAnnouncementClient> | undefined
    try { client = makeAnnouncementClient() } catch { client = undefined }
    return computeAnnouncementUpdateDiff(items, ctx, client)
  },
  diffVersion: (diff) => {
    // update 綁 live current（跟 create 的 target-only 不同）：hash 同時納入 target payload 與已讀
    // 到的 current 快照，讓「批准前 live 現況又被別人改了」也會使 diffVersion 改變（stale 偵測）。
    const canon = diff.map(d => {
      const contents = [...d.contents].sort((a, b) => a.lang.localeCompare(b.lang)).map(c => `${c.lang}=${c.content}`).join('§')
      const target = `${d.announcementOid}:${d.name}:${[...d.prod_oids].sort().join(',')}:${d.start_time}:${d.end_time ?? ''}:${d.is_enabled}:${[...d.langs].sort().join(',')}:${contents}`
      const cur = d.current
      const curContents = cur ? [...cur.contents].sort((a, b) => a.lang.localeCompare(b.lang)).map(c => `${c.lang}=${c.content}`).join('§') : ''
      const current = cur
        ? `${cur.name}:${[...cur.prod_oids].sort().join(',')}:${cur.start_time}:${cur.end_time ?? ''}:${cur.is_enabled}:${[...cur.langs].sort().join(',')}:${curContents}`
        : 'unknown'
      return `announce_update:${target}|cur:${current}`
    }).sort().join('|')
    return createHash('sha256').update(canon).digest('hex')
  },
  itemKey: itemKey as ActionModule<AnnouncementUpdateItem, AnnouncementUpdateDiffItem>['itemKey'],
  execute: executeAnnouncementUpdate,
  renderConfirm,
}
