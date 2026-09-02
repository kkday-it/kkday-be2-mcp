import type { GatewayClient } from './client.js'
import { GatewayError } from '../errors.js'
import { toEnvelopeError, type EnvelopeError } from '../tools/envelope.js'

// mid → prod_oid 是商品目錄的靜態事實(不是 session 行為記錄),全域共用、不分 session。
// mid↔oid 一旦建立即不變(oid 自增主鍵、mid 獨立序列,皆不重新指派),故無 TTL / 失效機制。
// 全域(不分 user)是刻意決策(spec §7.3 + §4 codex 註記):cache 只存「mid↔oid 編號對照」非機密靜態
// 事實,不存商品內容;真正商品讀取(packages/info/switch 等)仍走各 user 自己 token 的 per-user gate,
// 授權邊界不因 cache 失守。若日後 mid-info 端點被賦予 per-user 機密語義,再改 per-user cache。
const midToOidCache = new Map<string, string>()

// 僅供測試重置 cache;正式碼不呼叫。
export function __clearMidCache(): void { midToOidCache.clear() }

export async function resolveProdOid(mid: string, gateway: GatewayClient, accessToken: string): Promise<string> {
  const cached = midToOidCache.get(mid)
  if (cached) return cached
  let info: unknown
  try {
    info = await gateway.get(`/product/api/v1/drafts/products/mid-${encodeURIComponent(mid)}/info`, accessToken)
  } catch (e) {
    // gateway.get 對非 2xx 一律 throw GatewayError(見 client.ts#unwrap,已保留 be2 原始 code/status)。
    // 只有 404「找不到商品」才是 mid 混淆的徵兆 → 改寫成 MID_RESOLVE_FAILED + 提示;其餘(403 無權、
    // 500/502 gateway 故障、network)原樣 rethrow,保留原始 code/status,不誤報成「填錯欄位」(codex Issue 3)。
    const status = (e as { status?: number })?.status
    if (status !== 404) throw e
    throw new GatewayError(
      'MID_RESOLVE_FAILED',
      `mid ${mid} 找不到對應商品。若你是從 be2-web 網址複製這個數字,它可能其實是 prod_oid 而非 prod_mid,請改用 prod_oid 欄位。`,
      404,
    )
  }
  const oid = String((info as Record<string, unknown>)?.prod_oid ?? '')
  if (!oid) {
    throw new GatewayError('MID_RESOLVE_FAILED', `mid ${mid} 的商品資訊缺少 prod_oid 欄位,請確認 mid 正確或聯絡開發`, 500)
  }
  midToOidCache.set(mid, oid)
  return oid
}

export async function resolveProdOids(
  mids: string[], oids: string[], gateway: GatewayClient, accessToken: string,
): Promise<{ resolved: string[]; resolutions: Array<{ mid: string; oid: string }>; errors: EnvelopeError[] }> {
  // dedup mids:同批傳入的重複 mid 在 cache 寫入前一起發出,會 stampede 同一支 mid-info API;去重後
  // 每個唯一 mid 只解析一次(resolutions 亦為每個唯一 mid 一筆)。
  const uniqMids = [...new Set(mids)]
  const resolutions: Array<{ mid: string; oid: string }> = []
  const errors: EnvelopeError[] = []
  // 分批(每批 ≤5)對齊 find_products 既有 gateway burst 控制(5-oid 一批、峰值 ≤10 GET),避免最多 20 個
  // unique mid 瞬間打 20 個 mid-info GET 再進商品查詢的 regression(codex Issue 5)。
  for (let i = 0; i < uniqMids.length; i += 5) {
    const batch = uniqMids.slice(i, i + 5)
    const settled = await Promise.allSettled(batch.map(mid => resolveProdOid(mid, gateway, accessToken)))
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') resolutions.push({ mid: batch[j], oid: s.value })
      else errors.push(toEnvelopeError(batch[j], s.reason))
    })
  }
  // dedup resolved:oids 與 mid 解出的 oid 若重疊(同一商品同時以 mid 與 oid 傳入,或兩 mid 指同一 oid),
  // 去重避免下游(find_products / buildBatchView)重複 fetch 與回傳同一 record。保留首次出現順序。
  return { resolved: [...new Set([...oids, ...resolutions.map(r => r.oid)])], resolutions, errors }
}
