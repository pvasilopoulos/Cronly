-- Web Push subscriptions (per user+device, NOT tenant-scoped, no RLS — scoped by
-- userId in the app) and per-workspace message-text templates (tenant-scoped,
-- RLS). Created as the cronapp role so it owns the tables.

CREATE TABLE IF NOT EXISTS "PushSubscription" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "endpoint"   TEXT NOT NULL,
  "p256dh"     TEXT NOT NULL,
  "auth"       TEXT NOT NULL,
  "ua"         TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription" ("endpoint");
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription" ("userId");

CREATE TABLE IF NOT EXISTS "MessageTemplate" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "event"     TEXT NOT NULL,
  "channel"   TEXT NOT NULL,
  "subject"   TEXT,
  "body"      TEXT NOT NULL,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MessageTemplate_tenantId_event_channel_key"
  ON "MessageTemplate" ("tenantId", "event", "channel");
CREATE INDEX IF NOT EXISTS "MessageTemplate_tenantId_idx" ON "MessageTemplate" ("tenantId");

-- Tenant-isolation RLS for MessageTemplate only (PushSubscription is user-scoped).
ALTER TABLE "MessageTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MessageTemplate";
CREATE POLICY tenant_isolation ON "MessageTemplate"
  USING (app_bypass_rls() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_bypass_rls() OR "tenantId" = app_current_tenant());
