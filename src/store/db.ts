import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MIGRATIONS = `
-- Task 5 (Phase A 收尾): user_tokens 是 Phase 1a 的扁平 token 表，已被
-- be2_identities + credentials（見下）取代；TokenStore 相容 adapter 已刪除，這裡
-- 硬砍舊表（fresh :memory: db 本來就沒有這張表，這行只對既有 on-disk db 生效）。
DROP TABLE IF EXISTS user_tokens;
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
  identity_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS be2_identities (
  identity_id        TEXT PRIMARY KEY,
  user_label         TEXT NOT NULL,
  access_token       TEXT NOT NULL,
  refresh_token      TEXT NOT NULL,
  business_list_json TEXT NOT NULL,
  access_expires_at  INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  cred_hash    TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  expires_at   INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_identity ON credentials(identity_id);
-- Task 6（Phase B：OAuth 外殼）：DCR 註冊的 client、authorization_code flow 的授權碼、
-- refresh token rotation 用的 refresh 記錄。code/refresh 一律只存 sha256 hash（見
-- OAuthStore），明文永不落地。consumed 標記而非硬刪，供 Task 10 refresh-reuse 偵測
-- （重用已消費過的 refresh → family revoke）。
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id          TEXT PRIMARY KEY,
  redirect_uris_json TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  identity_id    TEXT NOT NULL,
  exp            INTEGER NOT NULL,
  consumed       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_refresh (
  refresh_hash TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  exp          INTEGER NOT NULL,
  consumed     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_identity ON oauth_refresh(identity_id);
`

export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(MIGRATIONS)
  return db
}
