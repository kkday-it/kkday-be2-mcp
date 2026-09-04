import type { DiffCtx } from '../../../core/changeset/module.js'
import type {
  AnnouncementUpdateItem, AnnouncementUpdateDiffItem, AnnouncementCurrentSnapshot, AnnouncementLangContent,
} from '../../../core/changeset/types.js'
import { extractProductInfo } from '../../../tools/findProducts.js'
import type { AnnouncementClient } from '../create/svcB2cClient.js'

// GET /admin/product/announcement/{oid} wire shape (§6.1/§6.3). Read-side field names differ from
// write-side (`langs` vs `langSettings`) and `prodOids` comes back as a STRING, not an array.
export interface RawAnnouncementDetail {
  productAnnouncementOid?: number
  name?: string
  prodOids?: unknown          // GET: string like "[268051,285981]"; defensively accept array too
  isEnabled?: boolean
  startTime?: string
  endTime?: string | null
  langs?: Array<{ langCode?: string; content?: string }>
}

// §6.3 prodOids 型別三態：GET 回字串 "[268051,285981]"、list 回真陣列、寫入送 int[]。正規化成
// string[]（跟 AnnouncementCreateItem.prod_oids 同形狀），失敗一律回 []（現況視為未知，非致命）。
export function parseCurrentProdOids(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch { /* fall through to [] */ }
  }
  return []
}

function toCurrentSnapshot(raw: RawAnnouncementDetail): AnnouncementCurrentSnapshot {
  const contents: AnnouncementLangContent[] = (raw.langs ?? [])
    .filter((l): l is { langCode: string; content?: string } => typeof l?.langCode === 'string')
    .map(l => ({ lang: l.langCode, content: l.content ?? '' }))
  return {
    name: raw.name ?? '',
    is_enabled: raw.isEnabled ?? false,
    prod_oids: parseCurrentProdOids(raw.prodOids),
    start_time: raw.startTime ?? '',
    end_time: raw.endTime ?? null,
    langs: contents.map(c => c.lang),
    contents,
  }
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort(); const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

function sameContents(a: AnnouncementLangContent[], b: AnnouncementLangContent[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x.lang.localeCompare(y.lang))
  const sb = [...b].sort((x, y) => x.lang.localeCompare(y.lang))
  return sa.every((v, i) => v.lang === sb[i].lang && v.content === sb[i].content)
}

// 單一事實來源：current snapshot 與 target item 是否等價（無實際變更）。computeAnnouncementUpdateDiff
// 的確認頁 noop 判斷、與 executor 的略過 PATCH 判斷，都呼叫這一份比較，避免兩處各寫一套而在
// 欄位增修時互相漂移（executor 9b review finding）。
function isNoop(current: AnnouncementCurrentSnapshot, it: AnnouncementUpdateItem): boolean {
  return current.name === it.name
    && current.is_enabled === it.is_enabled
    && current.start_time === it.start_time
    && (current.end_time ?? null) === (it.end_time ?? null)
    && sameStringSet(current.prod_oids, it.prod_oids)
    && sameContents(current.contents, it.contents)
}

// executor 專用入口：raw GET detail（或 undefined，讀取失敗/未知）直接比對 target，undefined 一律
// 視為「非 noop」（未知現況不可略過寫入，維持 read-merge-write 現有的保守行為）。
export function computeAnnouncementNoop(it: AnnouncementUpdateItem, raw: RawAnnouncementDetail | undefined): boolean {
  if (!raw) return false
  return isNoop(toCurrentSnapshot(raw), it)
}

// UNLIKE create (target-only), update 綁 live current：先讀現況（GET detail）再與 target 比較，
// 供確認頁顯示 before→after + 判斷 noop。client 可為 undefined（dev/test 無 API_ANNOUNCE_KEY，
// 或建構失敗）——此時 current = null（未知），不阻擋 staging（同 create 的安全建構模式）。
export async function computeAnnouncementUpdateDiff(
  items: AnnouncementUpdateItem[], ctx: DiffCtx, client: AnnouncementClient | undefined,
): Promise<AnnouncementUpdateDiffItem[]> {
  const out: AnnouncementUpdateDiffItem[] = []
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
    let current: AnnouncementCurrentSnapshot | null = null
    if (client) {
      try {
        // ctx.traceId 貫穿進 svc-b2c request-uuid header，讓這筆 live-diff 讀取也能 join 回 MCP audit（F3）。
        const raw = await client.getDetail(ctx.accessToken, it.announcementOid, ctx.traceId) as RawAnnouncementDetail
        current = toCurrentSnapshot(raw)
      } catch { /* leave current = null (讀取失敗/未知，不阻擋 staging) */ }
    }
    const noop = current !== null && isNoop(current, it)
    out.push({
      announcementOid: it.announcementOid,
      prod_oids: it.prod_oids,
      product_names: names.every((n, i) => n === it.prod_oids[i]) ? [] : names, // 全部退回 oid 即視為讀取失敗，回空陣列
      name: it.name, is_enabled: it.is_enabled, start_time: it.start_time,
      end_time: it.end_time ?? null, langs: it.langs, contents: it.contents,
      current, noop,
    })
  }
  return out
}
