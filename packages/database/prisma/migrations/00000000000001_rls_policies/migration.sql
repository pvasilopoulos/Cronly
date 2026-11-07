-- Row-Level Security for CronApp.
--
-- The application connects as a NON-superuser role (see below) that does NOT
-- have the BYPASSRLS attribute. Before each request the API opens a transaction
-- and runs:  SELECT set_config('app.current_tenant', '<tenantId>', true);
-- so every query is transparently fenced to that tenant. A forgotten WHERE
-- clause can no longer leak another tenant's data.
--
-- Platform staff (super-admins) use a server-only escape hatch:
--   SELECT set_config('app.bypass_rls', 'on', true);
-- which the API sets ONLY for verified super-admin principals, never from
-- user-controlled input.
--
-- Apply after `prisma migrate deploy`:
--   psql "$DATABASE_URL" -f prisma/rls.sql

-- 1) Application role (run once, as a superuser / the DB owner):
--    CREATE ROLE cronapp LOGIN PASSWORD 'cronapp' NOSUPERUSER NOBYPASSRLS;
--    GRANT ALL ON ALL TABLES IN SCHEMA public TO cronapp;
--    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO cronapp;

-- 2) Helper: current tenant from the session (null when unset).
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('app.current_tenant', true) $$;

CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.bypass_rls', true), 'off') = 'on' $$;

-- 3) Enable RLS + a tenant policy on every table that carries "tenantId".
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Tenant','Membership','Role','Job','JobRun','AuditLog']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
  END LOOP;
END $$;

-- The Tenant table keys on its own id; the rest key on "tenantId".
CREATE POLICY tenant_isolation ON "Tenant"
  USING (app_bypass_rls() OR id = app_current_tenant())
  WITH CHECK (app_bypass_rls() OR id = app_current_tenant());

CREATE POLICY tenant_isolation ON "Membership"
  USING (app_bypass_rls() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_bypass_rls() OR "tenantId" = app_current_tenant());

CREATE POLICY tenant_isolation ON "Role"
  USING (app_bypass_rls() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_bypass_rls() OR "tenantId" = app_current_tenant());

CREATE POLICY tenant_isolation ON "Job"
  USING (app_bypass_rls() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_bypass_rls() OR "tenantId" = app_current_tenant());

CREATE POLICY tenant_isolation ON "JobRun"
  USING (app_bypass_rls() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_bypass_rls() OR "tenantId" = app_current_tenant());

CREATE POLICY tenant_isolation ON "AuditLog"
  USING (app_bypass_rls() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_bypass_rls() OR "tenantId" = app_current_tenant());

-- Child tables (RolePermission, MembershipRole, PermissionOverride) carry no
-- tenantId and are only ever reached through their RLS-protected parent row,
-- so they inherit isolation in practice. Add tenantId + policies here later if
-- you want belt-and-suspenders defense in depth.
