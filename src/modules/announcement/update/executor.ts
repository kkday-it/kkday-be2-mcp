import type { ExecCtx } from '../../../core/changeset/module.js'
import type { AnnouncementUpdateItem, ChangeSetRecord, ItemResult } from '../../../core/changeset/types.js'
import { itemKey } from './keys.js'
import { parseCurrentProdOids, computeAnnouncementNoop, type RawAnnouncementDetail } from './diff.js'
import { AnnouncementClient, makeAnnouncementClient } from '../create/svcB2cClient.js'
import { GatewayError } from '../../../errors.js'

// read-merge-write, §6.2/§6.3: build the FULL document the PATCH expects. itemSchema requires the
// same full shape as create (module.ts) so target fields always have a value to send — the one
// place a "target if provided, else parsed current" fallback matters is prodOids, because of the
// read/write type asymmetry (GET returns a STRING, PATCH wants int[]): if a caller ever omits
// prod_oids (schema loosened later, or current read is all we have), fall back to the current's
// parsed prodOids rather than sending an empty array.
export function toFullDoc(it: AnnouncementUpdateItem, current: RawAnnouncementDetail | undefined): Record<string, unknown> {
  const prodOids = it.prod_oids && it.prod_oids.length > 0
    ? it.prod_oids.map(Number)
    : parseCurrentProdOids(current?.prodOids).map(Number)
  return {
    name: it.name,
    isEnabled: it.is_enabled,
    prodOids,
    startTime: it.start_time,
    endTime: it.end_time ?? null,          // PATCH 無值送 null（非 ""，§6.1）
    // 整包送出（full REPLACE，§6.2）；READ 用 langs，WRITE 用 langSettings（§6.3 欄位名不對稱）。
    langSettings: it.contents.map(c => ({ langCode: c.lang, content: c.content })),
  }
}

export async function executeAnnouncementUpdateWith(
  client: AnnouncementClient, ctx: ExecCtx, rec: ChangeSetRecord,
): Promise<ItemResult[]> {
  const results: ItemResult[] = []
  for (const it of rec.items as AnnouncementUpdateItem[]) {
    const key = itemKey(it)
    const r = await ctx.span('changeset.execute/announcement_update', async (traceId): Promise<ItemResult> => {
      // step 1: read current (read-merge-write). itemSchema already requires the full target
      // document, so a read failure here degrades (current = undefined) rather than blocking the
      // write — target alone is enough to build a complete, correct body.
      let current: RawAnnouncementDetail | undefined
      try {
        current = await client.getDetail(ctx.accessToken, it.announcementOid) as RawAnnouncementDetail
      } catch { current = undefined }
      // no-op guard (9b review): if the target is equivalent to the live current, skip the PATCH
      // entirely — re-sending identical content still fires a back-end cache-clear + front-end
      // notification for nothing. Mirrors the sibling skipped_noop invariant (shelfToggle/
      // inventorySetting executors). Reuses the diff layer's single-source-of-truth comparison
      // (computeAnnouncementNoop) rather than re-inventing it here.
      if (computeAnnouncementNoop(it, current)) {
        return { item_key: key, status: 'skipped_noop', before: current ?? null, after: current ?? null, trace_id: traceId }
      }
      const body = toFullDoc(it, current)
      try {
        // step 2: write the merged full document. announcementOid is validated (zod z.number()
        // .int().positive() in module.ts) before reaching here — no raw/unvalidated URL interpolation.
        await client.patch(ctx.accessToken, it.announcementOid, body)
        return { item_key: key, status: 'done', before: current ?? null, after: body, trace_id: traceId }
      } catch (e) {
        const ge = e as GatewayError
        return {
          item_key: key, status: 'failed', before: current ?? null, trace_id: traceId,
          error_code: (ge?.code as string) ?? 'ANNOUNCE_UPDATE_FAILED',
          error_message: (e as Error)?.message ?? 'announcement update failed',
        }
      }
    })
    results.push(r)
  }
  return results
}

export async function executeAnnouncementUpdate(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]> {
  // 安全建構：無 API_ANNOUNCE_KEY 時 makeAnnouncementClient() 會 throw。同步拋出會讓整個執行段
  // 崩潰（而非把每筆標 failed）——改為 catch 後把每筆 item 記為 failed（同 create/executor 的模式）。
  let client: AnnouncementClient
  try {
    client = makeAnnouncementClient()
  } catch (e) {
    const ge = e as GatewayError
    return (rec.items as AnnouncementUpdateItem[]).map(it => ({
      item_key: itemKey(it),
      status: 'failed' as const,
      trace_id: ctx.traceId,
      error_code: (ge?.code as string) ?? 'ANNOUNCE_CLIENT_UNAVAILABLE',
      error_message: (e as Error)?.message ?? 'announcement client unavailable',
    }))
  }
  return executeAnnouncementUpdateWith(client, ctx, rec)
}
