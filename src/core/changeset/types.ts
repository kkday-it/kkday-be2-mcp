export type ActionType = 'shelf_toggle_product' | 'shelf_toggle_plan' | 'inventory_setting' | 'inventory_platform' | 'shelf_schedule' | 'shelf_toggle_bundle' | 'announcement'
export type ChangeSetStatus = 'pending_approval' | 'approved' | 'executing' | 'done' | 'partial' | 'failed' | 'rejected' | 'expired'

export interface ChangeSetItem {
  prod_oid: string
  pkg_oid?: string
  target_is_active: boolean
}

export interface InventoryItem {
  item_oid: string
  supplier_oid: string
  quantity: number
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

export type AnyChangeSetItem = ChangeSetItem | InventoryItem | InventoryPlatformItem | ShelfScheduleItem | AnnouncementCreateItem

// Task 4 (design doc §4.2): reserve_queue is a full-replace write, so the diff carries the
// current (sanitized/sorted) live queue alongside the target queue verbatim — "noop" means the
// two are deep-equal after sanitizing, not a per-field boolean flip like DiffItem.
export interface ShelfScheduleDiffItem {
  prod_oid: string
  pkg_oid: string
  pkg_name: string
  current_queue: ScheduleEntry[]
  new_queue: ScheduleEntry[]
  noop: boolean
}

export interface DiffItem {
  prod_oid: string
  pkg_oid?: string
  name?: string
  current_is_active?: boolean
  target_is_active: boolean
  no_op: boolean
}

export interface InventoryDiffItem {
  item_oid: string
  supplier_oid: string
  current?: number   // undefined = 未設（null in wire）
  target: number
  no_op: boolean
}

export interface InventoryPlatformDiffItem {
  item_oid: string
  supplier_oid: string
  current: InventoryPlatform
  target: InventoryPlatform
  noop: boolean
  affected_pkgs: Array<{ prod_oid: string; pkg_oid: string; pkg_name: string }>
  // Final whole-branch review Important 3: set when the server could NOT re-verify
  // affected_pkgs against the packages endpoint (read failure, or nothing self-reported to
  // verify against) — affected_pkgs then falls back to the caller's self-reported (untrusted)
  // list verbatim. Never set when the recompute succeeded, even if it changed nothing.
  affected_pkgs_unverified?: boolean
}

export interface AnnouncementLangContent { lang: string; content: string }

export interface AnnouncementCreateItem {
  prod_oids: string[]
  name: string
  is_enabled: boolean
  start_time: string          // "YYYY-MM-DD HH:mm:ss" UTC+0
  end_time?: string | null
  langs: string[]
  contents: AnnouncementLangContent[]
}

export interface AnnouncementDiffItem {
  prod_oids: string[]
  product_names: string[]
  name: string
  is_enabled: boolean
  start_time: string
  end_time?: string | null
  langs: string[]
  contents: AnnouncementLangContent[]  // 帶進 diff 供確認頁預覽內文（防 blind write）
  existing_count: number | null        // 這些商品上既有公告數（context，非 blocker）；null = 讀不到/未知
  noop: false
}

export type AnyDiffItem = DiffItem | InventoryDiffItem | InventoryPlatformDiffItem | ShelfScheduleDiffItem | AnnouncementDiffItem

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
