import type { ExecCtx } from '../../../core/changeset/module.js'
import type { AnnouncementCreateItem, ChangeSetRecord, ItemResult } from '../../../core/changeset/types.js'
import { itemKey } from './keys.js'
import { AnnouncementClient, makeAnnouncementClient } from './svcB2cClient.js'
import { GatewayError } from '../../../errors.js'

// POST wire body — §6.2 表單語義 best-guess，UNVERIFIED（待一次真 create 攔到校正；集中此一處）。
// modify_user = ExecCtx.modifyUser（= JWT platformId，同 user-uuid）。prodOids 轉 number[]（對齊 native row）。
function toBody(it: AnnouncementCreateItem, modifyUser: string): Record<string, unknown> {
  return {
    name: it.name,
    isEnabled: it.is_enabled,
    prodOids: it.prod_oids.map(Number),
    startTime: it.start_time,
    endTime: it.end_time ?? null,
    langs: it.langs,
    contents: it.contents,
    modify_user: modifyUser,
  }
}

export async function executeAnnouncementWith(
  client: AnnouncementClient, ctx: ExecCtx, rec: ChangeSetRecord,
): Promise<ItemResult[]> {
  const results: ItemResult[] = []
  for (const it of rec.items as AnnouncementCreateItem[]) {
    const key = itemKey(it)
    const r = await ctx.span('changeset.execute/announcement', async (traceId): Promise<ItemResult> => {
      try {
        const after = await client.create(ctx.accessToken, toBody(it, ctx.modifyUser))
        return { item_key: key, status: 'done', before: null, after, trace_id: traceId }
      } catch (e) {
        const ge = e as GatewayError
        return {
          item_key: key, status: 'failed', trace_id: traceId,
          error_code: (ge?.code as string) ?? 'ANNOUNCE_CREATE_FAILED',
          error_message: (e as Error)?.message ?? 'announcement create failed',
        }
      }
    })
    results.push(r)
  }
  return results
}

export async function executeAnnouncement(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]> {
  // 安全建構：無 API_ANNOUNCE_KEY 時 makeAnnouncementClient() 會 throw。同步拋出會讓整個執行段
  // 崩潰（而非把每筆標 failed）——改為 catch 後把每筆 item 記為 failed，change-set 得到明確 per-item
  // 結果而非整批 crash。（正常 live 執行時金鑰存在，走 executeAnnouncementWith 正常路徑。）
  let client: AnnouncementClient
  try {
    client = makeAnnouncementClient()
  } catch (e) {
    const ge = e as GatewayError
    return (rec.items as AnnouncementCreateItem[]).map(it => ({
      item_key: itemKey(it),
      status: 'failed' as const,
      trace_id: '',
      error_code: (ge?.code as string) ?? 'ANNOUNCE_CLIENT_UNAVAILABLE',
      error_message: (e as Error)?.message ?? 'announcement client unavailable',
    }))
  }
  return executeAnnouncementWith(client, ctx, rec)
}
