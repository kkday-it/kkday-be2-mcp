-- db/migrations/0001_baseline.sql
-- 現行 11 張表（src/store/db.ts 於 main 8441188 的最終形狀）之 PG 定稿。
-- legacy `user_tokens`（Phase A 已 DROP）不入 baseline。
-- 方言決策見 spec §5：timestamp=BIGINT(ms)、consumed=BOOLEAN、*_json=TEXT。

CREATE TABLE audit_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts            BIGINT NOT NULL,
  user_label    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  client_info   TEXT NOT NULL,
  tool          TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  status        TEXT NOT NULL,
  error_message TEXT,
  trace_id      TEXT NOT NULL,
  duration_ms   INTEGER NOT NULL
);
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE rate_counters (
  counter_key  TEXT PRIMARY KEY,
  count        BIGINT NOT NULL DEFAULT 0,
  window_start BIGINT NOT NULL
);

CREATE TABLE session_read_oids (
  session_id  TEXT NOT NULL,
  oid         TEXT NOT NULL,
  recorded_at BIGINT NOT NULL,
  PRIMARY KEY (session_id, oid)
);

CREATE TABLE change_sets (
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
  created_at           BIGINT NOT NULL,
  decided_at           BIGINT,
  execute_at_utc       BIGINT,
  schedule_wall        TEXT,
  schedule_tz          TEXT,
  executor_identity_id TEXT,
  executor_label       TEXT,
  executor_modify_user TEXT,
  executor_session_id  TEXT,
  schedule_claimed_at  BIGINT
);
CREATE INDEX idx_change_sets_status ON change_sets(status);

CREATE TABLE change_set_results (
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

CREATE TABLE web_sessions (
  session_id   TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);

CREATE TABLE be2_identities (
  identity_id          TEXT PRIMARY KEY,
  user_label           TEXT NOT NULL,
  access_token         TEXT NOT NULL,
  refresh_token        TEXT NOT NULL,
  business_list_json   TEXT NOT NULL,
  access_expires_at    BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  keepalive_claimed_at BIGINT
);

CREATE TABLE credentials (
  cred_hash   TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  expires_at  BIGINT,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX idx_credentials_identity ON credentials(identity_id);

CREATE TABLE oauth_clients (
  client_id          TEXT PRIMARY KEY,
  redirect_uris_json TEXT NOT NULL,
  created_at         BIGINT NOT NULL
);

CREATE TABLE oauth_auth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  identity_id    TEXT NOT NULL,
  exp            BIGINT NOT NULL,
  consumed       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE oauth_refresh (
  refresh_hash     TEXT PRIMARY KEY,
  identity_id      TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  exp              BIGINT NOT NULL,
  consumed         BOOLEAN NOT NULL DEFAULT FALSE,
  access_cred_hash TEXT
);
CREATE INDEX idx_oauth_refresh_identity ON oauth_refresh(identity_id);
CREATE INDEX idx_oauth_refresh_access_cred ON oauth_refresh(access_cred_hash);
