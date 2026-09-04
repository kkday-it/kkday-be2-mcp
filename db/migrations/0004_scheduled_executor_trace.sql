-- F4：scheduled change-set 的「批准 trace」需貫穿到「執行 trace」，批准事件↔執行事件↔be2 端
-- request-uuid 三方才能 join（spec §3.5）。原本 setScheduled 的 executor 快照只存 identity/label/
-- modify_user/session，沒存 traceId → scheduler 重建 who 時無 trace → executor fallback 產新 trace，
-- 鏈斷。這裡補一欄存下批准當下的 traceId。
-- nullable：migration 前既存的 scheduled 件無此值，scheduler 讀到 null 時維持現行 randomTraceId() fallback。
ALTER TABLE change_sets ADD COLUMN executor_trace_id TEXT;
