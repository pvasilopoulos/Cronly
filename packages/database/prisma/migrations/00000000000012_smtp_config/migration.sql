-- Instance-wide SMTP settings (singleton). Password stored AES-256-GCM encrypted.
CREATE TABLE IF NOT EXISTS "SmtpConfig" (
  "id"                 TEXT NOT NULL DEFAULT 'smtp',
  "enabled"            BOOLEAN NOT NULL DEFAULT false,
  "host"               TEXT,
  "port"               INTEGER NOT NULL DEFAULT 587,
  "secure"             BOOLEAN NOT NULL DEFAULT false,
  "username"           TEXT,
  "fromAddr"           TEXT,
  "passwordCiphertext" BYTEA,
  "passwordIv"         BYTEA,
  "passwordAuthTag"    BYTEA,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmtpConfig_pkey" PRIMARY KEY ("id")
);

-- The app connects as the least-privilege `cronapp` role; grant it access.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cronapp') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SmtpConfig" TO cronapp;
  END IF;
END $$;
