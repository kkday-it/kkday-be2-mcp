export type ActionType = 'shelf_toggle_product' | 'shelf_toggle_plan'
export type ChangeSetStatus = 'pending_approval' | 'approved' | 'executing' | 'done' | 'partial' | 'failed' | 'rejected' | 'expired'

export interface ChangeSetItem {
  prod_oid: string
  pkg_oid?: string
  target_is_active: boolean
}

export interface DiffItem {
  prod_oid: string
  pkg_oid?: string
  name?: string
  current_is_active?: boolean
  target_is_active: boolean
  no_op: boolean
}

export interface ItemResult {
  item_key: string
  status: 'done' | 'skipped_noop' | 'failed' | 'stale'
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
  items: ChangeSetItem[]
  diff: DiffItem[]
  diffVersion: string
  note?: string
  status: ChangeSetStatus
  createdAt: number
  decidedAt?: number
}
