import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS user_tokens (
  bearer_hash        TEXT PRIMARY KEY,
  user_label         TEXT NOT NULL,
  access_token       TEXT NOT NULL,
  refresh_token      TEXT NOT NULL,
  business_list_json TEXT NOT NULL,
  access_expires_at  INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  user_label   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  client_info  TEXT NOT NULL,
  tool         TEXT NOT NULL,
  params_json  TEXT NOT NULL,
  status       TEXT NOT NULL,
  error_message TEXT,
  trace_id     TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TABLE IF NOT EXISTS rate_counters (
  counter_key  TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_read_oids (
  session_id  TEXT NOT NULL,
  oid         TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, oid)
);
CREATE TABLE IF NOT EXISTS change_sets (
  id                   TEXT PRIMARY KEY,
  creator_label        TEXT NOT NULL,
  creator_bearer_hash  TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  action_type          TEXT NOT NULL,
  items_json           TEXT NOT NULL,
  diff_json            TEXT NOT NULL,
  diff_version         TEXT NOT NULL,
  note                 TEXT,
  status               TEXT NOT NULL,
  approval_token_hash  TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  decided_at           INTEGER
);
CREATE TABLE IF NOT EXISTS change_set_results (
  changeset_id  TEXT NOT NULL,
  item_key      TEXT NOT NULL,
  status        TEXT NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  error_code    TEXT,
  error_message TEXT,
  trace_id      TEXT NOT NULL,
  PRIMARY KEY (changeset_id, item_key)
);
CREATE TABLE IF NOT EXISTS web_sessions (
  session_id   TEXT PRIMARY KEY,
  user_label   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
`

export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(MIGRATIONS)
  return db
}
