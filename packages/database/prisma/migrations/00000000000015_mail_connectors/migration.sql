-- SmtpConfig: provider selector + Microsoft 365 (Graph) and Gmail (service
-- account) connector fields. Secrets are stored AES-256-GCM encrypted.
ALTER TABLE "SmtpConfig"
  ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'smtp',
  ADD COLUMN IF NOT EXISTS "msTenantId" TEXT,
  ADD COLUMN IF NOT EXISTS "msClientId" TEXT,
  ADD COLUMN IF NOT EXISTS "msClientSecretCiphertext" BYTEA,
  ADD COLUMN IF NOT EXISTS "msClientSecretIv" BYTEA,
  ADD COLUMN IF NOT EXISTS "msClientSecretAuthTag" BYTEA,
  ADD COLUMN IF NOT EXISTS "gmailClientEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "gmailKeyCiphertext" BYTEA,
  ADD COLUMN IF NOT EXISTS "gmailKeyIv" BYTEA,
  ADD COLUMN IF NOT EXISTS "gmailKeyAuthTag" BYTEA;
