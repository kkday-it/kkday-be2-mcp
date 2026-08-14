export type ActionType = 'shelf_toggle_product' | 'shelf_toggle_plan' | 'inventory_setting' | 'inventory_platform' | 'shelf_schedule'
export type ChangeSetStatus = 'pending_approval' | 'approved' | 'executing' | 'done' | 'partial' | 'failed' | 'rejected' | 'expired'

export interface ChangeSetItem {
  prod_oid: string
  pkg_oid?: string
  target_is_active: boolean
}

export type InventoryOp = 'set' | 'adjust'

export interface InventoryItem {
  item_oid: string
  supplier_oid: string
  op: InventoryOp
  quantity: number
  dates: string[]
}

export type InventoryPlatform = 'BE2' | 'BE2_SCM' | 'EXTERNAL'

export interface InventoryPlatformItem {
  item_oid: string
  supplier_oid: string
  target: InventoryPlatform
  affected_pkgs: Array<{ prod_oid: string; pkg_oid: string; pkg_name: string }>
}

// "YYYY-MM-DD HH:mm:ss", UTC (spec §4.2 — server/store are UTC-only; panel handles local<->UTC).
export interface ScheduleEntry {
  reserve_date_utc: string
  reserve_status: boolean
}

export interface ShelfScheduleItem {
  prod_oid: string
  pkg_oid: string
  queue: ScheduleEntry[]
}

export type AnyChangeSetItem = ChangeSetItem | InventoryItem | InventoryPlatformItem | ShelfScheduleItem

export interface DiffItem {
  prod_oid: string
  pkg_oid?: string
  name?: string
  current_is_active?: boolean
  target_is_active: boolean
  no_op: boolean
}

export interface InventoryDateDiff {
  date: string
  current?: number
  target?: number
  no_op: boolean
  would_go_negative: boolean
}

export interface InventoryDiffItem {
  item_oid: string
  supplier_oid: string
  op: InventoryOp
  quantity: number
  dates: InventoryDateDiff[]
}

export type AnyDiffItem = DiffItem | InventoryDiffItem

export interface ItemResult {
  item_key: string
  status: 'done' | 'skipped_noop' | 'failed' | 'stale' | 'partial'
  before?: unknown
  after?: unknown
  error_code?: string
  error_message?: string
  trace_id: string
}

export interface ChangeSetRecord {
  id: string
  creatorLabel: string
  creatorBearerHash: string
  sessionId: string
  actionType: ActionType
  items: AnyChangeSetItem[]
  diff: AnyDiffItem[]
  diffVersion: string
  note?: string
  status: ChangeSetStatus
  createdAt: number
  decidedAt?: number
}
