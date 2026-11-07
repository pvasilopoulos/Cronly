-- Add an optional custom logo (stored as a data: URL) to the singleton AppConfig.
ALTER TABLE "AppConfig" ADD COLUMN IF NOT EXISTS "logo" TEXT;
