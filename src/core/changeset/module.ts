import type { z } from 'zod'
import type { ToolContext } from '../../tools/types.js'
import type { ChangeSetRecord, ItemResult } from './types.js'

export type DiffCtx = ToolContext

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

export interface ValidationResult { key: string; message: string }

export interface ConfirmView {
  intro: string
  tableHtml: string
}

export interface WizardRowInput {
  checked: boolean; is_bundle: boolean
  prod_oid: string; pkg_oid: string; pkg_name: string
  item_oid?: string; supplier_oid?: string
  queue: Array<{ reserve_date_utc: string; reserve_status: boolean }>; cleared: boolean
  quantity?: number   // inventory_setting: per-row fullday SET target
}

export interface DomHelpers {
  el(tag: string, className?: string): HTMLElement
  text(node: HTMLElement, v: unknown): void
  renderQueueLines(el: HTMLElement, q: unknown[], emptyLabel?: string): void
}

export interface WizardDescriptor {
  label: string
  itemKey(d: Record<string, unknown>): string
  buildItems(rows: WizardRowInput[], opts: { target?: string }): unknown[]
  renderDiffCard(d: Record<string, unknown>, h: DomHelpers): HTMLElement
  step2WarningText?: string
}

export interface ActionModule<Item = unknown, DiffI = unknown> {
  actionType: string
  // core 排程層 opt-in,見 spec §5;有原生排程欄位的 domain 不開
  schedulable?: boolean
  shapeFamily?: string // 同 shapeFamily 的模組共用寬鬆基底形狀，互斥性測試對家族內豁免、diffVersion 敏感度測試共用同一 mutation 分支
  itemSchema: z.ZodType<Item>
  authz: { codes: string[]; onMissing: 'block' | 'warn' }
  invalidItemsMessage: string
  scopeNotReadMessage: string
  isItem(i: unknown): i is Item
  scopeOids(item: Item): string[]
  scopeErrorKey(item: Item): string
  validate(items: Item[], nowMs: number): ValidationResult | null
  computeDiff(ctx: DiffCtx, items: Item[]): Promise<DiffI[]>
  diffVersion(diff: DiffI[]): string
  itemKey(d: Item | DiffI): string
  execute(ctx: ExecCtx, rec: ChangeSetRecord): Promise<ItemResult[]>
  renderConfirm(rec: ChangeSetRecord, diff: DiffI[], diffVersion: string, banner: string): ConfirmView
  wizard?: WizardDescriptor
}
