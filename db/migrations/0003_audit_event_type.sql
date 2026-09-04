-- G6：audit_log 事件分類。舊列 NULL = tool_call / INFO（讀取端 fallback，不 backfill）。
ALTER TABLE audit_log ADD COLUMN event_type TEXT;
ALTER TABLE audit_log ADD COLUMN severity TEXT;
