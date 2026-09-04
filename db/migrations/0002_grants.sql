-- db/migrations/0002_grants.sql
-- Role model（spec §8.2）：be2mcp_owner 跑 migration（schema owner）、be2mcp_app 只 CRUD。
-- audit_log 對 app role 只給 INSERT/SELECT（append-only 第二道保險，第一道是 trigger）。
-- 測試（PGlite）與本地單帳號環境沒有 be2mcp_app role → DO 區塊判斷後跳過，migration 仍可重跑。
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'be2mcp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO be2mcp_app;
    REVOKE UPDATE, DELETE ON audit_log FROM be2mcp_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO be2mcp_app;
  END IF;
END $$;
