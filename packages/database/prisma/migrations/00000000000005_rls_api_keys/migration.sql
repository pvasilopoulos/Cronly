-- RLS for the ApiKey table and backfill of the new permission keys onto existing
-- system roles. API keys are admin-level, so only owner/admin receive them (not
-- operator, analyst or viewer).

-- 1) Enable + force RLS and a tenant-isolation policy on ApiKey.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ApiKey']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_bypass_rls() OR "tenantId" = app_current_tenant()) WITH CHECK (app_bypass_rls() OR "tenantId" = app_current_tenant())',
      t
    );
  END LOOP;
END $$;

-- 2) Backfill the new permission keys onto existing system roles (owner, admin).
SET app.bypass_rls = 'on';

INSERT INTO "RolePermission" (id, "roleId", permission)
SELECT gen_random_uuid()::text, r.id, p.perm
FROM "Role" r
CROSS JOIN (VALUES
  ('apikeys:read'), ('apikeys:manage')
) AS p(perm)
WHERE r."isSystem" = true
  AND r.key IN ('owner', 'admin')
ON CONFLICT ("roleId", permission) DO NOTHING;

SET app.bypass_rls = 'off';
