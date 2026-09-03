import type { DiffCtx } from '../../../core/changeset/module.js'
import type { AnnouncementCreateItem, AnnouncementDiffItem } from '../../../core/changeset/types.js'
import { extractProductInfo } from '../../../tools/findProducts.js'
import type { AnnouncementClient } from './svcB2cClient.js'

// create 無「現況可比」，但守主 spec §4「嚴禁盲寫」：讀商品名 + 既有公告數當 context（非 blocker）。
// 任何讀取失敗一律降級（product_names 留空、existing_count = null 表未知），不阻擋 staging。
// client 可為 undefined（dev/test 無 API_ANNOUNCE_KEY，或建構失敗）——此時 existing_count 留 null
// （未知），不阻擋 staging。這是 create 的 draft-only 開發不被 svc-b2c 授權/金鑰擋住的關鍵。
export async function computeAnnouncementDiff(
  items: AnnouncementCreateItem[], ctx: DiffCtx, client: AnnouncementClient | undefined,
): Promise<AnnouncementDiffItem[]> {
  const out: AnnouncementDiffItem[] = []
  for (const it of items) {
    const names: string[] = []
    for (const oid of it.prod_oids) {
      try {
        const info = await ctx.gateway.get(`/product/api/v1/drafts/products/${encodeURIComponent(oid)}/info`, ctx.accessToken)
        names.push(extractProductInfo(info).name ?? oid)
      } catch {
        names.push(oid)  // 讀不到商品名 → 退回顯示 oid（非致命）
      }
    }
    let existing: number | null = null
    if (client) {
      try {
        existing = (await client.listByProdOids(ctx.accessToken, it.prod_oids)).length
      } catch { /* leave existing = null (未知) */ }
    }
    out.push({
      prod_oids: it.prod_oids,
      product_names: names.every((n, i) => n === it.prod_oids[i]) ? [] : names, // 全部退回 oid 即視為讀取失敗，回空陣列
      name: it.name, is_enabled: it.is_enabled, start_time: it.start_time,
      end_time: it.end_time ?? null, langs: it.langs, contents: it.contents,
      existing_count: existing, noop: false,
    })
  }
  return out
}
