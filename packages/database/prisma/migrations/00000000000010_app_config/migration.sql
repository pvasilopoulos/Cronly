-- Platform-wide branding config (single row, no tenantId → not RLS-scoped).
CREATE TABLE IF NOT EXISTS "AppConfig" (
    "id" TEXT NOT NULL DEFAULT 'app',
    "name" TEXT NOT NULL DEFAULT 'CronApp',
    "icon" TEXT NOT NULL DEFAULT '◷',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("id")
);

-- The application connects as the least-privilege "cronapp" role; make sure it
-- can read and write this table (no-op when cronapp already owns it, e.g. CI).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cronapp') THEN
    EXECUTE 'GRANT ALL ON TABLE "AppConfig" TO cronapp';
  END IF;
END $$;

-- Seed the single row so the first read always finds branding defaults.
INSERT INTO "AppConfig" ("id", "name", "icon", "updatedAt")
VALUES ('app', 'CronApp', '◷', now())
ON CONFLICT ("id") DO NOTHING;
