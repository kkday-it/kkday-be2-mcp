import type { z } from 'zod'
import type { ToolContext } from '../../tools/types.js'
import type { ChangeSetRecord, ItemResult } from '../../changeset/types.js'

// diff 計算的 ctx = 既有 diff 函式實際吃的 ToolContext（src/tools/types.ts:5
// {gateway, accessToken, userLabel}）——純重構：不縮水、不重造。
export type DiffCtx = ToolContext

// 執行期 ctx：批准當下才存在的身分欄位（spec §3；accessToken 為 spec 落地補充——
// 既有 executor 全部用它打 gateway，缺了無法通編譯）。
export interface ExecCtx {
  gateway: import('../../gateway/client.js').GatewayClient
  accessToken: string
  modifyUser: string
  userLabel: string
  sessionId: string
  channel?: 'panel' | 'confirm_page'
  span<T>(name: string, fn: (traceId: string) => Promise<T>): Promise<T>
  now: () => number
}

export interface ValidationResult { key: string; message: string }   // null = 通過（沿用現有慣例）

export interface ConfirmView {
  intro: string          // 表格上方說明段（含 module 高風險警語），HTML 字串
  tableHtml: string      // <table …> 本體（含 data-diff-version 屬性）
}

export interface ActionModule<Item = unknown, DiffI = unknown> {
  actionType: string
  itemSchema: z.ZodType<Item>
  authz: { codes: string[]; onMissing: 'block' | 'warn' }
  invalidItemsMessage: string          // INVALID_ITEMS envelope 的既有文案（per-type，逐字保留）
  scopeNotReadMessage: string          // SCOPE_NOT_READ envelope 的既有文案（per-type，逐字保留）
  isItem(i: unknown): i is Item        // 既有 runtime type-guard 搬入（zod 驗過形仍需窄化）
  scopeOids(item: Item): string[]      // scope gate 查的 oids；同時是 readOidsOut 來源
  scopeErrorKey(item: Item): string    // SCOPE_NOT_READ 的 key 欄位值（既有 per-type 規則逐字保留）
  validate(items: Item[], nowMs: number): ValidationResult | null
  computeDiff(ctx: DiffCtx, items: Item[]): Promise<DiffI[]>
  diffVersion(diff: DiffI[]): string
  itemKey(d: Item | DiffI): string
  execute(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]>
  renderConfirm(rec: ChangeSetRecord, diff: DiffI[], diffVersion: string, banner: string): ConfirmView
                                       // banner = route 層動態紅字（stale/CAS），module 當不透明字串
                                       // 放在自己現行頁面的精確位置（Task 6 說明）
  wizard?: unknown                     // 佔位型別；Task 8 定為 WizardDescriptor（僅 batch 型）
}
