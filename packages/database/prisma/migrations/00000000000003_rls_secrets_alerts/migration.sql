-- RLS for the new tenant-scoped tables (Secret, NotificationChannel, AlertRule)
-- and backfill of the new permission keys onto existing system roles.

-- 1) Enable + force RLS and a tenant-isolation policy on each new table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Secret','NotificationChannel','AlertRule']
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

-- 2) Backfill new permission keys onto existing system roles so current tenants
--    gain access without a reseed. Requires reading the RLS-protected Role table.
SET app.bypass_rls = 'on';

INSERT INTO "RolePermission" (id, "roleId", permission)
SELECT gen_random_uuid()::text, r.id, p.perm
FROM "Role" r
CROSS JOIN (VALUES
  ('secrets:read'), ('secrets:manage'),
  ('alerts:read'),  ('alerts:manage')
) AS p(perm)
WHERE r."isSystem" = true
  AND (
    r.key IN ('owner', 'operator')
    OR (r.key = 'admin' AND p.perm NOT LIKE 'billing:%')
  )
ON CONFLICT ("roleId", permission) DO NOTHING;

SET app.bypass_rls = 'off';
