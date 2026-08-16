import { randomUUID, createHash } from 'node:crypto'

export type NonceBind = { changesetId: string; diffVersion: string; sessionId: string }
const key = (b: NonceBind) => `${b.changesetId}|${b.diffVersion}|${b.sessionId}`
const hash = (n: string) => createHash('sha256').update(n).digest('hex')

// 面板批准的一次性密碼。只存 hash；綁 (changeset, diff_version, session) 三元組；單次消耗；TTL。
// model 拿不到 nonce 的保證來自 host（spike T5/T6）+ nonce 不進 model context（T2）；此 store
// 只負責「就算 model 幻覺呼叫，也得先有正確 nonce」這層。
export class ApprovalNonceStore {
  private live = new Map<string, { bind: string; exp: number }>()
  private ttlMs: number
  private now: () => number
  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000
    this.now = opts.now ?? Date.now
  }
  issue(bind: NonceBind): string {
    this.sweep()                                     // 惰性清除：把已過期項目擋在成長點之前
    const n = randomUUID() + randomUUID()
    this.live.set(hash(n), { bind: key(bind), exp: this.now() + this.ttlMs })
    return n
  }
  verifyAndConsume(nonce: string, bind: NonceBind): boolean {
    const h = hash(nonce); const rec = this.live.get(h)
    if (!rec) return false
    this.live.delete(h)                              // 單次：無論成敗都消耗
    if (rec.exp < this.now()) return false
    return rec.bind === key(bind)
  }
  // 面板每 20s 輪詢一次 app_get_changeset_view 就會 issue() 一顆新 nonce；只有真正被
  // verifyAndConsume 的那顆會被刪除，其餘在 process 生命週期內原本會無限累積（TTL 只讓
  // verify 回 false，從不驅逐）。issue() 是成長點，故在此惰性掃描、刪除已過期項目，
  // 把 Map 大小長期維持在「未過期 nonce 數」量級，不需額外計時器。
  private sweep(): void {
    const t = this.now()
    for (const [h, rec] of this.live) {
      if (rec.exp < t) this.live.delete(h)
    }
  }
  // 僅供測試證明 sweep 真的驅逐了項目（而不只是驗證時判過期）。
  size(): number {
    return this.live.size
  }
}
