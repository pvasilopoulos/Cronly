// Centralised, typed access to environment configuration.
export const env = {
  port: parseInt(process.env.API_PORT ?? '3001', 10),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  // Public base URL of the API (no trailing slash, no /api) used to build the
  // inbound heartbeat ping URL the user curls from their own cron.
  publicUrl: (process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.API_PORT ?? '3001'}`).replace(/\/$/, ''),
  // Web console base URL — used to build the password-reset link in emails.
  appUrl: (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  // In non-production we surface one-time reset tokens in API responses/logs so
  // the flow is testable without a configured mailer. Never true in production.
  devExposeTokens: (process.env.NODE_ENV ?? 'development') !== 'production',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret',
    accessTtl: parseInt(process.env.JWT_ACCESS_TTL ?? '900', 10),
    refreshTtl: parseInt(process.env.JWT_REFRESH_TTL ?? '2592000', 10),
    // Interim MFA token lifetime (seconds): after password step, before TOTP.
    mfaTtl: parseInt(process.env.JWT_MFA_TTL ?? '300', 10),
  },
  // Password-reset token lifetime (seconds). Default 30 minutes.
  resetTtlSec: parseInt(process.env.PASSWORD_RESET_TTL ?? '1800', 10),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
};
