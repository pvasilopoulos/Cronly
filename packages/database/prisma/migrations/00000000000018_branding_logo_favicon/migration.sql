-- Branding: configurable brand-mark size and a custom browser-tab favicon.
-- AppConfig is owned by the postgres role, so this must be applied as -U postgres.
ALTER TABLE "AppConfig" ADD COLUMN IF NOT EXISTS "logoScale" INTEGER NOT NULL DEFAULT 32;
ALTER TABLE "AppConfig" ADD COLUMN IF NOT EXISTS "favicon" TEXT;
