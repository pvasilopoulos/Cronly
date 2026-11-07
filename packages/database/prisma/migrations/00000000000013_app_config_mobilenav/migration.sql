-- Configurable mobile/tablet footer nav (ordered list of nav hrefs).
ALTER TABLE "AppConfig" ADD COLUMN IF NOT EXISTS "mobileNav" TEXT[] NOT NULL DEFAULT '{}';
