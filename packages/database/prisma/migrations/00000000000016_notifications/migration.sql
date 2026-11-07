-- Live notifications: per-user in-app feed + per-user policy. Both tenant-scoped
-- (RLS). Created as the cronapp role so it owns the tables (FORCE RLS applies to
-- the owner too, matching the app's other tenant tables).

CREATE TABLE IF NOT EXISTS "Notification" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "type"      TEXT NOT NULL,
  "severity"  TEXT NOT NULL DEFAULT 'WARNING',
  "title"     TEXT NOT NULL,
  "body"      TEXT,
  "jobId"     TEXT,
  "runId"     TEXT,
  "readAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Notification_tenantId_userId_createdAt_idx"
  ON "Notification" ("tenantId", "userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "Notification_tenantId_userId_readAt_idx"
  ON "Notification" ("tenantId", "userId", "readAt");

CREATE TABLE IF NOT EXISTS "NotificationPref" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "events"     TEXT[] NOT NULL DEFAULT ARRAY['job.failed','job.timeout','job.dead_letter','heartbeat.missed']::TEXT[],
  "browser"    BOOLEAN NOT NULL DEFAULT true,
  "quietStart" TEXT,
  "quietEnd"   TEXT,
  "quietTz"    TEXT DEFAULT 'Europe/Athens',
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPref_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationPref_tenantId_userId_key"
  ON "NotificationPref" ("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "NotificationPref_tenantId_idx"
  ON "NotificationPref" ("tenantId");

-- Tenant-isolation RLS, matching the app's other tenant tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Notification','NotificationPref']
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
